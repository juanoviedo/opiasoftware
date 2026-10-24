'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const config = require('./config');
const aiagent = require('./aiagent');
const H = require('./http');

const execFileAsync = promisify(execFile);

const RUTA_CONFIG = path.join(config.dataDir, 'wa-config.json');
const RUTA_META = path.join(config.dataDir, 'meta-config.json');
const VERSION_POR_DEFECTO = 'v23.0';
// WhatsApp rechaza textos de más de 4096 caracteres; se parte con margen.
const MAX_TEXTO = 3800;
// imágenes de WhatsApp: 5 MB; audios: 16 MB (las notas de voz son mucho menores)
const MAX_IMAGEN = 5 * 1024 * 1024;
const MAX_AUDIO = 16 * 1024 * 1024;
// el binario y el modelo de Whisper se copian en la imagen Docker (ver Dockerfile)
const WHISPER_CLI = process.env.OPIA_WHISPER_CLI || '/app/stt/whisper-cli';
const WHISPER_MODEL = process.env.OPIA_WHISPER_MODEL || '/app/stt/ggml-base-q5_1.bin';
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

/** Baja un archivo del usuario: Graph da una URL temporal que también exige token. */
async function descargarMedia(mediaId) {
  const c = leerConfig();
  if (!c.token) throw new Error('sin token');
  const version = c.version || VERSION_POR_DEFECTO;
  const infoResp = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(mediaId)}`, {
    headers: { Authorization: 'Bearer ' + c.token },
    signal: AbortSignal.timeout(20_000),
  });
  if (!infoResp.ok) throw new Error('graph media ' + infoResp.status);
  const info = await infoResp.json();
  if (!info.url) throw new Error('media sin url');
  const binResp = await fetch(info.url, {
    headers: { Authorization: 'Bearer ' + c.token },
    signal: AbortSignal.timeout(30_000),
  });
  if (!binResp.ok) throw new Error('media ' + binResp.status);
  const buffer = Buffer.from(await binResp.arrayBuffer());
  return { buffer, mime: String(info.mime_type || '') };
}

/** Si wa-config.json trae una clave de Groq/OpenAI-compatible se usa esa API
 *  (rápida y sin cargar el servidor); si no, Whisper local en el contenedor. */
async function transcribirPorApi(buffer, mime, c) {
  const base = String(c.sttBaseUrl || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'audio/ogg' }), 'audio.ogg');
  form.append('model', c.sttModel || 'whisper-large-v3-turbo');
  form.append('language', 'es');
  form.append('response_format', 'json');
  const resp = await fetch(base + '/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.sttApiKey },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const detalle = await resp.text().catch(() => '');
    throw new Error(`stt ${resp.status}: ${detalle.slice(0, 160)}`);
  }
  const data = await resp.json();
  return String(data.text || '').trim();
}

/** ffmpeg pasa la nota de voz a WAV 16 kHz mono y Whisper la transcribe en español. */
async function transcribirLocal(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opia-wa-'));
  try {
    const origen = path.join(dir, 'audio.bin');
    const wav = path.join(dir, 'audio.wav');
    fs.writeFileSync(origen, buffer);
    await execFileAsync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', origen, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav],
      { timeout: 60_000 }
    );
    const { stdout } = await execFileAsync(
      WHISPER_CLI,
      ['-m', WHISPER_MODEL, '-f', wav, '-l', 'es', '-nt', '-np', '-t', '4', '-bo', '1'],
      { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }
    );
    return String(stdout || '').trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function transcribirAudio(buffer, mime) {
  const c = leerConfig();
  if (c.sttApiKey) {
    try {
      return await transcribirPorApi(buffer, mime, c);
    } catch (err) {
      console.error('[whatsapp] voz por API:', err.message, '— se intenta Whisper local');
    }
  }
  return transcribirLocal(buffer);
}

async function atender(msg, phoneNumberId) {
  const de = String(msg.from || '');
  let texto = '';
  let adjunto = null;
  if (msg.type === 'text' && msg.text) texto = msg.text.body;
  else if (msg.type === 'button' && msg.button) texto = msg.button.text;
  else if (msg.type === 'interactive' && msg.interactive) {
    const i = msg.interactive;
    texto = (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || '';
  } else if (msg.type === 'image' && msg.image) {
    texto = msg.image.caption || '';
    try {
      const media = await descargarMedia(msg.image.id);
      if (!/^image\/(jpeg|png|webp)/i.test(media.mime)) throw new Error('formato ' + (media.mime || 'desconocido'));
      if (media.buffer.length > MAX_IMAGEN) throw new Error(`imagen de ${media.buffer.length} bytes`);
      adjunto = { tipo: 'imagen', mime: media.mime, base64: media.buffer.toString('base64') };
    } catch (err) {
      console.error('[whatsapp] imagen:', err.message);
      await enviar(de, 'No pude leer esa imagen. ¿Me la envías de nuevo o me escribes tu mensaje?', phoneNumberId);
      return;
    }
  } else if (msg.type === 'audio' && msg.audio) {
    try {
      const media = await descargarMedia(msg.audio.id);
      if (media.buffer.length > MAX_AUDIO) throw new Error(`audio de ${media.buffer.length} bytes`);
      // Whisper local tarda unos segundos: se avisa para que la espera no parezca un fallo
      if (!leerConfig().sttApiKey) await enviar(de, 'Un momento, estoy escuchando tu nota de voz...', phoneNumberId);
      const transcripcion = await transcribirAudio(media.buffer, media.mime);
      if (!transcripcion) throw new Error('transcripción vacía');
      texto = '[Audio transcrito] ' + transcripcion;
    } catch (err) {
      console.error('[whatsapp] audio:', err.message);
      await enviar(de, 'No pude escuchar esa nota de voz. ¿Me escribes tu mensaje, por favor?', phoneNumberId);
      return;
    }
  } else {
    await enviar(de, 'Por ahora puedo leer texto, fotos y notas de voz. ¿Me escribes tu mensaje, por favor?', phoneNumberId);
    return;
  }
  if (!texto && !adjunto) {
    await enviar(de, '¿Me escribes tu mensaje, por favor?', phoneNumberId);
    return;
  }

  const r = await aiagent.mensajeWhatsApp(de, texto, adjunto);
  // saludo con el menú de funciones configurado en el CRM
  if (r.saludo) await enviar(de, r.saludo, phoneNumberId, r.saludoOpciones);
  if (r.texto) {
    await enviar(de, r.texto, phoneNumberId, r.opciones);
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

/**
 * WhatsApp acepta hasta 3 botones de 20 caracteres o una lista de hasta 10
 * filas de 24. Si las etiquetas no caben, se mandan numeradas como texto.
 */
function interactivoValido(texto, opciones) {
  const etiquetas = (opciones || []).map((t) => String(t || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const cuerpo = String(texto || '').trim();
  if (!cuerpo || cuerpo.length > 1024) return null;
  if (etiquetas.length < 2 || etiquetas.length > 10) return null;
  if (etiquetas.some((t) => t.length > 24)) return null;
  if (etiquetas.length <= 3 && etiquetas.every((t) => t.length <= 20)) {
    return {
      type: 'button',
      body: { text: cuerpo },
      action: { buttons: etiquetas.map((t, i) => ({ type: 'reply', reply: { id: 'op' + (i + 1), title: t } })) },
    };
  }
  return {
    type: 'list',
    body: { text: cuerpo },
    action: {
      button: 'Ver opciones',
      sections: [{ title: 'Opciones', rows: etiquetas.map((t, i) => ({ id: 'op' + (i + 1), title: t })) }],
    },
  };
}

function conNumeros(texto, opciones) {
  const etiquetas = (opciones || []).map((t) => String(t || '').trim()).filter(Boolean);
  if (!etiquetas.length) return String(texto || '');
  return (
    String(texto || '').trim() +
    '\n\n' +
    etiquetas.map((t, i) => `${i + 1}. ${t}`).join('\n') +
    '\n\nResponde con el número de la opción.'
  );
}

async function enviarPayload(id, version, token, payload) {
  try {
    const resp = await fetch(`https://graph.facebook.com/${version}/${id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) {
      const detalle = await resp.text().catch(() => '');
      console.error('[whatsapp] envío falló', resp.status, detalle.slice(0, 300));
      return { ok: false, error: `graph ${resp.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error('[whatsapp] envío:', err.message);
    return { ok: false, error: err.message };
  }
}

/** Envía texto libre por Cloud API, con botones/lista si hay opciones.
 *  Solo se usa dentro de la ventana de 24 h. */
async function enviar(numero, texto, phoneNumberId, opciones) {
  const c = leerConfig();
  const id = phoneNumberId || c.phoneNumberId;
  if (!c.token || !id) {
    console.error('[whatsapp] sin token o phone_number_id para enviar');
    return { ok: false, error: 'sin configurar' };
  }
  const destino = String(numero || '').replace(/\D/g, '');
  if (!destino) return { ok: false, error: 'número vacío' };
  const version = c.version || VERSION_POR_DEFECTO;

  const interactivo = interactivoValido(texto, opciones);
  if (interactivo) {
    const r = await enviarPayload(id, version, c.token, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: destino,
      type: 'interactive',
      interactive: interactivo,
    });
    if (r.ok) return r;
    console.error('[whatsapp] interactivo falló, se envía la lista numerada');
  }

  const cuerpo = opciones && opciones.length ? conNumeros(texto, opciones) : texto;
  for (const parte of trozos(cuerpo)) {
    const r = await enviarPayload(id, version, c.token, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: destino,
      type: 'text',
      text: { preview_url: false, body: parte },
    });
    if (!r.ok) return r;
  }
  return { ok: true };
}

module.exports = {
  configurado,
  verificar,
  recibir,
  enviar,
};
