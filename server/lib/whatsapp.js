'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const aiagent = require('./aiagent');
const H = require('./http');

const RUTA_CONFIG = path.join(config.dataDir, 'wa-config.json');
const RUTA_META = path.join(config.dataDir, 'meta-config.json');
const VERSION_POR_DEFECTO = 'v23.0';
// WhatsApp rechaza textos de más de 4096 caracteres; se parte con margen.
const MAX_TEXTO = 3800;
// Meta reintenta el webhook si no recibe 200 a tiempo; el id evita duplicados.
const vistos = new Map();
// dos mensajes seguidos del mismo número se procesan en orden: si no, podrían
// crear dos contactos para el mismo teléfono y partir la conversación
const colas = new Map();

function enFila(numero, tarea) {
  const clave = String(numero || '');
  const previa = colas.get(clave) || Promise.resolve();
  const siguiente = previa.then(tarea);
  const guardada = siguiente.catch(() => {});
  colas.set(clave, guardada);
  guardada.finally(() => {
    if (colas.get(clave) === guardada) colas.delete(clave);
  });
  return siguiente;
}

/**
 * wa-config.json guarda lo propio del canal (verifyToken, version, phoneNumberId).
 * El token permanente y el app_secret ya viven en meta-config.json: se reutilizan
 * para no duplicar secretos.
 */
function leerConfig() {
  const c = {};
  try {
    const meta = JSON.parse(fs.readFileSync(RUTA_META, 'utf8'));
    if (meta && typeof meta === 'object') {
      if (meta.access_token) c.token = meta.access_token;
      if (meta.app_secret) c.appSecret = meta.app_secret;
    }
  } catch {
    // sin archivo de Meta: el webhook responde que falta configurar
  }
  try {
    const raw = JSON.parse(fs.readFileSync(RUTA_CONFIG, 'utf8'));
    if (raw && typeof raw === 'object') Object.assign(c, raw);
  } catch {
    // sin archivo propio: igual se puede verificar si hay app_secret
  }
  return c;
}

function configurado() {
  const c = leerConfig();
  return Boolean(c.token && c.appSecret && c.verifyToken);
}

function iguales(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function firmaValida(raw, cabecera, secreto) {
  if (!cabecera || !secreto) return false;
  const esperada = 'sha256=' + crypto.createHmac('sha256', secreto).update(raw).digest('hex');
  return iguales(String(cabecera).trim(), esperada);
}

/** Verificación del webhook: Meta hace GET con hub.mode, hub.verify_token y hub.challenge. */
function verificar(url, res) {
  const c = leerConfig();
  if (!c.verifyToken) return H.sendText(res, 503, 'whatsapp sin configurar');
  const modo = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const reto = H.clean(url.searchParams.get('hub.challenge'), 256);
  if (modo === 'subscribe' && iguales(token, c.verifyToken)) return H.sendText(res, 200, reto);
  return H.sendText(res, 403, 'forbidden');
}

function yaProcesado(id) {
  const ahora = Date.now();
  if (vistos.has(id)) return true;
  vistos.set(id, ahora);
  if (vistos.size > 500) {
    for (const [clave, momento] of vistos) if (ahora - momento > 3_600_000) vistos.delete(clave);
  }
  return false;
}

/** POST del webhook: se valida la firma, se confirma a Meta de inmediato y se procesa aparte. */
async function recibir(req, res) {
  const c = leerConfig();
  // sin app_secret cualquiera podría inyectar mensajes y gastar mensajes de la API
  if (!c.appSecret) {
    console.error('[whatsapp] falta app_secret: no se puede validar la firma');
    return H.sendText(res, 503, 'whatsapp sin configurar');
  }
  let raw;
  try {
    raw = await H.readRawBody(req, 1_000_000);
  } catch (err) {
    return H.sendText(res, err.status === 413 ? 413 : 400, 'bad_request');
  }
  if (!firmaValida(raw, req.headers['x-hub-signature-256'], c.appSecret)) {
    return H.sendText(res, 401, 'invalid_signature');
  }
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return H.sendText(res, 400, 'invalid_json');
  }
  H.sendText(res, 200, 'EVENT_RECEIVED');
  procesar(payload).catch((err) => console.error('[whatsapp] procesar:', err.message));
}

