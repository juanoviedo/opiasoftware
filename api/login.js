'use strict';

/** POST /api/login — sesión del panel /opadmin. */

const H = require('./_lib/http');
const auth = require('./_lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return H.sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const ip = H.clientIp(req);
  if (!auth.loginAllowed(ip)) {
    return H.sendJson(res, 429, { ok: false, error: 'Demasiados intentos. Espera 15 minutos.' });
  }

  if (!auth.ADMIN_HASH || !process.env.OPIA_SESSION_SECRET) {
    return H.sendJson(res, 503, {
      ok: false,
      error: 'El panel no tiene contraseña configurada. Genera OPIA_ADMIN_HASH y OPIA_SESSION_SECRET con: node server/scripts/hash-password.js',
    });
  }

  let body;
  try {
    body = await H.readBodyParsed(req, 4096);
  } catch {
    return H.sendJson(res, 400, { ok: false, error: 'Solicitud inválida.' });
  }

  const user = H.clean(body.user, 80);
  const password = String(body.password || '');
  if (user !== auth.ADMIN_USER || !auth.verifyPassword(password, auth.ADMIN_HASH)) {
    return H.sendJson(res, 401, { ok: false, error: 'Usuario o contraseña incorrectos.' });
  }

  auth.loginSucceeded(ip);
  auth.createSession(user, res);
  H.sendJson(res, 200, { ok: true, user });
};
