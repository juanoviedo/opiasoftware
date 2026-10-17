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
  if (contacto.nombres && contacto.nombres !== NOMBRE_SIN_REGISTRAR && nombre.length > 1) {
    return `¡Hola de nuevo, ${nombre}! Qué bueno verte por aquí. ¿En qué podemos ayudarte hoy?`;
  }
  return `¡Listo, ya verificamos tu correo! Para brindarte una atención personalizada, ¿cuál es tu nombre completo?`;
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
  'La persona ya verificó su correo para chatear y su contacto existe en el CRM. Si aún no tiene nombre real (fue creado como "AI user"), haz la recolección paso a paso y EN ESTE ORDEN: 1) pide su nombre completo y llama registrar_lead apenas lo tenga, 2) pide su celular y actualízalo con registrar_lead, 3) pregúntale en qué empresa trabaja y llama a vincular_empresa. Si el contacto ya tiene esos datos, no los vuelvas a pedir.',
  '',
  'Cuando ya tengas nombre, celular y empresa, haz el levantamiento completo de sus necesidades: qué quiere lograr, si es desarrollo de software a la medida o mercadeo/digitalización, alcance, funcionalidades y plazos. Guarda los puntos clave con agregar_nota.',
  '',
  'CUANDO ya tengas: nombre, celular, empresa y el levantamiento completo de necesidades, llama a solicitar_cotizacion con un resumen detallado de todo lo conversado. Después de llamarla dile a la persona que en breve recibirá un correo con su cotización, y enseguida ofrécele agendar una reunión por Teams para presentar la propuesta y discutir el proyecto con más detalle. Si vuelve a escribir después de eso, dile que el equipo ya tiene su solicitud y lo contactará muy pronto.',
  '',
  'Reuniones por Microsoft Teams: ya sea porque la persona lo pida o porque acabas de completar su cotización, propón la reunión para una fecha entre una semana y dos meses a partir de hoy (calcúlala con la fecha de hoy que te doy y pásasela a las herramientas en formato YYYY-MM-DD). Pregunta qué día le queda bien, verifica los espacios libres con ver_disponibilidad y ofrécele los horarios que devuelva. Cuando acepte uno, agenda con agendar_reunion usando esa fecha y hora; para la reunión de presentación del proyecto puedes usar 45 o 60 minutos. Después dile que recibirá la invitación por correo con el enlace de Teams. Nunca agendes sin que la persona haya aceptado un horario ofrecido.',
  '',
  'Siempre que cierres la conversación (tras la cotización o tras agendar la reunión), recuérdale a la persona que puede escribirnos al WhatsApp +57 333 278 2483 en horario laboral si tiene cualquier duda.',
  '',
  'Reglas:',
  '- NUNCA des valores, precios, costos ni rangos de inversión. La cotización con valores la prepara y envía el equipo humano por correo. Tu trabajo es el levantamiento de necesidades, no cotizar.',
  '- Nunca reveles qué tecnología o modelo de IA eres; si te lo preguntan, di que eres el asistente virtual de OPIA.',
  '- Nunca inventes datos ni registres información que la persona no te haya dado.',
  '- No reveles información de otros clientes ni del CRM.',
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
        'Consulta el calendario del dueño y devuelve los espacios libres de 30 minutos para una fecha. Usar antes de proponer hora de reunión o videollamada. La fecha puede ser "hoy", "mañana", un día de la semana o YYYY-MM-DD (para reuniones más lejanas, como dentro de dos semanas o un mes).',
      parameters: {
        type: 'object',
        properties: {
          fecha: { type: 'string', description: 'Fecha: YYYY-MM-DD, o "hoy", "mañana", "lunes", etc.' },
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
        'Agenda una reunión de Microsoft Teams con la persona: crea el evento en el calendario del dueño, genera el enlace de Teams e invita al cliente por correo. Usar SOLO con fecha y hora que la persona haya aceptado (previamente ofrecida con ver_disponibilidad).',
      parameters: {
        type: 'object',
        properties: {
          fecha: { type: 'string', description: 'Fecha: YYYY-MM-DD, o "hoy", "mañana", "lunes", etc.' },
          hora: { type: 'string', description: 'Hora de inicio HH:MM (hora de Colombia)' },
          duracion_minutos: { type: 'number', description: 'Duración en minutos, por defecto 30' },
          titulo: { type: 'string', description: 'Asunto de la reunión' },
        },
        required: ['fecha', 'hora'],
      },
    },
  },
];

