'use strict';

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

/**
 * Cliente SMTP mínimo (sin dependencias): soporta TLS directo (puerto 465) y
 * STARTTLS (puerto 587), con AUTH LOGIN. Suficiente para Gmail y similares.
 */
async function sendMail({ host, port, secure, user, pass, from, to, subject, text }) {
  const salto = '\r\n';
  const cuerpo = Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const mensaje = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${cabecera(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    cuerpo,
    '',
    '',
  ].join(salto);

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

  enviar(socket, `MAIL FROM:<${from}>`);
  await esperar(250, 'remitente');
  enviar(socket, `RCPT TO:<${to}>`);
  await esperar(250, 'destinatario');
  enviar(socket, 'DATA');
  await esperar(354, 'datos');
  socket.write(mensaje + '.' + salto);
  await esperar(250, 'enviado');
  enviar(socket, 'QUIT');
  socket.end();
}

module.exports = { sendMail };
