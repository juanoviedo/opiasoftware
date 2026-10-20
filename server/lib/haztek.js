'use strict';

/**
 * Sitio de Haztek (cliente) servido como host virtual del mismo proceso.
 * Todo lo de Haztek vive bajo la carpeta haztek/ del repo y su almacén de
 * datos propio (haztek/data/), separado del de OPIA: el proyecto se puede
 * extraer a otro contenedor sin arrastrar datos de opiasoftware.com.
 * No usa la inyección de tags de OPIA: la analítica de Haztek se conecta
 * desde el propio HTML (GTM/GA4) cuando existan sus IDs.
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const H = require('./http');
const { JsonlStore } = require('./store');
const { sendMail } = require('./mail');

const HAZTEK_DIR = path.join(config.repoRoot, 'haztek');
const DATA_DIR = process.env.HAZTEK_DATA_DIR
  ? path.resolve(process.env.HAZTEK_DATA_DIR)
  : path.join(HAZTEK_DIR, 'data');

const leads = new JsonlStore(path.join(DATA_DIR, 'leads.jsonl'));

/* El data dir nunca se sirve: ahí viven los datos personales del cliente. */
const SEGMENTOS_VEDADOS = new Set(['data', 'node_modules', '.git', 'server', 'scripts']);

const HOSTS_HAZTEK = new Set(['haztek.opiasoftware.com', 'haztek.localhost']);

function esHostHaztek(host) {
  return HOSTS_HAZTEK.has(String(host || '').toLowerCase().split(':')[0]);
}

/* ------------------------------------------------------------ estáticos */

function esArchivo(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolver(ruta) {
  let decodificada;
  try {
    decodificada = decodeURIComponent(String(ruta).split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (decodificada.includes('\0')) return null;

  const relativa = decodificada.replace(/^\/+/, '');
  const completa = path.resolve(HAZTEK_DIR, relativa);
  const raiz = HAZTEK_DIR.endsWith(path.sep) ? HAZTEK_DIR : HAZTEK_DIR + path.sep;
  if (completa !== HAZTEK_DIR && !completa.startsWith(raiz)) return null;

  const segmentos = path.relative(HAZTEK_DIR, completa).split(path.sep).filter(Boolean);
  if (segmentos.some((s) => s.startsWith('.') || SEGMENTOS_VEDADOS.has(s))) return null;
  return completa;
}

/** cleanUrls igual que el resto del servidor: /privacidad → privacidad.html */
function buscar(archivo) {
  if (!archivo) return null;
  if (esArchivo(archivo)) return archivo;
  const conIndex = path.join(archivo, 'index.html');
  if (esArchivo(conIndex)) return conIndex;
  const conHtml = `${archivo}.html`;
  if (esArchivo(conHtml)) return conHtml;
  const sinHtml = archivo.endsWith('.html') ? archivo.slice(0, -5) : null;
  if (sinHtml && esArchivo(sinHtml)) return sinHtml;
  return null;
}

function cachePara(archivo) {
  if (archivo.endsWith('.html')) return 'no-cache';
  if (archivo.startsWith(path.join(HAZTEK_DIR, 'img'))) return 'public, max-age=86400';
  return 'public, max-age=3600';
}

function enviarArchivo(res, req, archivo) {
  let cuerpo;
  try {
    cuerpo = fs.readFileSync(archivo);
  } catch {
    return false;
  }
  res.writeHead(200, {
    'Content-Type': H.mimeFor(archivo),
    'Content-Length': cuerpo.length,
    'Cache-Control': cachePara(archivo),
    ...H.SECURITY_HEADERS,
  });
  res.end(req.method === 'HEAD' ? undefined : cuerpo);
  return true;
}

function servir(req, res, urlPath) {
  const ruta = urlPath.split('?')[0];
  if (ruta.length > 1 && ruta.endsWith('/')) {
    const query = urlPath.includes('?') ? urlPath.slice(urlPath.indexOf('?')) : '';
    res.writeHead(308, { Location: ruta.slice(0, -1) + query, 'Cache-Control': 'no-cache' });
    res.end();
    return;
  }
  const archivo = buscar(resolver(ruta));
  if (archivo && enviarArchivo(res, req, archivo)) return;
  H.sendText(res, 404, '404 — Página no encontrada', { 'X-Robots-Tag': 'noindex' });
}

/* --------------------------------------------------------------- lead */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TIPOS = ['Cotización rápida', 'Propuesta técnica — sector público'];

const limite = (() => {
  const golpes = new Map();
  return (clave) => {
    const ahora = Date.now();
    const entrada = golpes.get(clave);
    if (!entrada || ahora - entrada.inicio > 3_600_000) {
      golpes.set(clave, { inicio: ahora, cuenta: 1 });
      return true;
    }
    entrada.cuenta += 1;
    return entrada.cuenta <= 6;
  };
})();

/**
 * Config de correo para notificar leads: primero la propia de Haztek
 * (haztek/data/config.json, para cuando el proyecto se exporte a su
 * propio contenedor); si no existe, se usa el SMTP ya configurado del
 * servidor de OPIA para que las notificaciones funcionen desde ya.
 */
function configCorreo() {
  const propia = (() => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'));
      if (raw && raw.smtp && raw.smtp.host) return raw;
    } catch {
      // sin config propia de Haztek
    }
    return null;
  })();
  if (propia) {
    return {
      host: propia.smtp.host,
      port: Number(propia.smtp.port) || (propia.smtp.secure === false ? 587 : 465),
      secure: propia.smtp.secure !== false,
      user: propia.smtp.user,
      pass: propia.smtp.pass,
      from: propia.from || propia.smtp.user,
      para: propia.correoNotificacion || 'joviedo@opiasoftware.com',
    };
  }
  try {
    const crm = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'crm-config.json'), 'utf8'));
    if (crm && crm.smtp && crm.smtp.host) {
      return {
        host: crm.smtp.host,
        port: Number(crm.smtp.port) || (crm.smtp.secure === false ? 587 : 465),
        secure: crm.smtp.secure !== false,
        user: crm.smtp.user,
        pass: crm.smtp.pass,
        from: crm.from,
        para: crm.correoHaztek || 'joviedo@opiasoftware.com',
      };
    }
  } catch {
    // sin SMTP disponible: el lead queda guardado igual
  }
  return null;
}