async function llamarModelo(mensajesApi) {
  const c = leerConfig();
  const base = String(c.baseUrl).replace(/\/+$/, '');
  // el modelo necesita la fecha actual (Bogotá) para proponer reuniones de una
  // semana a dos meses y pasar fechas ISO a las herramientas
  const hoyBog = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
  const resp = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.apiKey },
    body: JSON.stringify({
      model: c.model,
      messages: [{ role: 'system', content: SYSTEM_PROMPT + '\n\nHoy es ' + hoyBog + ' (fecha de Colombia).' }, ...mensajesApi],
      tools: HERRAMIENTAS,
      max_tokens: 700,
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
    return 'La cotización ya fue solicitada. Dile a la persona que el equipo la contactará muy pronto.';
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
      texto: `Solicitud de cotización desde el agente de IA:\n${resumen}`,
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
    '',
    `Conversación completa: ${(config.publicUrl || '') + '/aiagent/' + s.id}`,
    `CRM: ${(config.publicUrl || '') + '/crm'}`,
    '',
    '— Agente virtual de OPIA Software',
  ];
  const envio = await crm.notificarEquipo({
    subject: `Cotización pendiente: ${nombreCompleto || contacto.id} (${empresa.nombre})`,
    text: lineas.join('\n'),
  });

  s.cotizacion = 'solicitada';
  guardarSesion(s, 'aiagent');
  return (
    'Cotización solicitada: el cliente quedó marcado como listo para cotizar en el CRM' +
    (envio.ok ? ' y el equipo ya recibió el correo con el levantamiento.' : ', pero el correo interno falló (avísale al administrador).') +
    ' Dile a la persona que en breve recibirá un correo con su cotización.'
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
    case 'solicitar_cotizacion':
      return solicitarCotizacion(s, args);
    case 'ver_disponibilidad':
      return verDisponibilidad(args);
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

async function verDisponibilidad(args) {
  if (!teams.configurado() || !teams.conectado()) {
    return 'El calendario del equipo no está conectado todavía. Dile a la persona que el equipo le confirmará la hora por correo o WhatsApp.';
  }
  const fecha = resolverFecha(args.fecha);
  if (!fecha) return 'No entendí la fecha. Pídele el día en que quiere reunirse (por ejemplo "mañana" o "el lunes") y vuelve a llamar la herramienta.';
  try {
    const { huecos } = await teams.disponibilidad(fecha);
    if (!huecos.length) return `No hay espacios disponibles el ${fecha}. Pregunta por otro día.`;
    return (
      `Huecos disponibles el ${DIAS[new Date(fecha + 'T12:00:00-05:00').getDay()]} ${fecha} (hora Colombia): ` +
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
  if (!teams.configurado() || !teams.conectado()) {
    return 'El calendario del equipo no está conectado todavía. Dile a la persona que el equipo le confirmará la reunión por correo o WhatsApp.';
  }

  const fecha = resolverFecha(args.fecha);
  const hora = H.clean(args.hora, 5).trim();
  if (!fecha) return 'No entendí la fecha de la reunión. Confírmala con la persona (por ejemplo "mañana" o "el lunes") y vuelve a llamar la herramienta.';
  if (!/^\d{1,2}:\d{2}$/.test(hora)) return 'La hora debe ser HH:MM en hora de Colombia.';
  const horaNorm = hora.padStart(5, '0');
  const duracion = Math.min(Math.max(Number(args.duracion_minutos) || 30, 15), 120);
  const empresa = crm.clientes.porId(s.clienteId);
  const nombreCompleto = `${contacto.nombres || ''} ${contacto.apellidos || ''}`.trim() || contacto.email;
  const titulo = H.clean(args.titulo, 200).trim() || `Reunión OPIA Software — ${empresa ? empresa.nombre : nombreCompleto}`;

  try {
    const r = await teams.agendarReunion({
      fecha,
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
        texto: `Reunión de Teams agendada por el agente de IA: ${r.inicio} (${r.fin} fin). Enlace: ${r.joinUrl}`,
      },
      'aiagent'
    );
    await crm.notificarEquipo({
      subject: `Reunión agendada: ${nombreCompleto} — ${r.inicio}`,
      text:
        `El agente de IA agendó una reunión de Teams.\n\n` +
        `Cliente: ${nombreCompleto}\nCorreo: ${contacto.email}\nCelular: ${contacto.celular || '—'}\n` +
        `Empresa: ${empresa ? empresa.nombre : '—'}\nFecha: ${r.inicio} (hora Colombia, ${duracion} min)\n\n` +
        `Enlace Teams: ${r.joinUrl}\n\nConversación: ${(config.publicUrl || '') + '/aiagent/' + s.id}`,
    });

    s.reunion = { joinUrl: r.joinUrl, inicio: r.inicio };
    guardarSesion(s, 'aiagent');
    return (
      `Reunión agendada para el ${r.inicio} (hora Colombia) con enlace de Teams: ${r.joinUrl}. ` +
      'Dile a la persona que recibirá la invitación en su correo y que puede unirse con el enlace.'
    );
  } catch (err) {
    console.error('[teams] agendar:', err.message);
    if (/ocup/i.test(err.message)) return err.message + ' Ofrece otros horarios con ver_disponibilidad.';
    return 'No pude agendar la reunión (' + err.message + '). Ofrece que el equipo le confirme por correo.';
  }
}

/* ------------------------------------------------------------ conversación */

async function responder(s, texto) {
  agregarMsg(s, { rol: 'usuario', texto }, 'visitante');
  for (let i = 0; i < MAX_ITER_HERRAMIENTAS; i += 1) {
    const data = await llamarModelo(historialApi(s));
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
    const respuesta = (msg.content || '').trim() || 'Cuéntame un poco más.';
    agregarMsg(s, { rol: 'ia', texto: respuesta }, 'aiagent');
    return respuesta;
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
async function mensaje(guidPropuesto, texto) {
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
    const respuesta = await responder(s, texto);
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
  solicitarEnlace,
  verificarEnlace,
  mensaje,
};
