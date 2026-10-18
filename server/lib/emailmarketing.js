'use strict';

const dns = require('node:dns').promises;

const config = require('./config');
const auth = require('./auth');
const crm = require('./crm');
const { quitarEtiquetas } = require('./mail');

// Office365 rechaza más de ~30 mensajes por minuto por SMTP AUTH: la pausa
// mantiene la campaña justo por debajo del tope.
const PAUSA_MS = 2100;
const MAX_DESTINATARIOS = 500;
const PIXEL_DIAS = 365;

const envios = new crm.Tabla('envios.json');

/* Píxel de 1x1: cuando el cliente de correo del destinatario la descarga,
   sabemos que el correo llegó a un buzón real. */
const PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

function pixelToken(contactoId, envioId) {
  return auth.sign({ t: 'em', c: contactoId, e: envioId, exp: Date.now() + PIXEL_DIAS * 86_400_000 });
}

function plantillaHtml(cuerpo, token) {
  const base = (config.publicUrl || `http://localhost:${config.port}`).replace(/\/+$/, '');
  return (
    '<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f9">' +
    '<div style="max-width:600px;margin:0 auto;padding:28px 22px;background:#ffffff;' +
    'font-family:Arial,Helvetica,sans-serif;color:#1a2b3c;font-size:15px;line-height:1.6">' +
    cuerpo +
    '</div>' +
    '<div style="max-width:600px;margin:0 auto;padding:14px 20px;font-family:Arial,Helvetica,sans-serif;' +
    'font-size:11px;color:#8a97a5;text-align:center">OPIA Software · opiasoftware.com</div>' +
    `<img src="${base}/api/em/pixel/${encodeURIComponent(token)}.gif" width="1" height="1" alt="" style="display:block;border:0" />` +
    '</body></html>'
  );
}

// Solo señales inequívocas de buzón inexistente: un 550 por antispam o un
// problema temporal no debe marcar el contacto como "no existe".
const SIN_BUZON =
  /5\.1\.[01]|user unknown|unknown recipient|recipient address rejected|no such (user|recipient|address)|invalid recipient|address does not exist|mailbox (unavailable|not found)/i;

function clasificarError(mensaje) {
  return SIN_BUZON.test(String(mensaje)) ? 'no_existe' : 'error';
}

async function dominioExiste(email) {
  const dominio = String(email).split('@')[1] || '';
  if (!dominio) return false;
  try {
    const mx = await dns.resolveMx(dominio);
    if (mx && mx.length) return true;
  } catch {
    // sin MX se prueba el registro A (RFC 5321 admite ese caso)
  }
  try {
    const a = await dns.resolve4(dominio);
    return Boolean(a && a.length);
  } catch {
    return false;
  }
}

function marcarContacto(contactoId, estado) {
  crm.contactos.actualizar(contactoId, { emailmarketing_status: estado }, 'emailmarketing');
}

/* ----------------------------------------------------------- campañas */

let enCurso = null; // id del envío que se está mandando
const canceladas = new Set();

function crearEnvio({ asunto, cuerpoHtml, contactoIds, de }, actor) {
  const titulo = String(asunto || '').trim();
  const cuerpo = String(cuerpoHtml || '').trim();
  if (titulo.length < 2) return { error: 'Escribe el asunto del correo.' };
  if (cuerpo.length < 2) return { error: 'Escribe el cuerpo del correo.' };
  if (enCurso) return { error: 'Ya hay una campaña enviándose. Espera a que termine o cancélala.' };
  const remitente = String(de || '').toLowerCase().trim();
  if (remitente && !crm.remitentesCorreo().some((r) => r.valor === remitente)) {
    return { error: 'Ese remitente no está permitido.' };
  }
  const ids = [...new Set((Array.isArray(contactoIds) ? contactoIds : []).map(String))];
  if (!ids.length) return { error: 'Selecciona al menos un contacto.' };
  if (ids.length > MAX_DESTINATARIOS) return { error: `Máximo ${MAX_DESTINATARIOS} destinatarios por campaña.` };

  const vistos = new Set();
  const destinatarios = [];
  for (const id of ids) {
    const contacto = crm.contactos.porId(id);
    if (!contacto) return { error: `El contacto ${id} no existe.` };
    const email = String(contacto.email || '').toLowerCase().trim();
    if (!email) {
      destinatarios.push({ contactoId: id, email: '', estado: 'omitido', detalle: 'sin correo principal' });
      continue;
    }
    if (vistos.has(email)) {
      destinatarios.push({ contactoId: id, email, estado: 'omitido', detalle: 'correo repetido en la lista' });
      continue;
    }
    vistos.add(email);
    destinatarios.push({ contactoId: id, email, estado: 'pendiente', detalle: '' });
  }
  const utiles = destinatarios.filter((d) => d.estado === 'pendiente');
  if (!utiles.length) return { error: 'Ninguno de los contactos seleccionados tiene correo principal.' };

  const fila = {
    id: crm.siguienteId('e'),
    asunto: titulo,
    de: remitente || undefined,
    html: cuerpo,
    texto: quitarEtiquetas(cuerpo),
    estado: 'pendiente',
    destinatarios,
  };
  envios.agregar(fila, actor);
  enCurso = fila.id;
  enviarTodo(fila.id).catch((err) => {
    console.error('[emailmarketing] campaña', fila.id, err.message);
    enCurso = null;
  });
  return { envio: envios.porId(fila.id) };
}

