'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const auth = require('./auth');
const crm = require('./crm');
const agentconfig = require('./agentconfig');
const teams = require('./teams');
const H = require('./http');

const { Tabla } = crm;

const RUTA_CONFIG = path.join(config.dataDir, 'ai-config.json');
const COOKIE_AI = 'opia_aiguid';
const VIDA_SESION_DIAS = 90;
// tope de mensajes conservados por conversación (contexto del modelo + pantalla)
const MAX_MSG_SESION = 200;
const MAX_MENSAJES_DIA = 500;
const MAX_ITER_HERRAMIENTAS = 4;
// magic link: un solo uso, 15 minutos, igual filosofía que el acceso al CRM
const TOKEN_MINUTOS = 15;
// tras abrir el magic link el navegador queda autenticado este tiempo con un
// token firmado en cookie (nunca en el URL); pasado ese toca pedir enlace de
// nuevo: un enlace filtrado deja de servir solo
const ACCESO_HORAS = 12;
const ACCESO_SEGUNDOS = ACCESO_HORAS * 3600;
const NOMBRE_SIN_REGISTRAR = 'AI user';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Las dos tablas del agente viven junto a las del CRM (dataDir/crm, volumen).
// aiagentmessages: cada mensaje del chat (rol usuario/ia/herramienta), con
// contactoId como llave foránea: un contacto tiene muchos mensajes (1:N).
// aiagentsessions: una fila por conversación (guid = id), ligada a su contacto.
const mensajes = new Tabla('aiagentmessages.json');
const sesiones = new Tabla('aiagentsessions.json');

/* --------------------------------------------------- autenticación por correo */

const tokens = new Map(); // jti -> { correo, exp }; el enlace es de un solo uso

/**
 * Envía el magic link. El token va firmado (HMAC del secret.key) y de un solo
 * uso: al abrir el enlace se borra el jti, así aunque el correo se reenvíe o
 * quede en la papelera ya no sirve. Respuesta genérica siempre: no revela si
 * un correo existe o no en el CRM.
 */
async function solicitarEnlace(correoCrudo) {
  const correo = H.clean(correoCrudo, 160).trim().toLowerCase();
  if (!EMAIL_RE.test(correo)) return { ok: false, status: 422, error: 'Ese correo no parece válido.' };
  const jti = crypto.randomBytes(16).toString('hex');
  const exp = Date.now() + TOKEN_MINUTOS * 60_000;
  tokens.set(jti, { correo, exp });
  const token = auth.sign({ e: correo, exp, jti });
  const base = config.publicUrl || `http://localhost:${config.port}`;
  const enlace = `${base}/chat?token=${encodeURIComponent(token)}`;
  const envio = await crm.enviarCorreo({
    to: correo,
    subject: 'Tu enlace para conversar con OPIA Software',
    text:
      `Hola,\n\nAbre este enlace para entrar a la conversación con nuestro asistente ` +
      `(vence en ${TOKEN_MINUTOS} minutos y solo sirve una vez):\n\n${enlace}\n\n` +
      `Si no lo pediste, ignora este mensaje.\n— OPIA Software`,
  });
  if (!envio.ok) {
    tokens.delete(jti);
    console.error('[aiagent] no se pudo enviar el magic link:', envio.error);
    return { ok: false, status: 502, error: 'No pudimos enviar el correo. Intenta de nuevo en unos minutos.' };
  }
  // aviso al dueño de que alguien está entrando al chat: con los datos del
  // contacto si el correo ya está en el CRM. No bloquea: si el aviso falla,
  // el visitante igual recibió su enlace.
  const conocido = buscarContactoPorCorreo(correo);
  const empresaConocida = conocido ? crm.clientes.porId(conocido.clienteId) : null;
  crm
    .notificarEquipo({
      subject: `Visitante en el chat del agente: ${correo}`,
      text:
        `Alguien acaba de escribir su correo en el chat del asistente virtual.\n\n` +
        `Correo: ${correo}\n` +
        (conocido
          ? `Contacto existente: ${`${conocido.nombres || ''} ${conocido.apellidos || ''}`.trim() || 'sin nombre'}\n` +
            `Empresa: ${empresaConocida ? empresaConocida.nombre : '—'}\nCelular: ${conocido.celular || '—'}\n`
          : 'Contacto nuevo: todavía no está en el CRM.\n') +
        `\nEn cuanto abra el enlace del correo empezará a conversar. ` +
        `Para ver los mensajes en vivo abre su ficha en el panel CRM (${(config.publicUrl || '') + '/crm'}): ` +
        `tarjeta «conversaciones del asistente».\n\n— Agente virtual de OPIA Software`,
    })
    .catch((err) => console.error('[aiagent] aviso de visitante:', err.message));
  const r = { ok: true, correo };
  // comodín de desarrollo para poder probar el flujo sin buzón propio
  if (process.env.NODE_ENV !== 'production') r.token = token;
  return r;
}

function buscarContactoPorCorreo(correo) {
  return crm.contactos.todas().find((k) => {
    for (const campo of ['email', 'email2', 'email3']) {
      if (String(k[campo] || '').toLowerCase() === correo) return true;
    }
    return false;
  });
}

function crearContactoPorCorreo(correo) {
  const emp = empresaComodin();
  const { datos, errores } = crm.validarContacto({ clienteId: emp.id, nombres: NOMBRE_SIN_REGISTRAR, email: correo });
  if (Object.keys(errores).length) {
    throw new Error('contacto por correo: ' + Object.values(errores).join(' '));
  }
  return crm.contactos.agregar({ id: crm.siguienteId('p'), ...datos, archivoOrigen: 'agente_ia' }, 'aiagent');
}

function saludoInicial(contacto) {
  const nombre = `${contacto.nombres || ''} ${contacto.apellidos || ''}`.trim();
  const hola =
    contacto.nombres && contacto.nombres !== NOMBRE_SIN_REGISTRAR && nombre.length > 1
      ? `¡Hola de nuevo, ${nombre}! `
      : '¡Hola! ';
  // el menú sale de la configuración del CRM: el paso 1 del prompt depende de
  // que el saludo ya lo haya mostrado
  const opciones = agentconfig.menuOpciones();
  const menu = opciones.length >= 2 ? `\n[OPCIONES] ${opciones.join(' | ')}` : '';
  const invitacion = menu
    ? 'Elige una opción para empezar o escríbeme tu necesidad.'
    : 'Escríbeme tu necesidad y con gusto te ayudo.';
  return hola + 'Soy el asistente virtual de OPIA Software. ' + invitacion + menu;
}

/**
 * Valida el token del magic link y deja la sesión lista: busca el contacto por
 * correo (caso A) o lo crea como "AI user" (caso B), reutiliza su última
 * conversación para conservar el historial y deja el saludo inicial guardado.
 * Devuelve { guid } o { error, status }.
 */
function verificarEnlace(tokenCrudo) {
  const token = H.clean(tokenCrudo, 2000);
  const payload = token ? auth.unsign(token) : null;
  if (!payload || payload.exp < Date.now()) return { error: 'El enlace venció. Pide uno nuevo en el chat.', status: 410 };
  const guardado = tokens.get(payload.jti);
  if (!guardado || guardado.correo !== payload.e || guardado.exp < Date.now()) {
    return { error: 'Ese enlace ya se usó. Pide uno nuevo en el chat.', status: 410 };
  }
  tokens.delete(payload.jti); // un solo uso, aunque expire después

  let contacto = buscarContactoPorCorreo(guardado.correo);
  if (!contacto) contacto = crearContactoPorCorreo(guardado.correo);

  // la conversación de un contacto es una sola: el historial le pertenece a él
  let s = sesiones
    .todas()
    .filter((x) => x.contactoId === contacto.id)
    .sort((a, b) => String(b.modifiedon || '').localeCompare(String(a.modifiedon || '')))[0];
  if (!s) {
    s = sesiones.agregar(
      {
        id: crypto.randomBytes(9).toString('base64url'),
        estado: 'lead',
        contactoId: contacto.id,
        clienteId: contacto.clienteId,
        menuVersion: 2,
      },
      'aiagent'
    );
    agregarMsg(s, { rol: 'ia', texto: saludoInicial(contacto) }, 'aiagent');
  }
  return { guid: s.id, correo: guardado.correo };
}

/* -------------------------------------------------- autenticación por WhatsApp */

// El wa_id de Meta llega solo con dígitos e indicativo de país (573176994961):
// ese número es la identidad y la llave para encontrar o crear el contacto.
function soloDigitos(valor) {
  return String(valor || '').replace(/\D/g, '');
}

function telefonoE164(numero) {
  const d = soloDigitos(numero);
  return d ? '+' + d : '';
}

function buscarContactoPorTelefono(numero) {
  const d = soloDigitos(numero);
  if (d.length < 7) return null;
  return (
    crm.contactos.todas().find((k) => {
      const t = soloDigitos(k.celular);
      if (t.length < 7) return false;
      if (t === d) return true;
      // un celular guardado sin indicativo (10 dígitos) coincide con el wa_id
      const cola = (x) => (x.length >= 10 ? x.slice(-10) : x);
      return cola(t) === cola(d);
    }) || null
  );
}

/**
 * Resuelve la conversación de un número de WhatsApp: busca el contacto por
 * celular o lo crea, reutiliza su última conversación (también si empezó por
 * la web) y devuelve el saludo cuando la sesión es nueva.
 */
function sesionWhatsApp(numero) {
  const d = soloDigitos(numero);
  if (d.length < 7 || d.length > 15) return null;

  let contacto = buscarContactoPorTelefono(d);
  if (!contacto) {
    const emp = empresaComodin();
    const { datos, errores } = crm.validarContacto({
      clienteId: emp.id,
      nombres: NOMBRE_SIN_REGISTRAR,
      celular: telefonoE164(d),
    });
    if (Object.keys(errores).length) {
      throw new Error('contacto por WhatsApp: ' + Object.values(errores).join(' '));
    }
    contacto = crm.contactos.agregar(
      { id: crm.siguienteId('p'), ...datos, archivoOrigen: 'agente_ia' },
      'aiagent'
    );
  }
  // un contacto que venía del correo sin celular adopta este número
  if (!soloDigitos(contacto.celular)) {
    crm.contactos.actualizar(contacto.id, { celular: telefonoE164(d) }, 'aiagent');
  }

  let s = sesiones
    .todas()
    .filter((x) => x.contactoId === contacto.id)
    .sort((a, b) => String(b.modifiedon || '').localeCompare(String(a.modifiedon || '')))[0];
  if (!s) {
    s = sesiones.agregar(
      {
        id: crypto.randomBytes(9).toString('base64url'),
        estado: 'lead',
        contactoId: contacto.id,
        clienteId: contacto.clienteId,
        canal: 'whatsapp',
        whatsapp: true,
        telefono: telefonoE164(d),
        menuVersion: 2,
      },
      'aiagent'
    );
    const saludo = saludoInicial(contacto);
    agregarMsg(s, { rol: 'ia', texto: saludo }, 'aiagent');
    return { sesion: s, saludo, contacto, primeraVezWhatsApp: true };
  }
  // una sesión vieja (por ejemplo, del chat web) no trae la marca: su primer
  // mensaje por WhatsApp se avisa al equipo una sola vez
  let primeraVezWhatsApp = false;
  if (!s.whatsapp) {
    primeraVezWhatsApp = true;
    sesiones.actualizar(s.id, { whatsapp: true }, 'aiagent');
    s.whatsapp = true;
  }
  return { sesion: s, saludo: null, contacto, primeraVezWhatsApp };
}

