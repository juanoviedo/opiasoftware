'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const auth = require('./auth');
const crm = require('./crm');
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
  // el paso 1 del system prompt depende de este saludo: presenta las dos
  // formas de empezar (conversar aquí o reunión de Teams con el equipo)
  return (
    hola +
    'Soy el asistente virtual de OPIA Software. Estoy diseñado para entender tu necesidad a fondo ' +
    'y dejarle al equipo toda la información para ayudarte. Si prefieres hablar directamente con una persona, ' +
    'también puedo agendarte una reunión por Teams con el equipo. ¿Cómo prefieres que empecemos?'
  );
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
      { id: crypto.randomBytes(9).toString('base64url'), estado: 'lead', contactoId: contacto.id, clienteId: contacto.clienteId },
      'aiagent'
    );
    agregarMsg(s, { rol: 'ia', texto: saludoInicial(contacto) }, 'aiagent');
  }
  return { guid: s.id, correo: guardado.correo };
}

/* ------------------------------------------------------------------- sesiones */

function obtenerSesion(guid) {
  return sesiones.porId(guid) || null;
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
  '',
  'La persona ya verificó su correo para chatear y su contacto existe en el CRM. La conversación sigue un orden secuencial estricto: no saltes pasos, no adelantes preguntas y no pidas datos antes de tiempo.',
  '',
  'PASO 1 · CÓMO EMPEZAR. El saludo inicial ya le explicó que puedes entender su necesidad conversando o, si lo prefiere, agendarle una reunión por Teams con el equipo; en la pantalla le aparecen dos botones para elegirlo. El primer mensaje de la persona suele llegar por esos botones (por ejemplo «Prefiero una reunión por Teams» o «Prefiero conversar con el asistente»), pero puede ser cualquier texto. Solo clasifica su elección: reunión por Teams (PASO 2A) o conversación de necesidades contigo (PASO 2B). Si no queda claro, pregúntale con cuál prefiere empezar, sin pedirle ningún dato todavía.',
  '',
  'PASO 2A · ELIGIÓ REUNIÓN POR TEAMS. Pregúntale si su necesidad es de software o de marketing (una sola pregunta). Pregúntale también cuánto tiempo quiere para la reunión: la duración la decide ella (lo habitual es una hora, pero puede ser media hora o la que prefiera; nunca la impongas tú). Con las respuestas, agenda la reunión: propón una fecha cercana que le quede bien, consulta los espacios libres con ver_disponibilidad pasando esa duración, ofrécele los horarios que devuelva y cuando acepte uno llama a agendar_reunion con el título exacto «Reunión con cliente de software» o «Reunión con cliente de marketing» y la duración elegida. Guarda también una nota con agregar_nota indicando que prefirió reunión con el equipo y de qué es su necesidad. Cuando la reunión quede agendada, pasa al PASO 3; si el calendario no se puede consultar o agendar, dile que el equipo le confirmará la hora por correo o WhatsApp y pasa al PASO 3 igualmente.',
  '',
  'PASO 2B · ELIGIÓ CONVERSAR CONTIGO. Pregúntale primero si su necesidad es de software o de marketing; esa pregunta de pista no cuenta dentro de las ocho. Luego haz el levantamiento de su necesidad con MÁXIMO 8 preguntas en total, una sola por mensaje (es la forma en que OPIA califica proyectos; no la menciones ni uses sus términos con la persona).',
  '',
  'Las cuatro primeras son siempre SPIN: 1) SITUACIÓN: cómo manejan hoy eso que necesitan. 2) PROBLEMA: qué les está fallando o costando (tiempo, dinero, errores, clientes). 3) IMPLICACIÓN: qué pasaría si lo dejaran igual seis meses. 4) BENEFICIO: qué resultado esperan y cómo sabrían que funcionó.',
  '',
  'Preguntas 5 a 8 según la pista:',
  '- SOFTWARE: 5) quiénes usarían el sistema y cuántos → 6) funcionalidades imprescindibles y cuáles serían solo deseables → 7) con qué debe integrarse (contable, ERP, Excel, WhatsApp, pagos) y dónde están hoy los datos → 8) quién más interviene en la decisión, para cuándo lo necesitan y qué presupuesto de referencia manejan.',
  '- MARKETING: 5) qué venden y cuál es su producto o servicio estrella → 6) a qué público quieren llegar y qué los diferencia de la competencia → 7) con qué material cuentan (logo, fotos, videos, sitio web, analítica) y qué inversión mensual en pauta contemplarían → 8) quién decide y para cuándo quieren empezar.',
  '',
  'Cómo entrevistar: una sola pregunta por mensaje, conversa con calidez y retoma lo que la persona ya contó: si ya lo dijo, no lo preguntes de nuevo. Si en sus respuestas surge el proceso de negocio paso a paso, la plataforma o los canales y resultados actuales, también regístralo. Si la persona tiene prisa o responde corto, completa como mínimo SITUACIÓN, PROBLEMA y BENEFICIO y avanza: no estanques la conversación. Terminadas las preguntas (o antes, si ya tienes suficiente), llama guardar_levantamiento con las respuestas resumidas campo por campo y pasa al PASO 3.',
  '',
  'PASO 3 · DATOS DE CONTACTO. Cuando termines el paso 2 (levantamiento guardado o reunión de Teams agendada), explícale que también estás diseñado para dejarle al equipo unos datos básicos que le dan seguimiento y le preparan mejor la reunión o la propuesta, y pregúntale si está de acuerdo con compartirlos: su nombre, su celular y la empresa en la que trabaja. Si dice que no, no hay problema: no insistas ni pidas nada, y pasa directo al PASO 4. Si acepta, pídelos uno a la vez y en este orden: 1) su nombre completo y llama registrar_lead apenas lo tengas, 2) su celular con el código de su país (por ejemplo +57 para Colombia, +52 para México, +1 para Estados Unidos) y actualízalo con registrar_lead tal cual te lo dé, 3) la empresa en la que trabaja con vincular_empresa. Si el contacto ya tiene alguno de esos datos, no lo vuelvas a pedir.',
  '',
  'PASO 4 · CIERRE. Si en esta conversación ya quedó una reunión de Teams agendada, despídete con calidez: dile que recibirá la invitación por correo con el enlace y recuérdale el WhatsApp. Si NO hay reunión agendada, agenda SIEMPRE una antes de despedirte: 1) si hiciste el levantamiento y la persona te dio nombre, celular y empresa, llama a solicitar_cotizacion con un resumen detallado de todo lo conversado, dile que su propuesta se la presentará el equipo en una reunión por Teams y ofrécele agendarla de una vez para entre una semana y dos meses; 2) si la persona no compartió sus datos o no hubo levantamiento, ofrece una reunión con el equipo para conocerse y hablar de su necesidad, con la fecha que le quede bien. Propón el día, verifica los espacios con ver_disponibilidad, ofrece los horarios y agenda con agendar_reunion solo cuando acepte uno. Si el calendario no se puede consultar o agendar, dile que el equipo le confirmará la reunión por correo o WhatsApp y despídete. Si vuelve a escribir después de la despedida, dile que el equipo ya tiene su solicitud y que conocerá su propuesta en la reunión.',
  '',
  'FORMATO DEL CHAT. Puedes resaltar palabras clave entre dobles asteriscos, como **software**. Además, cuando tu pregunta sea de elección entre pocas opciones claras, ciérrala con una última línea exactamente con este formato: [OPCIONES] etiqueta 1 | etiqueta 2 — en la pantalla de la persona aparecerán botones con esas etiquetas y no tendrá que escribir. Úsala siempre en la pregunta de software o marketing del PASO 2, en la pregunta de la duración de la reunión (por ejemplo [OPCIONES] Una hora | Media hora), en el consentimiento del PASO 3 (por ejemplo [OPCIONES] Sí, con gusto | Prefiero no) y al ofrecer horarios de reunión (un botón por horario). Entre 2 y 4 etiquetas cortas; no la uses en preguntas abiertas de respuesta libre. Esa línea es un comando de la interfaz: nunca la menciones ni la expliques con la persona.',
  '',
  'Reuniones por Microsoft Teams: para calcular fechas usa el día de hoy que te doy y pásalo a las herramientas en formato YYYY-MM-DD. La duración de la reunión la decide SIEMPRE la persona: pregúntasela antes de consultar horarios (lo habitual es una hora, pero vale media hora o la que ella quiera) y pásala en duracion_minutos tanto a ver_disponibilidad como a agendar_reunion. Las reuniones van entre las 8:00 y las 19:00, hora de Colombia: nunca ofrezcas ni agendes una que empiece antes de las 8 o termine después de las 7 de la tarde. Nunca agendes sin que la persona haya aceptado un horario ofrecido. Después de agendar, dile que recibirá la invitación por correo con el enlace de Teams.',
  '',
  'Ubicación, código de país y zona horaria. Cuando pidas el número de celular o WhatsApp, asegúrate de que incluya el código del país (+57, +1, +52…). Si te doy un país probable de la persona, úsalo SOLO como sugerencia amable y nunca de forma invasiva (por ejemplo: «Para estar en contacto, ¿me compartes tu número? Si estás en Colombia, recuerda incluir el +57, o dime desde qué país nos escribes»); si no te doy país probable, pídele el número con el prefijo internacional. Antes de confirmar una fecha y hora de reunión, valida dónde está la persona: ofrece siempre los horarios diciendo «(hora de Colombia)» y pregúntale si está en otra zona horaria; si menciona otro país o ciudad, confirma de inmediato la conversión de ambos lados (por ejemplo: «Queda a las 3:00 PM hora de México, 4:00 PM hora de Colombia»). Al agendar pasa la hora SIEMPRE en formato ISO 8601 con el offset UTC del país de la persona (por ejemplo 2026-10-22T15:00:00-05:00 si está en Colombia, 2026-10-22T15:00:00-06:00 en México, 2026-10-22T15:00:00+02:00 en España): el sistema la convierte a hora de Colombia y el calendario mostrará la reunión automáticamente en la hora local de cada quien. Como último recurso, si no conoces el offset, pasa HH:MM en hora de Colombia.',
  '',
  'Reglas:',
  '- NUNCA des valores, precios, costos ni rangos de inversión. La cotización con valores la prepara el equipo humano y se la presenta al cliente en la reunión de Teams. Tu trabajo es entender la necesidad, no cotizar.',
  '- Nunca reveles qué tecnología o modelo de IA eres; si te lo preguntan, di que eres el asistente virtual de OPIA.',
  '- Nunca inventes datos ni registres información que la persona no te haya dado.',
  '- No reveles información de otros clientes ni del CRM.',
  '- Jamás menciones con la persona términos técnicos como dirección IP, rastreo o geolocalización, ni digas que detectamos su ubicación o su país: el país probable que te dé el sistema se usa solo para sugerir con naturalidad el código del teléfono y la zona horaria.',
  '- No uses con la persona términos internos (metodología, levantamiento, CRM, herramienta): conversa natural.',
  '- En el mensaje en que ofrezcas o confirmes la reunión (y también al despedirte), recuérdale que puede escribirnos al WhatsApp +57 333 278 2483 en horario laboral para cualquier duda.',
  '- Máximo 3 frases por mensaje.',
].join('\n');