function notificar(lead) {
  const correo = configCorreo();
  if (!correo) return;
  const texto = [
    'Nueva solicitud de cotización desde haztek.opiasoftware.com',
    '',
    `Nombre: ${lead.nombre}`,
    `Teléfono: ${lead.telefono}`,
    lead.correo ? `Correo: ${lead.correo}` : '',
    `Tipo: ${lead.tipo}`,
    '',
    'Detalle:',
    lead.detalle,
    '',
    `Recibido: ${lead.t}`,
  ].filter(Boolean).join('\n');
  sendMail({
    host: correo.host,
    port: correo.port,
    secure: correo.secure,
    user: correo.user,
    pass: correo.pass,
    from: correo.from,
    to: correo.para,
    subject: 'Haztek: nueva solicitud de cotización — ' + lead.nombre,
    text: texto,
  }).catch((err) => console.error('[haztek] correo no enviado:', err.message));
}

async function manejarLead(req, res) {
  const ip = H.clientIp(req, config.trustProxy);
  if (!limite(ip)) {
    return H.sendJson(res, 429, { ok: false, error: 'Demasiados envíos. Intenta más tarde.' });
  }

  let cuerpo;
  try {
    const raw = await H.readBody(req, 16_384);
    if (!raw) return H.sendJson(res, 400, { ok: false, error: 'Solicitud inválida.' });
    cuerpo = JSON.parse(raw);
  } catch {
    return H.sendJson(res, 400, { ok: false, error: 'Solicitud inválida.' });
  }

  // trampa de spam: los bots rellenan campos que las personas no ven
  if (H.clean(cuerpo.website, 200) || H.clean(cuerpo.url_field, 200)) {
    return H.sendJson(res, 200, { ok: true });
  }

  const nombre = H.clean(cuerpo.nombre, 120).trim();
  const correo = H.clean(cuerpo.correo, 160).trim();
  const telefono = H.clean(cuerpo.telefono, 40).replace(/[^\d+()\-\s]/g, '').trim();
  const tipoBruto = H.clean(cuerpo.tipo, 80).trim();
  const tipo = TIPOS.includes(tipoBruto) ? tipoBruto : TIPOS[0];
  const detalle = H.clean(cuerpo.detalle, 2000).trim();
  const consentimiento = cuerpo.consentimiento === true || cuerpo.consentimiento === 'true';

  const errores = {};
  if (nombre.length < 2) errores.nombre = 'Escribe tu nombre.';
  if (!EMAIL_RE.test(correo) && telefono.replace(/\D/g, '').length < 7) {
    errores.telefono = 'Necesitamos un teléfono o un correo para responderte.';
  }
  if (!consentimiento) errores.consentimiento = 'Debes autorizar el tratamiento de tus datos.';
  if (Object.keys(errores).length) return H.sendJson(res, 422, { ok: false, errores });

  const lead = {
    t: new Date().toISOString(),
    nombre,
    correo,
    telefono,
    tipo,
    detalle,
    ip,
    ref: H.clean(req.headers.referer, 300),
    ua: H.clean(req.headers['user-agent'], 400),
    estado: 'nuevo',
  };
  leads.append(lead);
  notificar(lead);
  H.sendJson(res, 201, { ok: true });
}

/* ----------------------------------------------------------- orquestador */

async function manejar(req, res, url) {
  const ruta = url.pathname;
  if (req.method === 'POST' && ruta === '/api/haztek/lead') return manejarLead(req, res);
  if (ruta.startsWith('/api/')) return H.sendJson(res, 404, { ok: false, error: 'not_found' });
  if (req.method === 'GET' || req.method === 'HEAD') return servir(req, res, req.url);
  return H.sendJson(res, 405, { ok: false, error: 'Método no permitido.' });
}

/** Retención propia del cliente: 90 días, igual que promete su política. */
function podar() {
  return leads.prune(new Date(Date.now() - 90 * 86_400_000).toISOString());
}

module.exports = { esHostHaztek, manejar, podar };