/** WhatsApp usa *negrita* de un asterisco. Las opciones de la última línea
 *  viajan aparte: el canal las muestra como botones o lista nativa. */
function adaptarAWhatsApp(textoCrudo) {
  const lineas = String(textoCrudo || '').split('\n');
  let opciones = null;
  const m = /^\[OPCIONES\]\s*:?\s*(.+)$/i.exec((lineas[lineas.length - 1] || '').trim());
  if (m) {
    const etiquetas = m[1].split('|').map((t) => t.replace(/\*/g, '').trim()).filter(Boolean);
    if (etiquetas.length >= 2) {
      lineas.pop();
      while (lineas.length && !lineas[lineas.length - 1].trim()) lineas.pop();
      opciones = etiquetas.slice(0, 10);
    }
  }
  const texto = lineas.join('\n').trim().replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
  return { texto, opciones };
}

/* ------------------------------------------------------------------- sesiones */

function obtenerSesion(guid) {
  return sesiones.porId(guid) || null;
}

/**
 * Token de acceso de la cookie: firmado (HMAC) y con vencimiento. El guid crudo
 * ya no circula por URLs ni correos; quien tenga una cookie o un enlace viejo
 * no entra: solo el magic link de un solo uso crea este token.
 */
function crearAcceso(guid) {
  return auth.sign({ t: 'aiacc', g: guid, exp: Date.now() + ACCESO_SEGUNDOS * 1000 });
}

/** Resuelve la sesión a partir del valor de la cookie de acceso (o null). */
function sesionDeAcceso(valorCookie) {
  const payload = auth.unsign(valorCookie);
  if (!payload || payload.t !== 'aiacc' || typeof payload.g !== 'string') return null;
  return obtenerSesion(payload.g);
}

function guardarSesion(s, actor) {
  return sesiones.actualizar(s.id, s, actor);
}

/** Limpia conversaciones inactivas (y sus mensajes); va con la retención. */
function podarSesiones() {
  const limite = Date.now() - VIDA_SESION_DIAS * 86_400_000;
  let cambios = 0;
  for (const s of sesiones.todas()) {
    const t = Date.parse(s.modifiedon || s.createdon || 0);
    if (!Number.isFinite(t) || t < limite) {
      for (const m of mensajes.todas().filter((m) => m.guid === s.id)) mensajes.eliminar(m.id);
      // conversaciones viejas del flujo anónimo (estado !== lead) arrastraban un
      // contacto placeholder que no existía en el CRM: se va con la sesión
      if (s.estado !== 'lead' && s.contactoId) crm.contactos.eliminar(s.contactoId);
      sesiones.eliminar(s.id);
      cambios += 1;
    }
  }
  return cambios;
}

/**
 * Borra todo el rastro del agente de un contacto: sus conversaciones, los
 * mensajes y los levantamientos. La llama el CRM al eliminar el contacto.
 */
function eliminarPorContacto(contactoId) {
  const suyas = sesiones.todas().filter((s) => s.contactoId === contactoId);
  const guids = new Set(suyas.map((s) => s.id));
  const mensajesRestantes = mensajes.todas().filter((m) => !guids.has(m.guid));
  const mensajesBorrados = mensajes.todas().length - mensajesRestantes.length;
  mensajes.guardar(mensajesRestantes);
  const levRestantes = crm.levantamientos.todas().filter((l) => l.contactoId !== contactoId);
  const levantamientosBorrados = crm.levantamientos.todas().length - levRestantes.length;
  crm.levantamientos.guardar(levRestantes);
  const sesionesRestantes = sesiones.todas().filter((s) => s.contactoId !== contactoId);
  sesiones.guardar(sesionesRestantes);
  return { conversacionesBorradas: suyas.length, mensajesBorrados, levantamientosBorrados };
}

/** Conversaciones del asistente con un contacto, para la ficha del CRM:
 *  la más reciente primero, con los turnos visibles de cada una. */
function conversacionesDeContacto(contactoId) {
  return sesiones
    .todas()
    .filter((s) => s.contactoId === contactoId)
    .sort((a, b) => String(b.modifiedon || b.createdon || '').localeCompare(String(a.modifiedon || a.createdon || '')))
    .map((s) => ({
      guid: s.id,
      createdon: s.createdon,
      modifiedon: s.modifiedon,
      mensajes: historialVisible(s),
    }));
}

/* ------------------------------------------------------------- configuración */

// Proveedor y clave viven SOLO en este archivo (ignorado por git): ni el código
// ni la página revelan qué modelo hay detrás.
function leerConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(RUTA_CONFIG, 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch {
    // sin archivo: el endpoint avisa que falta, no falla
  }
  return {};
}

function configurado() {
  const c = leerConfig();
  return Boolean(c.baseUrl && c.apiKey && c.model);
}

/* ------------------------------------------------------------------- sesiones */

function siguienteMsgId() {
  const rutaMeta = path.join(config.dataDir, 'crm', 'meta.json');
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(rutaMeta, 'utf8'));
  } catch {
    // primer arranque
  }
  meta.seqAiMsg = (meta.seqAiMsg || 0) + 1;
  fs.writeFileSync(rutaMeta, JSON.stringify(meta, null, 2), 'utf8');
  return 'm' + String(meta.seqAiMsg).padStart(7, '0');
}

function agregarMsg(s, fila, actor) {
  mensajes.agregar({ id: siguienteMsgId(), guid: s.id, contactoId: s.contactoId, ...fila }, actor);
  // recorte por la cola: la cabeza del contexto queda en un mensaje limpio
  const suyos = mensajes.todas().filter((m) => m.guid === s.id);
  if (suyos.length > MAX_MSG_SESION) {
    for (const viejo of suyos.slice(0, suyos.length - MAX_MSG_SESION)) mensajes.eliminar(viejo.id);
  }
}

/** Historial en formato de API del modelo: reconstruye turnos y llamadas a herramientas. */
function historialApi(s) {
  return mensajes
    .todas()
    .filter((m) => m.guid === s.id)
    .map((m) => {
      if (m.rol === 'herramienta') return { role: 'tool', tool_call_id: m.toolCallId, content: m.texto };
      if (m.rol === 'ia' && m.toolCalls) {
        return { role: 'assistant', content: m.texto || '', tool_calls: m.toolCalls };
      }
      return { role: m.rol === 'usuario' ? 'user' : 'assistant', content: m.texto };
    });
}

/** Historial legible para el navegador: solo turnos visibles. */
function historialVisible(s) {
  return mensajes
    .todas()
    .filter((m) => m.guid === s.id && (m.rol === 'usuario' || (m.rol === 'ia' && m.texto)))
    .map((m) => ({ rol: m.rol, texto: m.texto }));
}

/* ------------------------------------------------------------------ modelo */

