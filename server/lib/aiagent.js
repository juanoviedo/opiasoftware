'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const crm = require('./crm');
const H = require('./http');

const { Tabla } = crm;

const RUTA_CONFIG = path.join(config.dataDir, 'ai-config.json');
const COOKIE_AI = 'opia_aiguid';
const VIDA_SESION_DIAS = 90;
// tope de mensajes conservados por conversación (contexto del modelo + pantalla)
const MAX_MSG_SESION = 200;
// tope de mensajes sin registrarse: el agente pide nombre+celular y no se
// puede conversar gratis para siempre (cada mensaje cuesta llamada al modelo)
const MAX_MSG_ANONIMO = 12;
const MAX_MENSAJES_DIA = 500;
const MAX_ITER_HERRAMIENTAS = 4;

// Las dos tablas del agente viven junto a las del CRM (dataDir/crm, volumen).
// aiagentmessages: cada mensaje del chat (rol usuario/ia/herramienta), con
// contactoId como llave foránea: un contacto tiene muchos mensajes (1:N).
// aiagentsessions: una fila por conversación (guid = id), ligada a su contacto.
const mensajes = new Tabla('aiagentmessages.json');
const sesiones = new Tabla('aiagentsessions.json');

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

const PLACEHOLDER = 'Esperando respuesta agente IA';

// Contacto en blanco que se crea apenas alguien abre el agente; cuando la
// persona da nombre y celular, ESTE MISMO registro se actualiza (registrarLead).
function crearContactoPlaceholder() {
  const emp = empresaComodin();
  const { datos, errores } = crm.validarContacto({ clienteId: emp.id, nombres: PLACEHOLDER });
  if (Object.keys(errores).length) {
    throw new Error('contacto placeholder: ' + Object.values(errores).join(' '));
  }
  return crm.contactos.agregar({ id: crm.siguienteId('p'), ...datos, archivoOrigen: 'agente_ia' }, 'aiagent');
}

function nuevaSesion(guid) {
  const contacto = crearContactoPlaceholder();
  return sesiones.agregar(
    { id: guid, estado: 'anonimo', contactoId: contacto.id, clienteId: contacto.clienteId },
    'aiagent'
  );
}

/** Apertura del agente: devuelve la sesión existente del guid o crea una nueva. */
function inicio(guidPropuesto) {
  if (guidPropuesto) {
    const previa = obtenerSesion(guidPropuesto, false);
    if (previa) return { guid: previa.id };
  }
  return { guid: nuevaSesion(crypto.randomBytes(9).toString('base64url')).id };
}

function obtenerSesion(guid, crear) {
  const previa = sesiones.porId(guid);
  if (previa) return previa;
  return crear ? nuevaSesion(guid) : null;
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
      // el contacto placeholder (nunca registrado) se va con la conversación;
      // el de un lead real se conserva para seguimiento comercial
      if (s.estado !== 'lead' && s.contactoId) crm.contactos.eliminar(s.contactoId);
      sesiones.eliminar(s.id);
      cambios += 1;
    }
  }
  return cambios;
}

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
  'Tu PRIMER paso, antes de cualquier otra cosa, es pedirle a la persona su nombre completo y su número de celular. En cuanto te los dé, llama INMEDIATAMENTE a la herramienta registrar_lead con esos datos, sin pedir nada más primero.',
  '',
  'Después de registrarla: ayúdala con lo que necesite sobre software a la medida, páginas web y marketing digital. Si menciona la empresa donde trabaja, usa vincular_empresa. Si menciona necesidades, tiempos o presupuesto, guarda un resumen breve con agregar_nota.',
  '',
  'Reglas:',
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
      description: 'Registra a la persona que chatea como contacto en el CRM. Usar en cuanto dé su nombre y celular.',
      parameters: {
        type: 'object',
        properties: {
          nombres: { type: 'string' },
          apellidos: { type: 'string' },
          celular: { type: 'string' },
        },
        required: ['nombres', 'celular'],
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
      description: 'Guarda en el CRM un resumen breve de algo que la persona mencionó (necesidad, presupuesto, fecha).',
      parameters: {
        type: 'object',
        properties: { texto: { type: 'string' } },
        required: ['texto'],
      },
    },
  },
];