async function procesar(payload) {
  if (!payload || payload.object !== 'whatsapp_business_account') return;
  for (const entry of payload.entry || []) {
    for (const cambio of entry.changes || []) {
      if (cambio.field !== 'messages') continue;
      const valor = cambio.value || {};
      const phoneNumberId = valor.metadata && valor.metadata.phone_number_id;
      // el id de la cuenta y del número son la llave para operar la WABA
      console.log(`[whatsapp] cuenta ${entry.id || '—'} · número ${phoneNumberId || '—'}`);
      for (const msg of valor.messages || []) {
        if (!msg || !msg.id || yaProcesado(msg.id)) continue;
        try {
          await enFila(msg.from, () => atender(msg, phoneNumberId));
        } catch (err) {
          console.error(`[whatsapp] mensaje ${msg.id}:`, err.message);
          await enviar(
            msg.from,
            'Estoy teniendo un problema técnico en este momento. Escríbeme de nuevo en unos minutos, por favor.',
            phoneNumberId
          );
        }
      }
    }
  }
}

async function atender(msg, phoneNumberId) {
  const de = String(msg.from || '');
  let texto = '';
  if (msg.type === 'text' && msg.text) texto = msg.text.body;
  else if (msg.type === 'button' && msg.button) texto = msg.button.text;
  else if (msg.type === 'interactive' && msg.interactive) {
    const i = msg.interactive;
    texto = (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || '';
  }
  if (!texto) {
    await enviar(de, 'Por ahora solo puedo leer mensajes de texto. ¿Me escribes tu mensaje, por favor?', phoneNumberId);
    return;
  }

  const r = await aiagent.mensajeWhatsApp(de, texto);
  // primera vez: el saludo explica las dos formas de empezar (conversar o reunión)
  if (r.saludo) await enviar(de, r.saludo, phoneNumberId);
  if (r.texto) {
    await enviar(de, r.texto, phoneNumberId);
    return;
  }
  console.error('[whatsapp] agente:', r.error || 'respuesta vacía');
  await enviar(de, 'Estoy teniendo un problema técnico en este momento. Escríbeme de nuevo en unos minutos, por favor.', phoneNumberId);
}

function trozos(textoCrudo) {
  const partes = [];
  let resto = String(textoCrudo || '').trim();
  while (resto.length > MAX_TEXTO) {
    let corte = resto.lastIndexOf('\n', MAX_TEXTO);
    if (corte < MAX_TEXTO * 0.5) corte = resto.lastIndexOf(' ', MAX_TEXTO);
    if (corte < MAX_TEXTO * 0.5) corte = MAX_TEXTO;
    partes.push(resto.slice(0, corte).trim());
    resto = resto.slice(corte).trim();
  }
  if (resto) partes.push(resto);
  return partes;
}

/** Envía texto libre por Cloud API. Solo se usa dentro de la ventana de 24 h. */
async function enviar(numero, texto, phoneNumberId) {
  const c = leerConfig();
  const id = phoneNumberId || c.phoneNumberId;
  if (!c.token || !id) {
    console.error('[whatsapp] sin token o phone_number_id para enviar');
    return { ok: false, error: 'sin configurar' };
  }
  const destino = String(numero || '').replace(/\D/g, '');
  if (!destino) return { ok: false, error: 'número vacío' };
  const version = c.version || VERSION_POR_DEFECTO;
  for (const parte of trozos(texto)) {
    try {
      const resp = await fetch(`https://graph.facebook.com/${version}/${id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.token },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: destino,
          type: 'text',
          text: { preview_url: false, body: parte },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!resp.ok) {
        const detalle = await resp.text().catch(() => '');
        console.error('[whatsapp] envío falló', resp.status, detalle.slice(0, 300));
        return { ok: false, error: `graph ${resp.status}` };
      }
    } catch (err) {
      console.error('[whatsapp] envío:', err.message);
      return { ok: false, error: err.message };
    }
  }
  return { ok: true };
}

module.exports = {
  configurado,
  verificar,
  recibir,
  enviar,
};
