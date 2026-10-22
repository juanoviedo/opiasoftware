'use strict';

const dns = require('node:dns').promises;
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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

/* Imágenes del cuerpo (p. ej. la firma del dueño pegada en el editor): viven
   en el volumen y se sirven públicas por /api/em/img/<nombre>; el nombre lo
   genera el servidor, así la lectura nunca sale de la carpeta. */
const DIR_IMAGENES = path.join(config.dataDir, 'crm', 'imagenes');
const TIPOS_IMAGEN = {
  'image/png': { ext: '.png', tipo: 'image/png' },
  'image/jpeg': { ext: '.jpg', tipo: 'image/jpeg' },
  'image/gif': { ext: '.gif', tipo: 'image/gif' },
  'image/webp': { ext: '.webp', tipo: 'image/webp' },
};
const TIPO_POR_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function guardarImagen(buffer, contentType) {
  const tipo = TIPOS_IMAGEN[String(contentType || '').toLowerCase()];
  if (!tipo) return { error: 'Solo se admiten imágenes PNG, JPG, GIF o WebP.' };
  if (!buffer || !buffer.length) return { error: 'La imagen llegó vacía.' };
  if (buffer.length > 5 * 1024 * 1024) return { error: 'La imagen no puede pesar más de 5 MB.' };
  fs.mkdirSync(DIR_IMAGENES, { recursive: true });
  const nombre = 'sig_' + crypto.randomBytes(8).toString('hex') + tipo.ext;
  fs.writeFileSync(path.join(DIR_IMAGENES, nombre), buffer);
  return { nombre };
}

function leerImagen(nombre) {
  const limpio = String(nombre || '');
  const ext = path.extname(limpio).toLowerCase();
  if (!/^[a-z0-9_]+\.[a-z0-9.]+$/.test(limpio) || !TIPO_POR_EXT[ext]) return null;
  try {
    return { datos: fs.readFileSync(path.join(DIR_IMAGENES, limpio)), tipo: TIPO_POR_EXT[ext] };
  } catch {
    return null;
  }
}

function marcarContacto(contactoId, estado) {
  const cambios = { emailmarketing_status: estado };
  // Rebote duro: la dirección quedó muerta. Se le vacía el correo al contacto
  // para que ninguna campaña vuelva a intentar escribirle; la dirección que
  // rebotó sigue visible en la fila de la campaña.
  if (estado === 'no_existe') {
    const k = crm.contactos.porId(contactoId);
    cambios.email = null;
    console.log('[emailmarketing] correo borrado por rebote duro:', contactoId, k ? k.email : '');
  }
  crm.contactos.actualizar(contactoId, cambios, 'emailmarketing');
}

/**
 * Rebote tardío: Microsoft aceptó el mensaje y la devolución llegó después al
 * buzón (la ve lib/rebotes.js). Se corrigen las filas de las campañas donde esa
 * dirección aparecía como enviada, para que el historial refleje el error.
 */
function marcarReboteTardio(email, estado, detalle) {
  const buscado = String(email || '').toLowerCase().trim();
  if (!buscado) return 0;
  let tocadas = 0;
  for (const envio of envios.todas()) {
    let cambio = false;
    for (const d of envio.destinatarios || []) {
      if (String(d.email || '').toLowerCase() !== buscado) continue;
      if (d.estado !== 'enviado' && d.estado !== 'entregado' && d.estado !== 'error') continue;
      d.estado = estado;
      d.detalle = detalle;
      cambio = true;
    }
    if (cambio) {
      envios.actualizar(envio.id, { destinatarios: envio.destinatarios }, 'rebotes');
      tocadas += 1;
    }
  }
  return tocadas;
}

/* ----------------------------------------------------------- campañas */

let enCurso = null; // id del envío que se está mandando
const canceladas = new Set();

function crearEnvio({ asunto, cuerpoHtml, contactoIds, de, programadoPara }, actor) {
  const titulo = String(asunto || '').trim();
  const cuerpo = String(cuerpoHtml || '').trim();
  if (titulo.length < 2) return { error: 'Escribe el asunto del correo.' };
  if (cuerpo.length < 2) return { error: 'Escribe el cuerpo del correo.' };
  const cuando = String(programadoPara || '').trim();
  let programado = '';
  if (cuando) {
    const t = Date.parse(cuando);
    if (!Number.isFinite(t)) return { error: 'La fecha de envío programada no es válida.' };
    if (t <= Date.now()) return { error: 'No puedes programar un envío para una hora que ya pasó.' };
    programado = new Date(t).toISOString();
  }
  // una campaña programada SÍ puede crearse mientras otra se envía: esperará su turno
  if (!programado && enCurso) return { error: 'Ya hay una campaña enviándose. Espera a que termine o cancélala.' };
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
    estado: programado ? 'programada' : 'pendiente',
    destinatarios,
  };
  if (programado) fila.programadoPara = programado;
  envios.agregar(fila, actor);
  if (programado) return { envio: envios.porId(fila.id) };
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
  // una campaña que aún espera su hora se cancela directo (no hay proceso corriendo)
  if (envio.estado === 'programada') {
    envios.actualizar(envioId, { estado: 'cancelada' }, 'emailmarketing');
    return { ok: true };
  }
  if (enCurso !== envioId) return { error: 'Esa campaña ya terminó.' };
  canceladas.add(envioId);
  return { ok: true };
}

function eliminarEnvio(envioId) {
  const envio = envios.porId(envioId);
  if (!envio) return { error: 'Campaña no encontrada.' };
  // mientras el proceso de envío recorre los destinatarios la fila no se puede
  // tocar: primero se cancela y al terminar queda borrable
  if (envio.estado === 'en_curso' || envio.estado === 'pendiente') {
    return { error: 'Esa campaña se está enviando. Cancélala primero y espera a que termine.' };
  }
  envios.eliminar(envioId);
  return { ok: true };
}

/* Las campañas programadas viven en la tabla: un tic cada 15 s revisa si ya es
   la hora. Si el servidor se reinicia (los despliegues lo hacen seguido), la
   campaña sobrevive al reinicio y sale igual, apenas haya turno libre. */
function ticProgramadas() {
  if (enCurso) return;
  const ahora = Date.now();
  const lista = envios
    .todas()
    .slice()
    .sort((a, b) => String(a.programadoPara || '').localeCompare(String(b.programadoPara || '')));
  for (const e of lista) {
    if (e.estado !== 'programada') continue;
    if (Date.parse(e.programadoPara || '') > ahora) continue;
    enCurso = e.id;
    enviarTodo(e.id).catch((err) => {
      console.error('[emailmarketing] campaña', e.id, err.message);
      enCurso = null;
    });
    return; // de una en una
  }
}
const relojProgramadas = setInterval(ticProgramadas, 15_000);
// los scripts que cargan la librería (importadores, pruebas) deben poder terminar
relojProgramadas.unref();

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
      programadoPara: e.programadoPara || '',
      // el texto plano va en la lista para poder mostrarlo; el HTML solo en el detalle
      texto: e.texto,
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
    programadoPara: envio.programadoPara || '',
    html: envio.html,
    texto: envio.texto,
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
  eliminarEnvio,
  listarEnvios,
  detalleEnvio,
  marcarEntregado,
  clasificarError,
  marcarContacto,
  marcarReboteTardio,
  guardarImagen,
  leerImagen,
};
