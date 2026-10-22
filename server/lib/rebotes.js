'use strict';

/* Los avisos de devolución (NDR) llegan al buzón del dueño DESPUÉS de que
   Microsoft aceptó el mensaje: el envío en vivo jamás los ve. Este módulo lee
   esos avisos por Graph, saca la dirección que rebotó y aplica la misma regla
   que un rebote duro detectado en el momento (marca el contacto como no_existe
   y le vacía el correo). Dos cerrojos para no tocar datos por error: solo actúa
   sobre direcciones que existen en el CRM, y solo lee la parte de diagnóstico
   del aviso — el cuerpo del correo original que viene más abajo puede traer
   otras direcciones que no rebotaron. */

const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const crm = require('./crm');
const teams = require('./teams');
const emailmkt = require('./emailmarketing');
const { quitarEtiquetas } = require('./mail');

const RUTA_ESTADO = path.join(config.dataDir, 'crm', 'rebotes-estado.json');
const INTERVALO_MS = 10 * 60_000;
const ARRANQUE_MS = 45_000;
const MIRADA_INICIAL_DIAS = 7;
const MAX_MENSAJES = 50;
const MAX_PROCESADOS = 300;

const ASUNTO_NDR =
  /^(undeliverable|no se pudo (enviar|entregar)|no se puede entregar|mensaje no entregable|delivery (has )?failed)/i;
const TEXTO_FALLO =
  /\b(undeliverable|couldn.t be delivered|no se pudo entregar|no se pudo enviar|recipient not found|no such user|user unknown|mailbox (full|unavailable)|5\.1\.\d|5\.2\.\d)\b/i;
const CORTE_ORIGINAL = /\b(mensaje original|original message)\b/i;
const CORREO_EN_TEXTO = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// nuestras direcciones y las del sistema de Microsoft salen siempre en el aviso:
// no son el destinatario que rebotó
const DIRECCIONES_DESCARTADAS =
  /@(opiasoftware\.com|microsoft\.com|exchange\.online\.microsoft\.com|protection\.outlook\.com)$/i;

function leerEstado() {
  try {
    const raw = JSON.parse(fs.readFileSync(RUTA_ESTADO, 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch {
    // primera corrida: se mira hacia atrás unos días
  }
  return { ultimaRevision: '', procesados: [] };
}

function guardarEstado(estado) {
  fs.mkdirSync(path.dirname(RUTA_ESTADO), { recursive: true });
  const tmp = RUTA_ESTADO + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(estado, null, 2), 'utf8');
  fs.renameSync(tmp, RUTA_ESTADO);
}

function remitente(mensaje) {
  const dir = ((mensaje.from || {}).emailAddress || {});
  return { address: String(dir.address || ''), name: String(dir.name || '') };
}

function esAvisoDevolucion(mensaje, texto) {
  const asunto = String(mensaje.subject || '').trim();
  if (ASUNTO_NDR.test(asunto)) return true;
  const de = remitente(mensaje);
  return /postmaster@/i.test(de.address) && TEXTO_FALLO.test(String(texto || ''));
}

/** Solo el diagnóstico: lo que sigue al "Mensaje original" es el correo que se envió. */
function textoDiagnostico(mensaje) {
  const plano = quitarEtiquetas(String(((mensaje.body || {}).content) || ''));
  const corte = CORTE_ORIGINAL.exec(plano);
  return (corte ? plano.slice(0, corte.index) : plano).slice(0, 4000);
}

function direccionesRebotadas(texto) {
  const encontradas = String(texto || '').match(CORREO_EN_TEXTO) || [];
  const unicas = [...new Set(encontradas.map((x) => x.toLowerCase().replace(/[.,;:]+$/, '')))];
  return unicas.filter((x) => !DIRECCIONES_DESCARTADAS.test(x));
}

function contactoPorCorreo(direccion) {
  const buscado = String(direccion || '').toLowerCase().trim();
  if (!buscado) return null;
  // el email marketing escribe al correo principal: solo ese cuenta aquí
  return crm.contactos.todas().find((k) => String(k.email || '').toLowerCase() === buscado) || null;
}

function procesarAviso(mensaje) {
  const texto = textoDiagnostico(mensaje);
  const direcciones = direccionesRebotadas(texto);
  if (!direcciones.length) return { marcados: 0 };
  // misma clasificación que en el envío en vivo: 5.1.x vacía el correo, lo demás no
  const estado = emailmkt.clasificarError(texto + ' ' + String(mensaje.subject || ''));
  let marcados = 0;
  for (const direccion of direcciones) {
    const contacto = contactoPorCorreo(direccion);
    if (!contacto) {
      console.log('[rebotes] aviso sin contacto en el CRM:', direccion);
      continue;
    }
    const detalle =
      estado === 'no_existe'
        ? 'rebote tardío: el buzón no existe (aviso de devolución en el correo)'
        : 'rebote tardío: ' + texto.slice(0, 120);
    const campanas = emailmkt.marcarReboteTardio(direccion, estado, detalle);
    emailmkt.marcarContacto(contacto.id, estado);
    console.log('[rebotes] contacto', contacto.id, direccion, '→', estado, '| campañas tocadas:', campanas);
    marcados += 1;
  }
  return { marcados, estado, direcciones };
}

async function revisarRebotes() {
  if (!teams.correoAccesible()) return { ok: false, motivo: 'sin permiso de lectura de correo' };
  const estado = leerEstado();
  const desde =
    estado.ultimaRevision || new Date(Date.now() - MIRADA_INICIAL_DIAS * 86_400_000).toISOString();
  const filtro = encodeURIComponent('receivedDateTime ge ' + desde);
  const ruta =
    '/me/messages?$top=' + MAX_MENSAJES +
    '&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,body&$filter=' + filtro;
  const datos = await teams.graph('GET', ruta);
  const mensajes = (datos && datos.value) || [];
  const yaProcesados = new Set(estado.procesados || []);
  let marcados = 0;
  let ultima = estado.ultimaRevision;
  for (const mensaje of mensajes) {
    if (!mensaje || !mensaje.id) continue;
    if (mensaje.receivedDateTime && mensaje.receivedDateTime > ultima) ultima = mensaje.receivedDateTime;
    if (yaProcesados.has(mensaje.id)) continue;
    const texto = textoDiagnostico(mensaje);
    if (!esAvisoDevolucion(mensaje, texto)) continue;
    const r = procesarAviso(mensaje);
    marcados += r.marcados || 0;
    yaProcesados.add(mensaje.id);
  }
  estado.ultimaRevision = ultima || desde;
  estado.procesados = [...yaProcesados].slice(-MAX_PROCESADOS);
  guardarEstado(estado);
  return { ok: true, revisados: mensajes.length, marcados };
}

async function correr() {
  try {
    const r = await revisarRebotes();
    if (r && r.ok && r.marcados) console.log('[rebotes] revisión:', JSON.stringify(r));
  } catch (err) {
    console.error('[rebotes] no se pudo leer el buzón:', err.message);
  }
}

// unref: los scripts que cargan la librería (importadores, pruebas) deben poder terminar
const reloj = setInterval(correr, INTERVALO_MS);
reloj.unref();
const arranque = setTimeout(correr, ARRANQUE_MS);
arranque.unref();

module.exports = {
  revisarRebotes,
  procesarAviso,
  esAvisoDevolucion,
  textoDiagnostico,
  direccionesRebotadas,
};
