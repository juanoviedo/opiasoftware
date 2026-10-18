'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');

const TIMEOUT_MS = 15_000;

/** Lee una respuesta SMTP respetando las líneas de continuación ("250-..."). */
function leerRespuesta(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let codigo = null;
    const timer = setTimeout(() => reject(new Error('timeout_smtp')), TIMEOUT_MS);
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const lineas = buffer.split('\r\n').filter(Boolean);
      for (const linea of lineas) {
        const c = linea.slice(0, 3);
        if (!/^\d{3}$/.test(c)) continue;
        if (linea[3] === '-') continue; // continúa en la siguiente línea
        codigo = c;
      }
      if (codigo) {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onClose);
        resolve({ codigo: Number(codigo), texto: buffer.trim() });
      }
    };
    const onError = (err) => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      reject(err);
    };
    const onClose = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      reject(new Error('conexion_cerrada_smtp'));
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function enviar(socket, linea) {
  socket.write(linea + '\r\n');
}

function base64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

function cabecera(subject) {
  return `=?UTF-8?B?${base64(subject)}?=`;
}

/** Versión de texto plano para la parte alternative del correo HTML. */
function quitarEtiquetas(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** El sobre SMTP solo lleva la dirección pura; "Nombre <correo>" lo rechaza Microsoft (5.1.7). */
function direccionPura(valor) {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(String(valor).trim());
  return m ? m[1] : String(valor).trim();
}

/** RCPT va uno por destinatario: Microsoft rechaza varias direcciones en un solo RCPT (5.1.3). */
function listaDestinatarios(valor) {
  const crudos = Array.isArray(valor) ? valor : String(valor || '').split(',');
  return crudos.map((v) => direccionPura(v).trim()).filter(Boolean);
}

/** Mensaje RFC 822 completo; función pura para poder probarla sin socket. */
function construirMensaje({ from, to, subject, text, html }) {
  const salto = '\r\n';
  const comunes = [`From: ${from}`, `To: ${to}`, `Subject: ${cabecera(subject)}`, 'MIME-Version: 1.0'];
  let cuerpo;
  if (html) {
    const boundary = 'opia_' + crypto.randomBytes(12).toString('hex');
    const parte = (tipo, contenido) =>
      `--${boundary}${salto}` +
      `Content-Type: ${tipo}; charset=UTF-8${salto}` +
      `Content-Transfer-Encoding: base64${salto}${salto}` +
      base64(contenido).replace(/(.{76})/g, '$1\r\n') +
      salto;
    comunes.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    cuerpo =
      parte('text/plain', text || quitarEtiquetas(html)) +
      parte('text/html', html) +
      `--${boundary}--`;
  } else {
    comunes.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
    cuerpo = base64(text).replace(/(.{76})/g, '$1\r\n');
  }
  return [...comunes, '', cuerpo, '', ''].join(salto);
}

/**
 * Cliente SMTP mínimo (sin dependencias): soporta TLS directo (puerto 465) y
 * STARTTLS (puerto 587), con AUTH LOGIN. Suficiente para Gmail y similares.
 * Con html va multipart/alternative (texto + HTML): los clientes de correo lo
 * piden así para mostrar la versión rica sin caer en spam.
 */
async function sendMail({ host, port, secure, user, pass, from, to, subject, text, html }) {
  const salto = '\r\n';
  const mensaje = construirMensaje({ from, to, subject, text, html });

  let socket = secure
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });
  socket.setTimeout(TIMEOUT_MS);

  const esperar = (esperado, paso) =>
    leerRespuesta(socket).then((r) => {
      if (r.codigo !== esperado) {
        throw new Error(`smtp_${paso}_${r.codigo}: ${r.texto.slice(0, 120)}`);
      }
      return r;
    });

  await esperar(secure ? 220 : 220, 'saludo');
  enviar(socket, 'EHLO opiasoftware.com');
  const ehlo = await esperar(250, 'ehlo');

  if (!secure && /STARTTLS/i.test(ehlo.texto)) {
    enviar(socket, 'STARTTLS');
    await esperar(220, 'starttls');
    const actualizado = await new Promise((resolve, reject) => {
      const s2 = tls.connect({ socket, servername: host }, () => resolve(s2));
      s2.once('error', reject);
    });
    socket = actualizado; // eslint-disable-line no-param-reassign -- se reasigna el socket activo
    enviar(socket, 'EHLO opiasoftware.com');
    await esperar(250, 'ehlo_tls');
  }

  if (user) {
    enviar(socket, 'AUTH LOGIN');
    await esperar(334, 'auth_inicio');
    enviar(socket, base64(user));
    await esperar(334, 'auth_usuario');
    enviar(socket, base64(pass));
    await esperar(235, 'auth_clave');
  }

  enviar(socket, `MAIL FROM:<${direccionPura(from)}>`);
  await esperar(250, 'remitente');
  const destinatarios = listaDestinatarios(to);
  if (!destinatarios.length) throw new Error('sin destinatarios válidos');
  for (const destino of destinatarios) {
    enviar(socket, `RCPT TO:<${destino}>`);
    await esperar(250, 'destinatario');
  }
  enviar(socket, 'DATA');
  await esperar(354, 'datos');
  socket.write(mensaje + '.' + salto);
  await esperar(250, 'enviado');
  enviar(socket, 'QUIT');
  socket.end();
}

module.exports = { sendMail, construirMensaje, quitarEtiquetas };