async function llamarModelo(mensajesApi) {
  const c = leerConfig();
  const base = String(c.baseUrl).replace(/\/+$/, '');
  const resp = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.apiKey },
    body: JSON.stringify({
      model: c.model,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...mensajesApi],
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

function registrarLead(s, args) {
  if (s.estado === 'lead' && s.contactoId) {
    return 'El lead ya está registrado en el CRM. No crear duplicados.';
  }
  const nombres = H.clean(args.nombres, 120).trim();
  const apellidos = H.clean(args.apellidos, 120).trim();
  const celular = H.clean(args.celular, 40).trim();
  const digitos = celular.replace(/\D/g, '');
  if (nombres.length < 2 || digitos.length < 7 || digitos.length > 15) {
    return 'Faltan datos válidos: necesito el nombre completo y un celular de 7 a 15 dígitos.';
  }

  // si ese celular ya existe en otro contacto, se usa ese y el placeholder se borra
  const duplicado = crm.contactos
    .todas()
    .find((k) => k.id !== s.contactoId && (k.celular || '').replace(/\D/g, '') === digitos);

  let contacto = crm.contactos.porId(s.contactoId);
  if (duplicado) {
    if (contacto) crm.contactos.eliminar(contacto.id);
    contacto = duplicado;
  }
  if (!contacto) {
    // placeholder perdido (limpieza manual, etc.): se recrea bajo el comodín
    const emp = empresaComodin();
    const { datos, errores } = crm.validarContacto({ clienteId: emp.id, nombres, apellidos, celular });
    if (Object.keys(errores).length) return 'No pude registrar: ' + Object.values(errores).join(' ');
    contacto = crm.contactos.agregar({ id: crm.siguienteId('p'), ...datos, archivoOrigen: 'agente_ia' }, 'aiagent');
  } else {
    crm.contactos.actualizar(contacto.id, { nombres, apellidos, celular }, 'aiagent');
    contacto = crm.contactos.porId(contacto.id);
  }

  s.estado = 'lead';
  s.contactoId = contacto.id;
  s.clienteId = contacto.clienteId;
  guardarSesion(s, 'aiagent');
  return `Lead registrado en el CRM como ${contacto.id}. Continúa la conversación normalmente.`;
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

function ejecutarHerramienta(s, nombre, args) {
  switch (nombre) {
    case 'registrar_lead':
      return registrarLead(s, args);
    case 'vincular_empresa':
      return vincularEmpresa(s, args);
    case 'agregar_nota':
      return agregarNota(s, args);
    default:
      return 'Herramienta desconocida.';
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
          resultado = ejecutarHerramienta(s, tc.function.name, JSON.parse(tc.function.arguments || '{}'));
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
async function mensaje(guidPropuesto, texto) {
  if (!configurado()) return { error: 'El agente de IA no está configurado todavía.', status: 503 };

  let s;
  if (guidPropuesto) {
    s = obtenerSesion(guidPropuesto, true);
  } else {
    s = nuevaSesion(crypto.randomBytes(9).toString('base64url'));
  }

  const avisoRegistro =
    'Para seguir conversando necesito tu nombre completo y tu número de celular. Con eso te registro y continuamos.';

  // sin lead registrado solo hay paciencia limitada: se cobra nombre y celular
  if (s.estado !== 'lead') {
    const escritos = mensajes.todas().filter((m) => m.guid === s.id && m.rol === 'usuario').length;
    if (escritos >= MAX_MSG_ANONIMO) {
      agregarMsg(s, { rol: 'usuario', texto }, 'visitante');
      agregarMsg(s, { rol: 'ia', texto: avisoRegistro }, 'aiagent');
      return { guid: s.id, texto: avisoRegistro, leadRegistrado: false };
    }
  }

  if (!topeDiarioOk()) {
    return {
      guid: s.id,
      texto: 'Hoy recibí muchos mensajes y necesito un descanso. Escríbenos mañana o déjanos tus datos en la página de contacto.',
      leadRegistrado: false,
    };
  }

  const eraAnonima = s.estado !== 'lead';
  try {
    const respuesta = await responder(s, texto);
    return { guid: s.id, texto: respuesta, leadRegistrado: eraAnonima && s.estado === 'lead' };
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
  inicio,
  mensaje,
};