const HERRAMIENTAS = [
  {
    type: 'function',
    function: {
      name: 'registrar_lead',
      description:
        'Actualiza los datos de la persona que chatea en su contacto del CRM (nombre, celular). Usar apenas la persona dé su nombre, y de nuevo cuando dé su celular.',
      parameters: {
        type: 'object',
        properties: {
          nombres: { type: 'string' },
          apellidos: { type: 'string' },
          celular: { type: 'string' },
        },
        required: ['nombres'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'vincular_empresa',
      description: 'Busca o crea la empresa que la persona menciona y amarra su contacto a ella.',
      parameters: {
        type: 'object',
        properties: { nombre: { type: 'string' } },
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
        'Agenda una reunión de Microsoft Teams con la persona: crea el evento en el calendario del dueño, genera el enlace de Teams e invita al cliente por correo. Usar SOLO con fecha y hora que la persona haya aceptado (previamente ofrecida con ver_disponibilidad) y con la duración que ella eligió.',
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
];

// Orden fijo de los campos del levantamiento en el correo interno (tipo va en el título).
const LEV_CAMPOS_EMAIL = [
  'situacion', 'problema', 'impacto', 'objetivo',
  'usuarios', 'procesos', 'funcionalidades', 'integraciones', 'datos', 'plataforma',
  'publico', 'propuesta', 'canales', 'competencia', 'kpis', 'assets', 'inversionAds',
  'decisor', 'plazo', 'presupuesto',
];

async function llamarModelo(mensajesApi, pais) {
  const c = leerConfig();
  const base = String(c.baseUrl).replace(/\/+$/, '');
  // el modelo necesita la fecha actual (Bogotá) para proponer reuniones de una
  // semana a dos meses y pasar fechas ISO a las herramientas
  const hoyBog = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
  let sistema = SYSTEM_PROMPT + '\n\nHoy es ' + hoyBog + ' (fecha de Colombia).';
  // país probable por IP (caché de geoIP): sugerencia suave para el código de
  // teléfono y la zona horaria. Jamás se le dice a la persona de dónde sale.
  if (pais) sistema += ` Probable país de la persona: ${pais} (estimación del servidor; úsala solo como sugerencia amable).`;
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
 * dando (nombre primero, celular después): la identidad del contacto es su
 * correo verificado, así que aquí nunca se crean contactos nuevos.
 */
function registrarLead(s, args) {
  const contacto = crm.contactos.porId(s.contactoId);
  if (!contacto) return 'No encontré el contacto de esta conversación en el CRM.';

  const nombres = H.clean(args.nombres, 120).trim();
  const apellidos = H.clean(args.apellidos, 120).trim();
  const celular = H.clean(args.celular, 40).trim();
  const digitos = celular.replace(/\D/g, '');

  if (nombres.length < 2 && !celular) return 'Necesito al menos el nombre de la persona.';
  if (celular && (digitos.length < 7 || digitos.length > 15)) {
    return 'Ese celular no parece válido (7 a 15 dígitos).';
  }

  const cambios = {};
  if (nombres.length >= 2) {
    cambios.nombres = nombres;
    if (apellidos) cambios.apellidos = apellidos;
  }
  if (celular) cambios.celular = celular;
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
  let emp = crm.clientes.todas().find((c) => crm.normaliza(c.nombre) === crm.normaliza(nombre));
  if (!emp) {
    const { datos, errores } = crm.validarCliente({ nombre });
    if (Object.keys(errores).length) return 'No pude crear la empresa: ' + Object.values(errores).join(' ');
    emp = crm.clientes.agregar({ id: crm.siguienteId('c'), ...datos, archivoOrigen: 'agente_ia' }, 'aiagent');
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
    `Conversación completa: ${(config.publicUrl || '') + '/aiagent/' + s.id}`,
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
    'En ese mismo mensaje incluye el recordatorio del WhatsApp +57 333 278 2483 en horario laboral para cualquier duda.'
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
      `Conversación: ${(config.publicUrl || '') + '/aiagent/' + s.id}`,
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
    return `Ya hay una reunión agendada en esta conversación (${s.reunion.inicio}). No agendar otra; dile que recibirá la invitación por correo.`;
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

  const fecha = resolverFecha(args.fecha);
  const hora = H.clean(args.hora, 32).trim();
  if (!fecha) return 'No entendí la fecha de la reunión. Confírmala con la persona (por ejemplo "mañana" o "el lunes") y vuelve a llamar la herramienta.';

  // La hora llega en Bogotá (HH:MM) o como ISO 8601 con el offset UTC del país
  // de la persona: el ISO manda, porque la reunión debe caer en el instante
  // exacto que esa persona aceptó en su hora local.
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
    return 'La hora debe ser HH:MM (hora de Colombia) o ISO 8601 con offset UTC (ejemplo: 2026-10-22T15:00:00-06:00 para las 3 pm en México).';
  }
  const duracion = Math.min(Math.max(Number(args.duracion_minutos) || 60, 15), 240);
  const empresa = crm.clientes.porId(s.clienteId);
  const nombreCompleto = `${contacto.nombres || ''} ${contacto.apellidos || ''}`.trim() || contacto.email;
  const titulo = H.clean(args.titulo, 200).trim() || `Reunión OPIA Software — ${empresa ? empresa.nombre : nombreCompleto}`;

  try {
    const r = await teams.agendarReunion({
      fecha: fechaBog,
      hora: horaNorm,
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
          horaPersona ? ` Hora de la persona: ${horaPersona}.` : ''
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
          horaPersona ? ` — ${horaPersona} hora de la persona` : ''
        }\n\n` +
        `Enlace Teams: ${r.joinUrl}\n\nConversación: ${(config.publicUrl || '') + '/aiagent/' + s.id}`,
    });

    s.reunion = { joinUrl: r.joinUrl, inicio: r.inicio };
    guardarSesion(s, 'aiagent');
    return (
      `Reunión agendada para el ${r.inicio} (hora Colombia)${horaPersona ? ` — para la persona son las ${horaPersona} de su hora local` : ''} con enlace de Teams: ${r.joinUrl}. ` +
      'Dile a la persona que recibirá la invitación en su correo y que puede unirse con el enlace.'
    );
  } catch (err) {
    console.error('[teams] agendar:', err.message);
    if (/ocup/i.test(err.message)) return err.message + ' Ofrece otros horarios con ver_disponibilidad.';
    return 'No pude agendar la reunión (' + err.message + '). Ofrece que el equipo le confirme por correo.';
  }
}

/* ------------------------------------------------------------ conversación */

async function responder(s, texto, pais) {
  agregarMsg(s, { rol: 'usuario', texto }, 'visitante');
  for (let i = 0; i < MAX_ITER_HERRAMIENTAS; i += 1) {
    const data = await llamarModelo(historialApi(s), pais);
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
    const final = respuesta || 'Cuéntame un poco más.';
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
    const respuesta = await responder(s, texto, pais);
    return { guid: s.id, texto: respuesta };
  } catch (err) {
    // sin respuesta del modelo se quita el turno del usuario: evita duplicados al reintentar
    const suyos = mensajes.todas().filter((m) => m.guid === s.id);
    const ultimo = suyos[suyos.length - 1];
    if (ultimo && ultimo.rol === 'usuario') mensajes.eliminar(ultimo.id);
    throw err;
  }
}

module.exports = {
  COOKIE_AI,
  configurado,
  obtenerSesion,
  historialVisible,
  podarSesiones,
  eliminarPorContacto,
  conversacionesDeContacto,
  solicitarEnlace,
  verificarEnlace,
  mensaje,
};