const SYSTEM_PROMPT = [
  'Eres el asistente comercial virtual de OPIA Software, una empresa colombiana de software y marketing digital. Hablas siempre en español con calidez y mensajes cortos.',
  'IDENTIDAD: representas únicamente a OPIA Software. La empresa que aparezca en el CRM, en el historial o en mensajes anteriores es la empresa de la persona (el cliente), nunca la tuya: no la presentes como tu identidad ni escribas su nombre en tus preguntas o respuestas; si necesitas referirte a ella, di «su empresa». Solo confirma su nombre si la persona te lo pide.',
  '',
  'La persona ya se identificó y su contacto existe en el CRM. La conversación se organiza con un menú de funciones: la persona elige una y tú la ejecutas sin adelantar preguntas ni pedir datos que no correspondan.',
  '',
  'PASO 1 · MENÚ. El saludo inicial ya mostró el menú con botones y el sistema te dice cuáles funciones están activas y en qué orden. No repitas el menú en tu primera respuesta ni vuelvas a saludar. Si el mensaje de la persona coincide con la etiqueta de una función, ejecútala de inmediato (PASO 2A a 2E). Si escribe algo distinto, atiende su necesidad con naturalidad o pregúntale qué desea hacer; nunca escribas tú la lista de etiquetas. Si pide una función apagada, dile que por ahora no está disponible y muéstrale el menú escribiendo [MENU].',
  '',
  'PASO 2A · CONOCER MÁS SOBRE OPIA. Responde en máximo 4 frases con esta información: OPIA Software es una empresa colombiana de software y marketing digital; desarrolla software a la medida, automatizaciones con IA y soluciones con Power Platform, y acompaña el crecimiento de las empresas con marketing digital. Conecta procesos, datos y oportunidades de negocio. No inventes clientes, precios, casos ni datos. Si la persona quiere profundizar, ofrécele una reunión por Teams o invítala a elegir otra opción. Pasa al PASO 4.',
  '',
  'PASO 2B · LEVANTAMIENTO DE SOFTWARE. Antes de la primera pregunta dile en una frase corta que estas 3 preguntas le dan una dirección inicial al proyecto y que después hará falta una reunión con el equipo para pulir los alcances. Haz EXACTAMENTE estas 3 preguntas, una sola por mensaje y en este orden: 1) ¿cómo manejan hoy eso que necesitan? (situación); 2) ¿qué les está fallando o costando hoy? (problema); 3) ¿qué resultado esperan y cómo sabrían que funcionó? (objetivo). No agregues más preguntas de levantamiento. Al terminar, llama guardar_levantamiento con tipo «software» y los campos situacion, problema y objetivo, y pasa al PASO 3.',
  '',
  'PASO 2C · LEVANTAMIENTO DE MARKETING. Antes de la primera pregunta dile en una frase corta que estas 3 preguntas le dan una dirección inicial a la estrategia y que después hará falta una reunión con el equipo para pulir los alcances. Haz EXACTAMENTE estas 3 preguntas, una sola por mensaje y en este orden: 1) ¿qué venden y cuál es su producto o servicio estrella?; 2) ¿a qué público quieren llegar y qué los diferencia de la competencia?; 3) ¿qué resultado esperan y para cuándo quieren empezar? No agregues más preguntas de levantamiento. Al terminar, llama guardar_levantamiento con tipo «marketing» y los campos situacion (qué venden y su producto estrella), publico (a qué público quieren llegar y su diferencial), objetivo (resultado esperado) y plazo (para cuándo quieren empezar); pasa al PASO 3.',
  '',
  'PASO 2D · REGISTRAR MIS DATOS. Pide un dato por mensaje, en este orden: 1) nombre completo (guárdalo con registrar_lead), 2) empresa y cantidad aproximada de empleados (vincular_empresa con nombre y numEmpleadosAprox), 3) el medio de contacto que falte: en WhatsApp pide el correo electrónico (el celular ya se conoce) y guárdalo con registrar_lead; en el chat web el correo ya se conoce, así que pide el celular. No vuelvas a pedir un dato que ya tengas. Si la persona no quiere dar alguno, no insistas: guarda lo que dio y sigue. Al terminar confirma en una frase qué quedó guardado y pasa al PASO 4.',
  '',
  'PASO 2E · HABLAR CON UN HUMANO. Comparte el enlace https://wa.me/573332782483 escrito completo y dile que por ese WhatsApp la atiende una persona del equipo en horario laboral. No hagas más preguntas y pasa al PASO 4.',
  '',
  'PASO 3 · CIERRE DEL LEVANTAMIENTO. Resume en máximo 2 frases lo que entendiste y recuérdale que esas 3 preguntas dan una dirección inicial: para pulir alcances y definir la propuesta hace falta una reunión con el equipo. Ofrécele agendarla ahora con [OPCIONES] Sí, agendar | Ahora no. Si acepta, pide el correo (en WhatsApp) y agenda la reunión de Teams siguiendo las reglas de reuniones; si no quiere, dile que el equipo ya tiene sus respuestas. En ambos casos, al terminar, pasa al PASO 4. Si ya hay una reunión agendada en esta conversación, no la dupliques.',
  '',
  'PASO 4 · VOLVER AL MENÚ. Cada vez que termines una función (información de OPIA, levantamiento, registro de datos o enlace humano), escribe [MENU] en una línea aparte y acompáñalo con una pregunta corta como «¿Qué deseas hacer ahora?». El sistema reemplaza [MENU] por los botones de las funciones activas: nunca escribas tú esas etiquetas ni expliques el comando.',
  '',
  'FORMATO DEL CHAT. Puedes resaltar palabras clave entre dobles asteriscos, como **software**. Además, cuando tu pregunta sea de elección entre pocas opciones claras, ciérrala con una última línea exactamente con este formato: [OPCIONES] etiqueta 1 | etiqueta 2 — en la pantalla de la persona aparecerán botones con esas etiquetas y no tendrá que escribir. Úsala en la pregunta de la duración de la reunión (por ejemplo [OPCIONES] Una hora | Media hora), al ofrecer horarios de reunión (un botón por horario) y en el cierre del PASO 3 (por ejemplo [OPCIONES] Sí, agendar | Ahora no). Entre 2 y 4 etiquetas cortas; no la uses en preguntas abiertas de respuesta libre ni para mostrar el menú: para eso existe [MENU]. Esa línea es un comando de la interfaz: nunca la menciones ni la expliques con la persona.',
  '',
  'Reuniones por Microsoft Teams: para calcular fechas usa el día de hoy que te doy y pásalo a las herramientas en formato YYYY-MM-DD. La duración de la reunión la decide SIEMPRE la persona: pregúntasela antes de consultar horarios (lo habitual es una hora, pero vale media hora o la que ella quiera) y pásala en duracion_minutos tanto a ver_disponibilidad como a agendar_reunion. Las reuniones van entre las 8:00 y las 19:00, hora de Colombia: nunca ofrezcas ni agendes una que empiece antes de las 8 o termine después de las 7 de la tarde. Nunca agendes sin que la persona haya aceptado un horario ofrecido. Después de agendar, dile que recibirá la invitación por correo con el enlace de Teams. Si la persona pide cambiar la hora de su reunión, usa reagendar_reunion con la nueva fecha y hora que acepte (en ISO con su offset, igual que al agendar): el enlace de Teams es el mismo y ella recibe la actualización por correo; nunca uses agendar_reunion para mover una reunión existente, y recuerda que solo puedes mover la reunión de ESTA conversación. Si la persona pide CANCELAR su reunión, no la canceles de inmediato: primero insiste con calidez en REAGENDARLA (ofrécele otros horarios con ver_disponibilidad y dile que moverla es muy fácil), porque una cancelación suele perder el contacto. Solo si, después de ofrecerle reagendar, insiste en cancelar, pídele el motivo de la cancelación y entonces usa cancelar_reunion con ese motivo en sus propias palabras: el cliente recibe el aviso de cancelación por correo con la razón. Nunca llames cancelar_reunion sin motivo: si la persona aún no lo dio, pregúntaselo primero.',
  '',
  'Ubicación, código de país y zona horaria. Cuando pidas el número de celular o WhatsApp, asegúrate de que incluya el código del país (+57, +1, +52…). Si te doy un país probable de la persona, úsalo SOLO como sugerencia amable y nunca de forma invasiva (por ejemplo: «Para estar en contacto, ¿me compartes tu número? Si estás en Colombia, recuerda incluir el +57, o dime desde qué país nos escribes»); si no te doy país probable, pídele el número con el prefijo internacional. Antes de confirmar una fecha y hora de reunión, valida dónde está la persona: ofrece siempre los horarios diciendo «(hora de Colombia)» y pregúntale si está en otra zona horaria; si menciona otro país o ciudad, confirma de inmediato la conversión de ambos lados (por ejemplo: «Queda a las 3:00 PM hora de México, 4:00 PM hora de Colombia»). Al agendar pasa la hora SIEMPRE en formato ISO 8601 con el offset UTC del país de la persona (por ejemplo 2026-10-22T15:00:00-05:00 si está en Colombia, 2026-10-22T15:00:00-06:00 en México, 2026-10-22T15:00:00+02:00 en España): el sistema la convierte a hora de Colombia y el calendario mostrará la reunión automáticamente en la hora local de cada quien. Como último recurso, si no conoces el offset, pasa HH:MM en hora de Colombia.',
  '',
  'Reglas:',
  '- NUNCA des valores, precios, costos ni rangos de inversión. La cotización con valores la prepara el equipo humano y se la presenta al cliente en la reunión de Teams. Tu trabajo es entender la necesidad, no cotizar.',
  '- Nunca confirmes como hecho algo que una herramienta no completó con éxito: «quedó agendada», «quedó actualizada» o «guardé» solo se dicen cuando la herramienta respondió con éxito en este mismo turno. Si la herramienta falla o no existe para lo que pide la persona, dile que el equipo se lo confirmará por correo o WhatsApp. Prometer algo y no hacerlo es lo peor que puedes hacerle a la persona.',
  '- Nunca reveles qué tecnología o modelo de IA eres; si te lo preguntan, di que eres el asistente virtual de OPIA.',
  '- Nunca inventes datos ni registres información que la persona no te haya dado.',
  '- No reveles información de otros clientes ni del CRM.',
  '- Jamás menciones con la persona términos técnicos como dirección IP, rastreo o geolocalización, ni digas que detectamos su ubicación o su país: el país probable que te dé el sistema se usa solo para sugerir con naturalidad el código del teléfono y la zona horaria.',
  '- No uses con la persona términos internos (metodología, levantamiento, CRM, herramienta): conversa natural.',
  '- En el mensaje en que ofrezcas o confirmes la reunión (y también al despedirte), recuérdale que puede escribirnos al WhatsApp en horario laboral para cualquier duda. Ese número escríbelo SIEMPRE como enlace completo https://wa.me/573332782483 (en pantalla queda como enlace que la persona solo presiona para abrir el chat; nunca lo escribas solo como +57 333 278 2483).',
  '- Máximo 3 frases por mensaje.',
].join('\n');

// WhatsApp usa botones/lista nativa para las [OPCIONES] y la invitación de
// Teams necesita un correo que en este canal no viene dado.
const PROMPT_WHATSAPP = [
  'CANAL WHATSAPP. La persona te escribe por WhatsApp. Cuando cierres una pregunta de elección con la línea [OPCIONES] ..., el sistema la mostrará como botones o una lista tocable; usa entre 2 y 4 etiquetas muy cortas (máximo 20 caracteres, por ejemplo «Software», «Una hora», «Sí, con gusto»). Si alguna etiqueta no cabe, el sistema la numera y la persona responde con el número.',
  'Puedes ver las fotos que la persona envíe por WhatsApp: si manda una imagen sin texto, coméntala o úsala para responder su consulta. Las notas de voz llegan como «[Audio transcrito] ...»: respóndelas con naturalidad, sin mencionar que hubo una transcripción.',
  'Su identidad ya está verificada con su número de WhatsApp y ese número ya quedó guardado como su celular en el CRM: no se lo vuelvas a pedir, no se lo confirmes y no le pidas que lo escriba. En el PASO 2D pide su nombre, su empresa y la cantidad de empleados; para la reunión de Teams necesitas su correo electrónico.',
  'No escribas el nombre de la empresa del cliente aunque aparezca en el historial: es su empresa, no la tuya; di «su empresa». Tú eres el asistente de OPIA Software.',
  'Para una reunión de Teams necesita recibir la invitación por correo: antes de agendar, pídele su correo electrónico y guárdalo con registrar_lead (campo email). Si no quiere darlo, no agendes la reunión y dile que el equipo le escribirá por este mismo WhatsApp.',
  'No menciones el enlace wa.me ni el número 573332782483 salvo cuando la persona pida hablar con una persona del equipo: en ese caso comparte https://wa.me/573332782483 y dile que por ahí la atiende el equipo en horario laboral.',
  'Para resaltar usa *un solo asterisco*; no uses dobles asteriscos, tablas, ni enlaces con formato Markdown.',
].join('\n');