async function enviarTodo(envioId) {
  const envio = envios.porId(envioId);
  if (!envio) return;
  envios.actualizar(envioId, { estado: 'en_curso' }, 'emailmarketing');
  try {
    for (const d of envio.destinatarios) {
      if (d.estado !== 'pendiente') continue;
      if (canceladas.has(envioId)) {
        d.estado = 'omitido';
        d.detalle = 'campaña cancelada';
        continue;
      }
      const contacto = crm.contactos.porId(d.contactoId);
      if (!contacto || String(contacto.email || '').toLowerCase().trim() !== d.email) {
        d.estado = 'omitido';
        d.detalle = 'el contacto cambió o se borró';
      } else if (!(await dominioExiste(d.email))) {
        d.estado = 'no_existe';
        d.detalle = 'el dominio del correo no existe o no recibe mensajes';
        marcarContacto(d.contactoId, 'no_existe');
      } else {
        const r = await crm.enviarCorreo({
          to: d.email,
          subject: envio.asunto,
          html: plantillaHtml(envio.html, pixelToken(d.contactoId, envioId)),
          de: envio.de,
        });
        if (r.ok) {
          d.estado = 'enviado';
          marcarContacto(d.contactoId, 'enviado');
        } else {
          d.estado = clasificarError(r.error);
          d.detalle = String(r.error || '').slice(0, 200);
          marcarContacto(d.contactoId, d.estado);
        }
      }
      envios.actualizar(envioId, { destinatarios: envio.destinatarios }, 'emailmarketing');
      if (!canceladas.has(envioId)) await new Promise((r) => setTimeout(r, PAUSA_MS));
    }
  } finally {
    const estadoFinal = canceladas.has(envioId) ? 'cancelada' : 'terminada';
    canceladas.delete(envioId);
    if (enCurso === envioId) enCurso = null;
    envios.actualizar(envioId, { estado: estadoFinal }, 'emailmarketing');
  }
}

function cancelarEnvio(envioId) {
  const envio = envios.porId(envioId);
  if (!envio) return { error: 'Campaña no encontrada.' };
  if (enCurso !== envioId) return { error: 'Esa campaña ya terminó.' };
  canceladas.add(envioId);
  return { ok: true };
}

/* La cola vive en memoria: si el servidor se apaga a mitad de campaña, la
   marca como interrumpida para que la interfaz no espere para siempre. */
function recuperarInterrumpidas() {
  for (const e of envios.todas()) {
    if (e.estado === 'en_curso' || e.estado === 'pendiente') {
      envios.actualizar(e.id, { estado: 'interrumpida' }, 'emailmarketing');
    }
  }
}
recuperarInterrumpidas();

/* ---------------------------------------------------------- consultas */

function contadores(destinatarios) {
  const c = {};
  for (const d of destinatarios) c[d.estado] = (c[d.estado] || 0) + 1;
  return c;
}

/** Lista resumida (sin el cuerpo del correo) para el historial. */
function listarEnvios() {
  return envios
    .todas()
    .slice()
    .sort((a, b) => String(b.createdon || '').localeCompare(String(a.createdon || '')))
    .slice(0, 30)
    .map((e) => ({
      id: e.id,
      asunto: e.asunto,
      de: e.de || '',
      estado: e.estado,
      createdon: e.createdon,
      createdby: e.createdby,
      total: e.destinatarios.length,
      conteo: contadores(e.destinatarios),
    }));
}

/** Detalle con nombres actuales de contacto y empresa; sin el cuerpo. */
function detalleEnvio(envioId) {
  const envio = envios.porId(envioId);
  if (!envio) return null;
  const contactos = new Map(crm.contactos.todas().map((k) => [k.id, k]));
  const empresas = new Map(crm.clientes.todas().map((c) => [c.id, c.nombre]));
  return {
    id: envio.id,
    asunto: envio.asunto,
    de: envio.de || '',
    estado: envio.estado,
    createdon: envio.createdon,
    createdby: envio.createdby,
    conteo: contadores(envio.destinatarios),
    destinatarios: envio.destinatarios.map((d) => {
      const k = contactos.get(d.contactoId);
      return {
        ...d,
        nombre: k ? [k.nombres, k.apellidos].filter(Boolean).join(' ') : '',
        empresa: k ? empresas.get(k.clienteId) || '' : '',
      };
    }),
  };
}

/** Píxel de apertura: confirma que el correo llegó a un buzón real. */
function marcarEntregado(token) {
  const p = auth.unsign(token);
  if (!p || p.t !== 'em') return false;
  const contacto = crm.contactos.porId(p.c);
  if (!contacto) return false;
  const envio = envios.porId(p.e);
  if (envio) {
    const d = envio.destinatarios.find((x) => x.contactoId === p.c);
    // el píxel solo confirma: nunca pisa un no_existe ni un error
    if (d && (d.estado === 'enviado' || d.estado === 'entregado')) {
      d.estado = 'entregado';
      d.abiertoEn = new Date().toISOString();
      envios.actualizar(envio.id, { destinatarios: envio.destinatarios }, 'emailmarketing');
    }
  }
  if (!contacto.emailmarketing_status || contacto.emailmarketing_status === 'enviado' || contacto.emailmarketing_status === 'entregado') {
    marcarContacto(contacto.id, 'entregado');
  }
  return true;
}

module.exports = {
  envios,
  PIXEL_GIF,
  MAX_DESTINATARIOS,
  crearEnvio,
  cancelarEnvio,
  listarEnvios,
  detalleEnvio,
  marcarEntregado,
  clasificarError,
};