const HERRAMIENTAS = [
  {
    type: 'function',
    function: {
      name: 'registrar_lead',
      description:
        'Actualiza los datos de la persona que chatea en su contacto del CRM (nombre, celular, correo). Usar apenas la persona dé su nombre, y de nuevo cuando dé su celular o su correo.',
      parameters: {
        type: 'object',
        properties: {
          nombres: { type: 'string' },
          apellidos: { type: 'string' },
          celular: { type: 'string' },
          email: { type: 'string', description: 'Correo electrónico (en WhatsApp es necesario para enviarle la invitación de Teams)' },
        },
        required: ['nombres'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'vincular_empresa',
      description: 'Busca o crea la empresa que la persona menciona y amarra su contacto a ella. Incluye la cantidad aproximada de empleados si la persona la dio.',
      parameters: {
        type: 'object',
        properties: {
          nombre: { type: 'string' },
          numEmpleadosAprox: { type: 'integer', description: 'Cantidad aproximada de empleados de la empresa' },
        },
        required: ['nombre'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agregar_nota',
      description: 'Guarda en el CRM un resumen breve de algo que la persona mencionó (necesidad, alcance, plazo).',
      parameters: {
        type: 'object',
        properties: { texto: { type: 'string' } },
        required: ['texto'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'guardar_levantamiento',
      description:
        'Guarda el levantamiento estructurado de la conversación en el CRM (uno por conversación; los campos que envíes se fusionan con lo ya guardado, así que puedes llamarla a mitad de camino y de nuevo al final). Llamar cuando haya varias respuestas sólidas y siempre antes de solicitar_cotizacion.',
      parameters: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: ['software', 'marketing'], description: 'Pista del levantamiento' },
          situacion: { type: 'string', description: 'Cómo manejan hoy el proceso o el mercadeo' },
          problema: { type: 'string', description: 'Qué les está fallando o costando' },
          impacto: { type: 'string', description: 'Qué pasa si no lo resuelven' },
          objetivo: { type: 'string', description: 'Resultado esperado y cómo medirían el éxito' },
          usuarios: { type: 'string', description: 'Software: quiénes usarían el sistema y cuántos' },
          procesos: { type: 'string', description: 'Software: proceso de negocio a apoyar, paso a paso' },
          funcionalidades: { type: 'string', description: 'Software: funcionalidades imprescindibles y deseables' },
          integraciones: { type: 'string', description: 'Software: sistemas con los que debe integrarse' },
          datos: { type: 'string', description: 'Software: dónde están los datos hoy y si hay que migrarlos' },
          plataforma: { type: 'string', description: 'Software: plataforma y requisitos (web, móvil, reportes, roles)' },
          publico: { type: 'string', description: 'Marketing: público objetivo' },
          propuesta: { type: 'string', description: 'Marketing: qué diferencia a la empresa (propuesta de valor)' },
          canales: { type: 'string', description: 'Marketing: canales actuales y resultados' },
          competencia: { type: 'string', description: 'Marketing: competencia reconocida' },
          kpis: { type: 'string', description: 'Marketing: cómo miden hoy los resultados' },
          assets: { type: 'string', description: 'Marketing: material disponible (logo, fotos, videos, web, analítica)' },
          inversionAds: { type: 'string', description: 'Marketing: inversión publicitaria mensual que contemplan' },
          decisor: { type: 'string', description: 'Quién más interviene en la decisión' },
          plazo: { type: 'string', description: 'Para cuándo lo necesitan o quieren empezar' },
          presupuesto: { type: 'string', description: 'Presupuesto de referencia que dio la persona (dato suyo)' },
        },
        required: ['tipo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'solicitar_cotizacion',
      description:
        'Marca al cliente como listo para cotizar, guarda el resumen y avisa al equipo. Usar SOLO cuando ya se tengan nombre, celular, empresa y el levantamiento completo de necesidades (desarrollo a la medida o mercadeo). Nunca antes.',
      parameters: {
        type: 'object',
        properties: {
          resumen: { type: 'string', description: 'Resumen detallado del levantamiento: necesidades, alcance, tipo de servicio y plazos' },
        },
        required: ['resumen'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ver_disponibilidad',
      description:
        'Consulta el calendario del dueño y devuelve los espacios libres para una fecha y la duración de la reunión. Usar antes de proponer horario, con la duración que la persona haya elegido (por defecto 60 minutos). La fecha puede ser "hoy", "mañana", un día de la semana o YYYY-MM-DD (para reuniones más lejanas, como dentro de dos semanas o un mes).',
      parameters: {
        type: 'object',
        properties: {
          fecha: { type: 'string', description: 'Fecha: YYYY-MM-DD, o "hoy", "mañana", "lunes", etc.' },
          duracion_minutos: { type: 'number', description: 'Duración elegida por la persona en minutos (por defecto 60)' },
        },
        required: ['fecha'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agendar_reunion',
      description:
        'Agenda una reunión de Microsoft Teams con la persona: crea el evento en el calendario del dueño, genera el enlace de Teams e invita al cliente por correo. Usar SOLO con fecha y hora que la persona haya aceptado (previamente ofrecida con ver_disponibilidad) y con la duración que ella eligió. Si ya hay una reunión agendada en esta conversación y la persona quiere cambiarla, NO uses esta herramienta: usa reagendar_reunion.',
      parameters: {
        type: 'object',
        properties: {
          fecha: { type: 'string', description: 'Fecha: YYYY-MM-DD, o "hoy", "mañana", "lunes", etc.' },
          hora: { type: 'string', description: 'Hora de inicio en ISO 8601 con el offset UTC del país de la persona (ej. 2026-10-22T15:00:00-05:00 para Colombia, 2026-10-22T15:00:00-06:00 para México; el sistema la convierte a hora de Colombia). Como último recurso, HH:MM en hora de Colombia' },
          duracion_minutos: { type: 'number', description: 'Duración en minutos elegida por la persona (por defecto 60)' },
          titulo: { type: 'string', description: 'Asunto de la reunión' },
        },
        required: ['fecha', 'hora'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reagendar_reunion',
      description:
        'Cambia la fecha y hora de la reunión de Teams ya agendada en esta conversación. El enlace de Teams se mantiene igual y el cliente recibe la invitación actualizada por correo. Usar SOLO cuando la persona pida explícitamente mover/cambiar su reunión y haya aceptado la nueva fecha y hora (verifícala antes con ver_disponibilidad). Si la persona también menciona otra duración, pasarla; si no dice nada, se conserva la actual.',
      parameters: {
        type: 'object',
        properties: {
          fecha: { type: 'string', description: 'Fecha: YYYY-MM-DD, o "hoy", "mañana", "lunes", etc.' },
          hora: { type: 'string', description: 'Hora de inicio en ISO 8601 con el offset UTC del país de la persona (igual que en agendar_reunion). Como último recurso, HH:MM en hora de Colombia' },
          duracion_minutos: { type: 'number', description: 'Duración en minutos (solo si la persona la cambia; si no, omitir para conservar la actual)' },
        },
        required: ['fecha', 'hora'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancelar_reunion',
      description:
        'Cancela la reunión de Teams agendada en esta conversación: Microsoft envía al cliente el correo de cancelación con el motivo. Usar SOLO cuando la persona haya insistido en cancelar DESPUÉS de ofrecerle reagendar y te haya dado el motivo. Si aún no hay motivo, NO llames esta herramienta: primero pregúntaselo a la persona.',
      parameters: {
        type: 'object',
        properties: {
          motivo: { type: 'string', description: 'Motivo de la cancelación en las propias palabras de la persona' },
        },
        required: ['motivo'],
      },
    },
  },
];

// Orden fijo de los campos del levantamiento en el correo interno (tipo va en el título).
const LEV_CAMPOS_EMAIL = [
  'situacion', 'problema', 'impacto', 'objetivo',
  'usuarios', 'procesos', 'funcionalidades', 'integraciones', 'datos', 'plataforma',
  'publico', 'propuesta', 'canales', 'competencia', 'kpis', 'assets', 'inversionAds',
  'decisor', 'plazo', 'presupuesto',
];

async function llamarModelo(mensajesApi, pais, canal) {
  const c = leerConfig();
  const base = String(c.baseUrl).replace(/\/+$/, '');
  // el modelo necesita la fecha actual (Bogotá) para proponer reuniones de una
  // semana a dos meses y pasar fechas ISO a las herramientas
  const ahoraBog = new Date(Date.now() - 5 * 3600_000);
  const hoyBog = ahoraBog.toISOString().slice(0, 10);
  // el modelo calcula mal la aritmética de fechas a partir de una fecha ISO
  // (llegó a decir «lunes 27» cuando el lunes era 26): se le da la tabla de
  // próximos días ya resuelta para que solo copie la fecha exacta
  const diasLista = [];
  for (let i = 0; i < 14; i += 1) {
    const d = new Date(ahoraBog.getTime() + i * 86_400_000);
    diasLista.push(`${DIAS[d.getUTCDay()]} ${d.toISOString().slice(0, 10)}`);
  }
  let sistema =
    SYSTEM_PROMPT +
    `\n\nHoy es ${DIAS[ahoraBog.getUTCDay()]} ${hoyBog} (fecha de Colombia). ` +
    `Próximos días para agendar: ${diasLista.join(', ')}. ` +
    `Cuando propongas o confirmes una fecha, copia la fecha ISO exacta de esta tabla según el día de la semana que la persona elija; nunca calcules ni inventes la fecha de un día.`;
  // país probable por IP (caché de geoIP): sugerencia suave para el código de
  // teléfono y la zona horaria. Jamás se le dice a la persona de dónde sale.
  if (pais) sistema += ` Probable país de la persona: ${pais} (estimación del servidor; úsala solo como sugerencia amable).`;
  if (canal === 'whatsapp') sistema += '\n\n' + PROMPT_WHATSAPP;
  // el menú vive en la configuración del CRM: el modelo no puede inventar
  // funciones ni ignorar las apagadas
  const funcionesActivas = agentconfig.activas();
  if (funcionesActivas.length) {
    sistema +=
      '\n\nMENÚ ACTUAL (solo estas funciones, en este orden): ' +
      funcionesActivas.map((f) => `«${f.etiqueta}» = ${f.nombre}`).join('; ') +
      '. La etiqueta puede cambiar; la función es la que aparece después de «=». ' +
      'Las funciones que no estén en esta lista están apagadas: no las ofrezcas ni las ejecutes. ' +
      'Para volver a mostrar el menú escribe [MENU] en una línea aparte.';
  } else {
    sistema += '\n\nMENÚ ACTUAL: no hay funciones activas; atiende conversando y no ofrezcas el menú.';
  }
  const resp = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.apiKey },
    body: JSON.stringify({
      model: c.model,
      messages: [{ role: 'system', content: sistema }, ...mensajesApi],
      tools: HERRAMIENTAS,
      // la llamada a guardar_levantamiento arrastra ~20 campos: 700 tokens se
      // agotaban antes de producir texto (respuesta vacía del modelo)
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const detalle = await resp.text().catch(() => '');
    throw new Error(`modelo ${resp.status}: ${detalle.slice(0, 200)}`);
  }
  return resp.json();
}

/* -------------------------------------------------------------- herramientas */

const EMPRESA_COMODIN = '— Sin empresa —';

// Los contactos del agente van a una empresa comodín: el equipo los reclasifica
// desde el CRM cuando la conversación revela la empresa real (vincular_empresa).
function empresaComodin() {
  const previa = crm.clientes.todas().find((c) => c.nombre === EMPRESA_COMODIN);
  if (previa) return previa;
  return crm.clientes.agregar(
    {
      id: crm.siguienteId('c'),
      nombre: EMPRESA_COMODIN,
      sector: '',
      zona: '',
      notas: 'Empresa comodín: contactos captados por el asistente virtual de la página web.',
      archivoOrigen: 'agente_ia',
    },
    'aiagent'
  );
}

/**
 * Actualiza el contacto de la conversación con los datos que la persona va
 * dando (nombre, celular, correo). En web la identidad es el correo verificado
 * y en WhatsApp el número; aquí nunca se crean contactos nuevos.
 */
function registrarLead(s, args) {
  const contacto = crm.contactos.porId(s.contactoId);
  if (!contacto) return 'No encontré el contacto de esta conversación en el CRM.';

  const nombres = H.clean(args.nombres, 120).trim();
  const apellidos = H.clean(args.apellidos, 120).trim();
  const celular = H.clean(args.celular, 40).trim();
  const email = H.clean(args.email, 160).trim().toLowerCase();
  const digitos = celular.replace(/\D/g, '');

  if (nombres.length < 2 && !celular && !email) return 'Necesito al menos el nombre de la persona.';
  if (celular && (digitos.length < 7 || digitos.length > 15)) {
    return 'Ese celular no parece válido (7 a 15 dígitos).';
  }

  const cambios = {};
  if (nombres.length >= 2) {
    cambios.nombres = nombres;
    if (apellidos) cambios.apellidos = apellidos;
  }
  if (celular) cambios.celular = celular;
  if (email) cambios.email = email;
  if (!Object.keys(cambios).length) return 'No tengo datos nuevos que guardar.';

  const { datos, errores } = crm.validarContacto({ ...contacto, ...cambios });
  if (Object.keys(errores).length) return 'No pude actualizar: ' + Object.values(errores).join(' ');
  crm.contactos.actualizar(contacto.id, cambios, 'aiagent');

  s.estado = 'lead';
  s.clienteId = contacto.clienteId;
  guardarSesion(s, 'aiagent');
  return `Datos actualizados en el CRM (${contacto.id}). Continúa la conversación normalmente.`;
}

function vincularEmpresa(s, args) {
  if (s.estado !== 'lead' || !s.contactoId) {
    return 'Primero hay que registrar el lead con nombre y celular.';
  }
  const nombre = H.clean(args.nombre, 200).trim();
  if (nombre.length < 2) return 'Dime el nombre de la empresa.';
  const empleados = Number(args.numEmpleadosAprox);
  const numEmpleadosAprox = Number.isInteger(empleados) && empleados >= 0 ? empleados : null;
  let emp = crm.clientes.todas().find((c) => crm.normaliza(c.nombre) === crm.normaliza(nombre));
  if (!emp) {
    const { datos, errores } = crm.validarCliente(
      numEmpleadosAprox === null ? { nombre } : { nombre, numEmpleadosAprox }
    );
    if (Object.keys(errores).length) return 'No pude crear la empresa: ' + Object.values(errores).join(' ');
    emp = crm.clientes.agregar({ id: crm.siguienteId('c'), ...datos, archivoOrigen: 'agente_ia' }, 'aiagent');
  } else if (numEmpleadosAprox !== null && emp.numEmpleadosAprox !== numEmpleadosAprox) {
    crm.clientes.actualizar(emp.id, { numEmpleadosAprox }, 'aiagent');
  }
  crm.contactos.actualizar(s.contactoId, { clienteId: emp.id }, 'aiagent');
  s.clienteId = emp.id;
  guardarSesion(s, 'aiagent');
  return `Contacto vinculado a la empresa "${emp.nombre}".`;
}

function agregarNota(s, args) {
  if (s.estado !== 'lead' || !s.clienteId) {
    return 'Primero hay que registrar el lead con nombre y celular.';
  }
  const texto = H.clean(args.texto, 2000).trim();
  if (texto.length < 2) return 'La nota está vacía.';
  crm.notas.agregar(
    { id: crm.siguienteId('n'), clienteId: s.clienteId, contactoId: s.contactoId || '', texto },
    'aiagent'
  );
  return 'Nota guardada en el CRM.';
}

/**
 * Levantamiento estructurado (metodología SPIN + rutas software/marketing):
 * una fila por conversación; las llamadas repetidas fusionan los campos que
 * traigan valor, así el agente puede guardar a medida que averigua.
 */
function guardarLevantamiento(s, args) {
  if (s.estado !== 'lead' || !s.clienteId) {
    return 'Primero hay que registrar el lead con nombre y celular.';
  }
  if (!args || !args.tipo) return 'Falta la pista del levantamiento (tipo: software o marketing).';
  const r = crm.guardarLevantamiento(
    { guid: s.id, clienteId: s.clienteId, contactoId: s.contactoId, campos: args },
    'aiagent'
  );
  if (r.error) return 'No pude guardar el levantamiento: ' + r.error;
  return 'Levantamiento guardado en el CRM. Continúa la conversación normalmente.';
}

/**
 * Cierre del levantamiento: la empresa queda en estado "listo para cotizar"
 * (visible en el CRM), el resumen queda como nota y el equipo recibe un correo
 * interno con los datos del contacto. La cotización con valores la hace una
 * persona; el agente jamás da precios.
 */
async function solicitarCotizacion(s, args) {
  if (s.estado !== 'lead' || !s.contactoId) {
    return 'Primero hay que registrar el lead con nombre y celular.';
  }
  const resumen = H.clean(args.resumen, 2000).trim();
  if (resumen.length < 10) return 'El resumen del levantamiento está muy corto. Conversa más con la persona.';

  const comodin = empresaComodin();
  if (!s.clienteId || s.clienteId === comodin.id) {
    return 'Falta la empresa de la persona. Pregúntale en qué empresa trabaja y usa vincular_empresa antes de solicitar la cotización.';
  }
  if (s.cotizacion === 'solicitada') {
    return 'La cotización ya fue solicitada. Recuérdale que su propuesta se presentará en la reunión de Teams y ofrécele agendarla si aún no lo está.';
  }

  const contacto = crm.contactos.porId(s.contactoId);
  const empresa = crm.clientes.porId(s.clienteId);
  if (!contacto || !empresa) return 'No encontré el contacto o la empresa en el CRM.';

  crm.clientes.actualizar(empresa.id, { estadoSeguimiento: 'listo_cotizar' }, 'aiagent');
  crm.notas.agregar(
    {
      id: crm.siguienteId('n'),
      clienteId: empresa.id,
      contactoId: contacto.id,
      texto: `Solicitud de cotización desde el agente de IA (la propuesta se presenta en la reunión de Teams):\n${resumen}`,
    },
    'aiagent'
  );

  const nombreCompleto = `${contacto.nombres || ''} ${contacto.apellidos || ''}`.trim();
  const lineas = [
    'Nuevo cliente listo para cotizar (agente de IA de la página web)',
    '',
    'DATOS DEL CONTACTO',
    `- Nombre: ${nombreCompleto || '(sin nombre)'}`,
    `- Celular: ${contacto.celular || '(sin celular)'}`,
    `- Correo: ${contacto.email || '(sin correo)'}`,
    `- Cargo: ${contacto.cargo || '(sin cargo)'}`,
    `- Empresa: ${empresa.nombre}`,
    `- Teléfono empresa: ${empresa.telefono || '(sin dato)'}`,
    `- Correo empresa: ${empresa.email || '(sin dato)'}`,
    '',
    'LEVANTAMIENTO DE NECESIDADES',
    resumen,
  ];
  const lev = crm.levantamientos.todas().find((l) => l.guid === s.id);
  if (lev) {
    lineas.push('', `LEVANTAMIENTO ESTRUCTURADO (pista: ${lev.tipo || 'sin definir'})`);
    for (const campo of LEV_CAMPOS_EMAIL) {
      if (lev[campo]) lineas.push(`- ${crm.ETIQUETAS_LEVANTAMIENTO[campo]}: ${lev[campo]}`);
    }
  }
  lineas.push(
    '',
    'IMPORTANTE: la cotización NO se envía por correo. El agente está agendando (o ya agendó) una reunión',
    'de Teams en la que se presenta la propuesta a este cliente: tenla preparada para la fecha de la reunión.',
    '',
    `Conversación completa: busca al contacto en el CRM (${(config.publicUrl || '') + '/crm'}) y abre su ficha: ahí están todos los mensajes.`,
    `CRM: ${(config.publicUrl || '') + '/crm'}`,
    '',
    '— Agente virtual de OPIA Software'
  );
  const envio = await crm.notificarEquipo({
    subject: `Cotización pendiente para reunión de Teams: ${nombreCompleto || contacto.id} (${empresa.nombre})`,
    text: lineas.join('\n'),
  });

  s.cotizacion = 'solicitada';
  guardarSesion(s, 'aiagent');
  return (
    'Cotización solicitada: el cliente quedó marcado como listo para cotizar en el CRM' +
    (envio.ok ? ' y el equipo ya recibió el correo con el levantamiento.' : ', pero el correo interno falló (avísale al administrador).') +
    ' La propuesta se presenta en la reunión de Teams: ofrécele agendarla de una vez. ' +
    'En ese mismo mensaje incluye el recordatorio del WhatsApp en horario laboral para cualquier duda, escrito SIEMPRE como enlace completo https://wa.me/573332782483 (nunca solo +57 333 278 2483).'
  );
}

async function ejecutarHerramienta(s, nombre, args) {
  switch (nombre) {
    case 'registrar_lead':
      return registrarLead(s, args);
    case 'vincular_empresa':
      return vincularEmpresa(s, args);
    case 'agregar_nota':
      return agregarNota(s, args);
    case 'guardar_levantamiento':
      return guardarLevantamiento(s, args);
    case 'solicitar_cotizacion':
      return solicitarCotizacion(s, args);
    case 'ver_disponibilidad':
      return verDisponibilidad(s, args);
    case 'agendar_reunion':
      return agendarReunionConCliente(s, args);
    case 'reagendar_reunion':
      return reagendarReunionConCliente(s, args);
    case 'cancelar_reunion':
      return cancelarReunionConCliente(s, args);
    default:
      return 'Herramienta desconocida.';
  }
}

/* ------------------------------------------------------------- reuniones Teams */

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// El cliente escribe "mañana" o "el lunes"; las herramientas necesitan YYYY-MM-DD.
// Se resuelve en hora de Bogotá (UTC-5, sin horario de verano).
function resolverFecha(texto) {
  const t = String(texto || '').trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const ahoraBog = Date.now() - 5 * 3600_000;
  const hoy = new Date(ahoraBog).toISOString().slice(0, 10);
  const sumar = (dias) => new Date(new Date(hoy + 'T12:00:00Z').getTime() + dias * 86_400_000).toISOString().slice(0, 10);
  if (t === 'hoy') return hoy;
  if (/pasado\s*mañana/.test(t)) return sumar(2);
  if (/mañana/.test(t)) return sumar(1);
  const sinTildes = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const nombres = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  for (let i = 0; i < 7; i += 1) {
    if (sinTildes.startsWith(nombres[i])) {
      const hoyDow = new Date(ahoraBog).getUTCDay();
      return sumar((i - hoyDow + 7) % 7);
    }
  }
  return '';
}

/**
 * Convierte una hora ISO 8601 con offset (la hora local de la persona en otro
 * país) a fecha y hora de Bogotá (UTC-5, sin horario de verano). El ISO es la
 * única fuente del instante exacto: la aritmética de zonas no la hace el modelo.
 */
function horaIsoABogota(hora) {
  const t = String(hora || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})$/.test(t)) return null;
  const normalizada = t.replace(/([+-])(\d{2}):?(\d{2})$/, '$1$2:$3');
  const instante = new Date(normalizada);
  if (Number.isNaN(instante.getTime())) return null;
  const bogota = new Date(instante.getTime() - 5 * 3600_000);
  const iso = bogota.toISOString();
  return { fecha: iso.slice(0, 10), hora: iso.slice(11, 16) };
}

/**
 * Resuelve los argumentos fecha/hora de agendar_reunion y reagendar_reunion: la
 * fecha puede ser relativa ("viernes") y la hora ISO 8601 con el offset del país
 * de la persona o HH:MM de Bogotá. El ISO manda: la reunión debe caer en el
 * instante exacto que la persona aceptó en su hora local.
 * Devuelve { fechaBog, horaNorm, horaPersona } o { error }.
 */
function normalizarFechaHora(args) {
  const fecha = resolverFecha(args.fecha);
  const hora = H.clean(args.hora, 32).trim();
  if (!fecha) {
    return { error: 'No entendí la fecha de la reunión. Confírmala con la persona (por ejemplo "mañana" o "el lunes") y vuelve a llamar la herramienta.' };
  }
  let fechaBog = fecha;
  let horaNorm = '';
  let horaPersona = '';
  const iso = horaIsoABogota(hora);
  if (iso) {
    fechaBog = iso.fecha;
    horaNorm = iso.hora;
    horaPersona = `${hora.slice(0, 10)} ${hora.slice(11, 16)}`;
  } else if (/^\d{1,2}:\d{2}$/.test(hora)) {
    horaNorm = hora.padStart(5, '0');
  } else {
    return { error: 'La hora debe ser HH:MM (hora de Colombia) o ISO 8601 con offset UTC (ejemplo: 2026-10-22T15:00:00-06:00 para las 3 pm en México).' };
  }
  return { fechaBog, horaNorm, horaPersona };
}

/**
 * El calendario no responde y la persona quiere reunión: el dueño debe enterarse
 * por correo para confirmarle manualmente. Una sola vez por conversación.
 */
async function avisarCalendarioCaido(s, detalle) {
  if (!s.contactoId || s.avisoCalendario === 'enviado') return;
  const contacto = crm.contactos.porId(s.contactoId);
  if (!contacto) return;
  s.avisoCalendario = 'enviado';
  guardarSesion(s, 'aiagent');
  const empresa = crm.clientes.porId(s.clienteId);
  const nombreCompleto = `${contacto.nombres || ''} ${contacto.apellidos || ''}`.trim() || contacto.email;
  await crm.notificarEquipo({
    subject: `Confirmar reunión a mano: ${nombreCompleto} (calendario de Teams no conectado)`,
    text:
      `El agente de IA no pudo usar el calendario de Teams: ${detalle}.\n\n` +
      'DATOS DEL CONTACTO\n' +
      `- Nombre: ${nombreCompleto}\n- Correo: ${contacto.email || '—'}\n- Celular: ${contacto.celular || '—'}\n` +
      `- Empresa: ${empresa ? empresa.nombre : '—'}\n\n` +
      'Confírmale la reunión por correo o WhatsApp y reconecta el calendario desde el panel.\n\n' +
      `Conversación: busca a ${nombreCompleto} en el CRM (${(config.publicUrl || '') + '/crm'}) y abre su ficha.`,
  });
}

async function verDisponibilidad(s, args) {
  if (!(await teams.asegurarActivo())) {
    await avisarCalendarioCaido(s, 'la persona pidió horario de reunión y no se pudo consultar el calendario');
    return 'El calendario del equipo no está conectado todavía. Dile a la persona que el equipo le confirmará la hora por correo o WhatsApp.';
  }
  const fecha = resolverFecha(args.fecha);
  if (!fecha) return 'No entendí la fecha. Pídele el día en que quiere reunirse (por ejemplo "mañana" o "el lunes") y vuelve a llamar la herramienta.';
  const duracion = Math.min(Math.max(Number(args.duracion_minutos) || 60, 15), 240);
  try {
    const { huecos } = await teams.disponibilidad(fecha, duracion);
    if (!huecos.length) return `No hay espacios de ${duracion} minutos disponibles el ${fecha}. Pregunta por otro día.`;
    return (
      `Huecos para una reunión de ${duracion} minutos el ${DIAS[new Date(fecha + 'T12:00:00-05:00').getDay()]} ${fecha} (hora Colombia): ` +
      huecos.join(', ') +
      '. Ofrece estos horarios a la persona.'
    );
  } catch (err) {
    console.error('[teams] disponibilidad:', err.message);
    return 'No pude consultar el calendario en este momento. Dile que el equipo le confirmará la hora.';
  }
}

async function agendarReunionConCliente(s, args) {
  if (s.estado !== 'lead' || !s.contactoId) {
    return 'Primero hay que registrar el lead con nombre y celular.';
  }
  if (s.reunion && s.reunion.joinUrl) {
    return `Ya hay una reunión agendada en esta conversación (${s.reunion.inicio}). No crees otra: si la persona quiere cambiar la hora, usa reagendar_reunion con la nueva fecha y hora que acepte.`;
  }
  const contacto = crm.contactos.porId(s.contactoId);
  if (!contacto) return 'No encontré el contacto en el CRM.';
  if (!contacto.email) return 'Falta el correo de la persona para invitarla. Pídeselo y llama de nuevo a agendar_reunion.';
  if (!(await teams.asegurarActivo())) {
    await avisarCalendarioCaido(
      s,
      `la persona aceptó reunión (${args.fecha || 'sin fecha'}, ${args.duracion_minutos || 60} min) y no se pudo agendar`
    );
    return 'El calendario del equipo no está conectado todavía. Dile a la persona que el equipo le confirmará la reunión por correo o WhatsApp.';
  }

  const nh = normalizarFechaHora(args);
  if (nh.error) return nh.error;
  const duracion = Math.min(Math.max(Number(args.duracion_minutos) || 60, 15), 240);
  const empresa = crm.clientes.porId(s.clienteId);
  const nombreCompleto = `${contacto.nombres || ''} ${contacto.apellidos || ''}`.trim() || contacto.email;
  const titulo = H.clean(args.titulo, 200).trim() || `Reunión OPIA Software — ${empresa ? empresa.nombre : nombreCompleto}`;

  try {
    const r = await teams.agendarReunion({
      fecha: nh.fechaBog,
      hora: nh.horaNorm,
      duracion,
      titulo,
      nombre: nombreCompleto,
      email: contacto.email,
      notas: `Cliente: ${nombreCompleto} · Celular: ${contacto.celular || '—'} · Empresa: ${empresa ? empresa.nombre : '—'}`,
    });

    crm.notas.agregar(
      {
        id: crm.siguienteId('n'),
        clienteId: s.clienteId,
        contactoId: contacto.id,
        texto: `Reunión de Teams agendada por el agente de IA: ${r.inicio} (${r.fin} fin).${
          nh.horaPersona ? ` Hora de la persona: ${nh.horaPersona}.` : ''
        } Enlace: ${r.joinUrl}`,
      },
      'aiagent'
    );
    await crm.notificarEquipo({
      subject: `Reunión agendada: ${nombreCompleto} — ${r.inicio}`,
      text:
        `El agente de IA agendó una reunión de Teams.\n\n` +
        `Cliente: ${nombreCompleto}\nCorreo: ${contacto.email}\nCelular: ${contacto.celular || '—'}\n` +
        `Empresa: ${empresa ? empresa.nombre : '—'}\nFecha: ${r.inicio} (hora Colombia, ${duracion} min)${
          nh.horaPersona ? ` — ${nh.horaPersona} hora de la persona` : ''
        }\n\n` +
        `Enlace Teams: ${r.joinUrl}\n\nConversación: busca a ${nombreCompleto} en el CRM (${(config.publicUrl || '') + '/crm'}) y abre su ficha.`,
    });

    s.reunion = { joinUrl: r.joinUrl, inicio: r.inicio, eventoId: r.eventoId };
    guardarSesion(s, 'aiagent');
    return (
      `Reunión agendada para el ${r.inicio} (hora Colombia)${nh.horaPersona ? ` — para la persona son las ${nh.horaPersona} de su hora local` : ''} con enlace de Teams: ${r.joinUrl}. ` +
      'Dile a la persona que recibirá la invitación en su correo y que puede unirse con el enlace.'
    );
  } catch (err) {
    console.error('[teams] agendar:', err.message);
    if (/ocup/i.test(err.message)) return err.message + ' Ofrece otros horarios con ver_disponibilidad.';
    return 'No pude agendar la reunión (' + err.message + '). Ofrece que el equipo le confirme por correo.';
  }
}

/** Graph responde 404 ErrorItemNotFound cuando el evento guardado ya no existe
 *  (se canceló o se borró a mano en Outlook). */
function esEventoInexistente(err) {
  return /ErrorItemNotFound|\b404\b/i.test(String(err && err.message ? err.message : err));
}

/**
 * Cambia la hora de la reunión ya agendada en esta conversación (PATCH sobre el
 * mismo evento de Teams: el enlace se conserva y Microsoft reenvía la invitación
 * actualizada al cliente). Si el evento guardado ya no existe en el calendario,
 * agenda una reunión nueva con el correo del cliente. Avisa al dueño por correo.
 */
async function reagendarReunionConCliente(s, args) {
  if (s.estado !== 'lead' || !s.contactoId) {
    return 'Primero hay que registrar el lead con nombre y celular.';
  }
  if (!s.reunion || !s.reunion.joinUrl) {
    return 'No hay reunión agendada en esta conversación. Si la persona quiere una, ofrece horarios con ver_disponibilidad y agenda con agendar_reunion.';
  }

  if (!(await teams.asegurarActivo())) {
    await avisarCalendarioCaido(
      s,
      `la persona pidió reagendar a ${args.fecha || 'sin fecha'} ${args.hora || ''} y el calendario no respondió`
    );
    return 'El calendario del equipo no está conectado todavía. Dile a la persona que el equipo le confirmará el cambio por correo o WhatsApp.';
  }

  const nh = normalizarFechaHora(args);
  if (nh.error) return nh.error;
  const duracion = Number(args.duracion_minutos);
  const viejo = s.reunion.inicio;
  const contacto = crm.contactos.porId(s.contactoId);
  if (!contacto) return 'No encontré el contacto en el CRM.';
  const empresa = crm.clientes.porId(s.clienteId);
  const nombreCompleto = `${contacto.nombres || ''} ${contacto.apellidos || ''}`.trim() || contacto.email;
  const dur = Number.isFinite(duracion) && duracion > 0 ? duracion : undefined;

  const mover = (eventoId) => teams.moverReunion(eventoId, { fecha: nh.fechaBog, hora: nh.horaNorm, duracion: dur });

  try {
    let r = null;
    let id = s.reunion.eventoId || '';
    if (!id) {
      try {
        id = await teams.encontrarEvento(viejo);
      } catch (err) {
        console.error('[teams] encontrar evento:', err.message);
      }
    }
    if (id) {
      try {
        r = await mover(id);
      } catch (err) {
        if (!esEventoInexistente(err)) throw err;
        // el id quedó viejo: se intenta ubicar el evento por su fecha y hora
        console.error('[teams] reagendar: el evento guardado ya no existe, se busca de nuevo');
        try {
          id = await teams.encontrarEvento(viejo);
        } catch {
          id = '';
        }
        if (id) {
          try {
            r = await mover(id);
          } catch (err2) {
            if (!esEventoInexistente(err2)) throw err2;
            id = '';
          }
        }
      }
    }

    // la reunión anterior desapareció del calendario (por ejemplo, se canceló y
    // la sesión conservó el id viejo): se crea una nueva con el correo del cliente
    let nueva = false;
    if (!r) {
      if (!contacto.email) {
        return 'La reunión anterior ya no está en el calendario y falta el correo de la persona para enviarle una invitación nueva. Pídeselo y vuelve a intentar.';
      }
      r = await teams.agendarReunion({
        fecha: nh.fechaBog,
        hora: nh.horaNorm,
        duracion: dur || 60,
        titulo: `Reunión de Teams — ${nombreCompleto}`,
        nombre: nombreCompleto,
        email: contacto.email,
        notas: `Cliente: ${nombreCompleto} · Celular: ${contacto.celular || '—'} · Empresa: ${empresa ? empresa.nombre : '—'}`,
      });
      nueva = true;
    }

    crm.notas.agregar(
      {
        id: crm.siguienteId('n'),
        clienteId: s.clienteId,
        contactoId: contacto.id,
        texto: `${nueva ? 'Reunión de Teams agendada de nuevo' : 'Reunión de Teams reagendada'} por el agente de IA: de ${viejo} a ${r.inicio} (${r.fin} fin).${
          nh.horaPersona ? ` Hora de la persona: ${nh.horaPersona}.` : ''
        } Enlace: ${r.joinUrl}`,
      },
      'aiagent'
    );
    await crm.notificarEquipo({
      subject: `${nueva ? 'Reunión reagendada (nueva invitación)' : 'Reunión reagendada'}: ${nombreCompleto} — ${viejo} → ${r.inicio}`,
      text:
        `El agente de IA movió la reunión de Teams de ${viejo} a ${r.inicio}.\n\n` +
        (nueva
          ? 'La reunión anterior ya no existía en el calendario, así que se creó una invitación nueva con su enlace de Teams.\n\n'
          : '') +
        `Cliente: ${nombreCompleto}\nCorreo: ${contacto.email || '—'}\nCelular: ${contacto.celular || '—'}\n` +
        `Empresa: ${empresa ? empresa.nombre : '—'}\nNueva fecha: ${r.inicio} (hora Colombia)${
          nh.horaPersona ? ` — ${nh.horaPersona} hora de la persona` : ''
        }\n\n` +
        `Enlace Teams: ${r.joinUrl}\n\nConversación: busca a ${nombreCompleto} en el CRM (${(config.publicUrl || '') + '/crm'}) y abre su ficha.`,
    });

    s.reunion = { joinUrl: r.joinUrl, inicio: r.inicio, eventoId: r.eventoId };
    guardarSesion(s, 'aiagent');
    if (nueva) {
      return (
        `La reunión anterior ya no estaba en el calendario, así que agendé una nueva para el ${r.inicio} (hora Colombia)${
          nh.horaPersona ? ` — para la persona son las ${nh.horaPersona} de su hora local` : ''
        } con un enlace de Teams nuevo: ${r.joinUrl}. Dile que recibirá la invitación en su correo y que este enlace reemplaza al anterior.`
      );
    }
    return (
      `Reunión movida al ${r.inicio} (hora Colombia)${nh.horaPersona ? ` — para la persona son las ${nh.horaPersona} de su hora local` : ''}. ` +
      `El enlace de Teams es el mismo: ${r.joinUrl}. Dile que recibirá la invitación actualizada en su correo.`
    );
  } catch (err) {
    console.error('[teams] reagendar:', err.message);
    if (/ocup/i.test(err.message)) return err.message + ' Ofrece otros horarios con ver_disponibilidad.';
    return 'No pude reagendar la reunión (' + err.message + '). Ofrece que el equipo le confirme el cambio por correo.';
  }
}

/**
 * Cancela la reunión de esta conversación. Graph envía al cliente el correo de
 * cancelación con el motivo y el dueño recibe una notificación con la razón;
 * el motivo queda también en una nota del CRM.
 */
async function cancelarReunionConCliente(s, args) {
  if (s.estado !== 'lead' || !s.contactoId) {
    return 'Primero hay que registrar el lead con nombre y celular.';
  }
  if (!s.reunion || !s.reunion.joinUrl) {
    return 'No hay reunión agendada en esta conversación, así que no hay nada que cancelar.';
  }
  const motivo = H.clean(args.motivo, 500).trim();
  if (!motivo) {
    return 'Antes de cancelarle la reunión a la persona, pregúntale el motivo de la cancelación y vuelve a llamar esta herramienta con motivo.';
  }

  // reuniones creadas antes de guardar eventoId: se busca el evento en el calendario
  if (!s.reunion.eventoId) {
    try {
      const id = await teams.encontrarEvento(s.reunion.inicio);
      if (id) {
        s.reunion.eventoId = id;
        guardarSesion(s, 'aiagent');
      }
    } catch (err) {
      console.error('[teams] encontrar evento:', err.message);
    }
  }
  if (!s.reunion.eventoId) {
    await avisarCalendarioCaido(
      s,
      `la persona pidió cancelar la reunión (${s.reunion.inicio}), motivo: «${motivo}», y no se encontró en el calendario`
    );
    return 'No encuentro en el calendario la reunión agendada antes, así que no puedo cancelarla desde aquí. Dile que el equipo le confirmará la cancelación por correo o WhatsApp.';
  }

  if (!(await teams.asegurarActivo())) {
    await avisarCalendarioCaido(
      s,
      `la persona pidió cancelar la reunión (${s.reunion.inicio}), motivo: «${motivo}», y el calendario no respondió`
    );
    return 'El calendario del equipo no está conectado todavía. Dile a la persona que el equipo le confirmará la cancelación por correo o WhatsApp.';
  }

  const viejo = s.reunion.inicio;
  const contacto = crm.contactos.porId(s.contactoId);
  const empresa = crm.clientes.porId(s.clienteId);
  const nombreCompleto = contacto
    ? `${contacto.nombres || ''} ${contacto.apellidos || ''}`.trim() || contacto.email
    : 'cliente';

  try {
    await teams.cancelarReunion(s.reunion.eventoId, motivo);

    crm.notas.agregar(
      {
        id: crm.siguienteId('n'),
        clienteId: s.clienteId,
        contactoId: contacto ? contacto.id : '',
        texto: `Reunión de Teams cancelada por el agente de IA (${viejo}, hora Colombia). Motivo de la persona: ${motivo}`,
      },
      'aiagent'
    );
    await crm.notificarEquipo({
      subject: `Reunión cancelada: ${nombreCompleto} — ${viejo}`,
      text:
        `El agente de IA canceló la reunión de Teams.\n\n` +
        `Cliente: ${nombreCompleto}\nCorreo: ${contacto ? contacto.email : '—'}\nCelular: ${contacto ? contacto.celular || '—' : '—'}\n` +
        `Empresa: ${empresa ? empresa.nombre : '—'}\nFecha cancelada: ${viejo} (hora Colombia)\n\n` +
        `Motivo de la cancelación: ${motivo}\n\n` +
        `El cliente recibió el aviso de cancelación por correo.\n\nConversación: busca a ${nombreCompleto} en el CRM (${(config.publicUrl || '') + '/crm'}) y abre su ficha.`,
    });

    s.reunion = null;
    guardarSesion(s, 'aiagent');
    return (
      `Reunión del ${viejo} (hora Colombia) cancelada: el cliente recibió el aviso por correo con el motivo. ` +
      'Dile a la persona que la cancelación quedó registrada y que el equipo está atento para cuando quiera retomar el proyecto.'
    );
  } catch (err) {
    console.error('[teams] cancelar:', err.message);
    if (esEventoInexistente(err)) {
      // el evento ya no está en el calendario: la cancelación está hecha
      s.reunion = null;
      guardarSesion(s, 'aiagent');
      return (
        'La reunión ya no estaba en el calendario (se había cancelado o borrado antes), así que no hay nada más que hacer. ' +
        'Dile a la persona que su reunión quedó cancelada y que el equipo está atento para cuando quiera retomar el proyecto.'
      );
    }
    return 'No pude cancelar la reunión (' + err.message + '). Dile que el equipo le confirmará la cancelación por correo o WhatsApp.';
  }
}

/* ------------------------------------------------------------ conversación */

async function responder(s, texto, pais, canal, adjunto, conMenu) {
  agregarMsg(s, { rol: 'usuario', texto }, 'visitante');
  for (let i = 0; i < MAX_ITER_HERRAMIENTAS; i += 1) {
    const historial = historialApi(s);
    // la foto viaja en el turno del usuario; se reengancha en cada iteración
    // para que el modelo la siga viendo después de una llamada a herramienta
    if (adjunto && adjunto.tipo === 'imagen' && adjunto.base64) {
      for (let j = historial.length - 1; j >= 0; j -= 1) {
        if (historial[j].role === 'user') {
          historial[j].content = [
            { type: 'text', text: texto || 'La persona envió esta imagen.' },
            { type: 'image_url', image_url: { url: `data:${adjunto.mime || 'image/jpeg'};base64,${adjunto.base64}` } },
          ];
          break;
        }
      }
    }
    const data = await llamarModelo(historial, pais, canal);
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) throw new Error('respuesta vacía del modelo');
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      agregarMsg(s, { rol: 'ia', texto: msg.content || '', toolCalls: msg.tool_calls }, 'aiagent');
      for (const tc of msg.tool_calls) {
        let resultado;
        try {
          resultado = await ejecutarHerramienta(s, tc.function.name, JSON.parse(tc.function.arguments || '{}'));
        } catch (err) {
          resultado = 'error: ' + err.message;
        }
        agregarMsg(s, { rol: 'herramienta', texto: resultado, toolCallId: tc.id }, 'aiagent');
      }
      continue;
    }
    const respuesta = (msg.content || '').trim();
    // respuesta vacía sin herramientas (modelo agotó sus tokens): reintentar
    // dentro del presupuesto de iteraciones antes de rendirse
    if (!respuesta && i < MAX_ITER_HERRAMIENTAS - 1) continue;
    // el modelo solo escribe [MENU]; las etiquetas y el orden salen de la
    // configuración del CRM para que no pueda inventarlos
    let final = respuesta || 'Cuéntame un poco más.';
    // una sesión anterior al menú configurable lo ve al menos una vez, sin
    // pisar las opciones propias de la respuesta
    if (conMenu && !/\[OPCIONES\]/i.test(final)) final += '\n[MENU]';
    final = agentconfig.expandirMenu(final);
    agregarMsg(s, { rol: 'ia', texto: final }, 'aiagent');
    return final;
  }
  return 'Se me enredó esa parte, ¿me lo repites?';
}

/* tope diario global: cada mensaje es una llamada de pago al modelo */
let contadorDia = { fecha: '', n: 0 };
function topeDiarioOk() {
  const hoy = new Date().toISOString().slice(0, 10);
  if (contadorDia.fecha !== hoy) contadorDia = { fecha: hoy, n: 0 };
  contadorDia.n += 1;
  return contadorDia.n <= MAX_MENSAJES_DIA;
}

/**
 * Punto de entrada de cada mensaje del chat público.
 * Devuelve { guid, texto, leadRegistrado } o { error, status }.
 */
/**
 * Punto de entrada de cada mensaje del chat. La sesión solo existe después de
 * verificar el correo con el magic link: no se chatea sin identidad.
 * Devuelve { guid, texto } o { error, status }.
 */
async function mensaje(guidPropuesto, texto, pais) {
  if (!configurado()) return { error: 'El agente de IA no está configurado todavía.', status: 503 };

  const s = obtenerSesion(guidPropuesto || '');
  if (!s) return { error: 'Conversación no encontrada. Vuelve a entrar con tu enlace de acceso.', status: 404 };
  if (s.estado !== 'lead') {
    // sesiones del flujo anónimo anterior: se les pide pasar por el correo
    const aviso = 'Para seguir conversando necesitas entrar con tu correo. Abre de nuevo opiasoftware.com/aiagent y sigue los pasos.';
    agregarMsg(s, { rol: 'usuario', texto }, 'visitante');
    agregarMsg(s, { rol: 'ia', texto: aviso }, 'aiagent');
    return { guid: s.id, texto: aviso };
  }

  if (!topeDiarioOk()) {
    return {
      guid: s.id,
      texto: 'Hoy recibí muchos mensajes y necesito un descanso. Escríbenos mañana o déjanos tus datos en la página de contacto.',
    };
  }

  try {
    // las conversaciones web anteriores al menú configurable lo reciben una
    // sola vez al final de la respuesta
    let conMenu = false;
    if (!s.menuVersion) {
      sesiones.actualizar(s.id, { menuVersion: 2 }, 'aiagent');
      s.menuVersion = 2;
      conMenu = agentconfig.menuOpciones().length >= 2;
    }
    const respuesta = await responder(s, texto, pais, undefined, undefined, conMenu);
    return { guid: s.id, texto: respuesta };
  } catch (err) {
    // sin respuesta del modelo se quita el turno del usuario: evita duplicados al reintentar
    const suyos = mensajes.todas().filter((m) => m.guid === s.id);
    const ultimo = suyos[suyos.length - 1];
    if (ultimo && ultimo.rol === 'usuario') mensajes.eliminar(ultimo.id);
    throw err;
  }
}

/** Aviso al equipo cuando un número escribe por primera vez al agente. */
function avisarNuevoWhatsApp(contacto, texto, adjunto) {
  // por WhatsApp solo se conoce el número: nombre y empresa aparecen únicamente
  // si el celular ya correspondía a un contacto del CRM
  const nombreReal = [contacto.nombres, contacto.apellidos].filter(Boolean).join(' ').trim();
  const nombre = nombreReal && nombreReal !== NOMBRE_SIN_REGISTRAR ? nombreReal : '';
  const empresa = crm.clientes.porId(contacto.clienteId);
  const empresaReal = empresa && empresa.nombre !== EMPRESA_COMODIN ? empresa.nombre : '';
  const primer =
    String(texto || '').trim() ||
    (adjunto && adjunto.tipo === 'imagen' ? '[Envió una foto]' : '[Envió un archivo]');
  const celular = contacto.celular || '—';
  const base = String(config.publicUrl || '').replace(/\/+$/, '');
  crm
    .notificarEquipo({
      subject: `Nuevo WhatsApp: ${celular}${nombre ? ' · ' + nombre : ''}`,
      text:
        `Un número escribió por primera vez al WhatsApp del agente.\n\n` +
        `Celular: ${celular}\n` +
        (nombre ? `Nombre: ${nombre}\n` : '') +
        (empresaReal ? `Empresa: ${empresaReal}\n` : '') +
        `Primer mensaje: ${primer.slice(0, 500)}\n\n` +
        `Ver la conversación en el CRM: ${base}/crm?contacto=${encodeURIComponent(contacto.id)}\n`,
    })
    .catch((err) => console.error('[aiagent] aviso WhatsApp:', err.message));
}

/**
 * Punto de entrada de cada mensaje de WhatsApp. La identidad es el número
 * verificado por Meta: no hay enlace ni contraseña. `adjunto` lleva la foto ya
 * descargada por el canal ({ tipo: 'imagen', mime, base64 }).
 * Devuelve { texto, opciones, saludo, saludoOpciones } o { error, status }.
 */
async function mensajeWhatsApp(numero, textoCrudo, adjunto) {
  if (!configurado()) return { error: 'El agente de IA no está configurado todavía.', status: 503 };

  const texto = H.clean(textoCrudo, 2000).trim();
  if (!texto && !adjunto) return { error: 'Mensaje vacío.', status: 422 };

  const resuelta = sesionWhatsApp(numero);
  if (!resuelta) return { error: 'Número de WhatsApp inválido.', status: 422 };
  const { sesion: s } = resuelta;
  let saludo = resuelta.saludo;
  let saludoOpciones = null;
  // las conversaciones anteriores al menú configurable lo reciben una sola vez
  if (!saludo && !s.menuVersion) {
    const opciones = agentconfig.menuOpciones();
    sesiones.actualizar(s.id, { menuVersion: 2 }, 'aiagent');
    s.menuVersion = 2;
    if (opciones.length >= 2) saludo = `¿Qué deseas hacer?\n[OPCIONES] ${opciones.join(' | ')}`;
  }
  if (saludo) {
    const g = adaptarAWhatsApp(saludo);
    saludo = g.texto;
    saludoOpciones = g.opciones;
    // si el menú viaja como texto numerado, la respuesta «2» debe resolverse
    // con las mismas etiquetas que se acaban de mostrar
    if (saludoOpciones) {
      s.ultimasOpciones = saludoOpciones;
      guardarSesion(s, 'aiagent');
    }
  }

  if (!topeDiarioOk()) {
    return {
      saludo,
      saludoOpciones,
      error: 'tope diario',
      status: 429,
      texto: 'Hoy recibí muchos mensajes y necesito un descanso. Escríbeme mañana, por favor.',
    };
  }

  if (resuelta.primeraVezWhatsApp) avisarNuevoWhatsApp(resuelta.contacto, texto, adjunto);

  // respuesta numérica a la última lista de opciones (solo si no es una foto)
  let entrada = texto || (adjunto ? '[La persona envió una foto]' : '');
  const opciones = Array.isArray(s.ultimasOpciones) ? s.ultimasOpciones : [];
  const m = /^(\d{1,2})[.)]?$/.exec(texto);
  if (!adjunto && m && opciones[Number(m[1]) - 1]) entrada = opciones[Number(m[1]) - 1];

  // el botón de atención humana entrega de una vez la línea del equipo: no
  // pasa por el modelo para que el enlace salga siempre
  const humano = agentconfig.activas().find((f) => f.id === 'humano');
  if (humano && entrada.trim().toLowerCase() === humano.etiqueta.toLowerCase()) {
    const opcionesMenu = agentconfig.menuOpciones();
    const respuesta =
      'Claro que sí. Escríbele directamente a una persona del equipo por WhatsApp: ' +
      'https://wa.me/573332782483 — te atiende en horario laboral.' +
      (opcionesMenu.length >= 2 ? `\n[OPCIONES] ${opcionesMenu.join(' | ')}` : '');
    agregarMsg(s, { rol: 'usuario', texto: entrada }, 'visitante');
    agregarMsg(s, { rol: 'ia', texto: respuesta }, 'aiagent');
    const adaptado = adaptarAWhatsApp(respuesta);
    s.ultimasOpciones = adaptado.opciones || [];
    guardarSesion(s, 'aiagent');
    return { texto: adaptado.texto, opciones: adaptado.opciones, saludo, saludoOpciones };
  }

  // el indicativo 57 ubica a la persona en Colombia para las reuniones
  const pais = soloDigitos(numero).startsWith('57') ? 'Colombia' : null;

  try {
    const respuesta = await responder(s, entrada, pais, 'whatsapp', adjunto);
    const adaptado = adaptarAWhatsApp(respuesta);
    s.ultimasOpciones = adaptado.opciones || [];
    guardarSesion(s, 'aiagent');
    return { texto: adaptado.texto, opciones: adaptado.opciones, saludo, saludoOpciones };
  } catch (err) {
    // sin respuesta del modelo se quita el turno del usuario: evita duplicados al reintentar
    const suyos = mensajes.todas().filter((x) => x.guid === s.id);
    const ultimo = suyos[suyos.length - 1];
    if (ultimo && ultimo.rol === 'usuario') mensajes.eliminar(ultimo.id);
    throw err;
  }
}

module.exports = {
  COOKIE_AI,
  ACCESO_SEGUNDOS,
  configurado,
  obtenerSesion,
  crearAcceso,
  sesionDeAcceso,
  historialVisible,
  podarSesiones,
  eliminarPorContacto,
  conversacionesDeContacto,
  solicitarEnlace,
  verificarEnlace,
  mensaje,
  mensajeWhatsApp,
  listarFuncionesAgente: agentconfig.listar,
  guardarFuncionesAgente: agentconfig.guardar,
};
