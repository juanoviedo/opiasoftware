'use strict';

/**
 * Sesión del panel /opadmin sin archivos: usuario, hash scrypt y secreto
 * llegan por variables de entorno de Vercel.
 *
 *   OPIA_ADMIN_USER      (default: opia)
 *   OPIA_ADMIN_HASH      (generado con: node server/scripts/hash-password.js)
 *   OPIA_SESSION_SECRET  (hex aleatorio de 64 caracteres)
 */

const crypto = require('node:crypto');
const { parseCookies, serializeCookie } = require('./http');

const COOKIE_NAME = 'opia_admin';
const ADMIN_USER = process.env.OPIA_ADMIN_USER || 'opia';
const ADMIN_HASH = process.env.OPIA_ADMIN_HASH || '';
const SESSION_SECRET = process.env.OPIA_SESSION_SECRET || '';
const TTL_MINUTES = Number.parseInt(process.env.OPIA_SESSION_TTL_MINUTES, 10) || 720;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, hashHex] = parts;
  const derived = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), Buffer.from(hashHex, 'hex').length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * Number(N) * Number(r) * 2,
  });
  const expected = Buffer.from(hashHex, 'hex');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token) {
  if (!token || typeof token !== 'string' || !SESSION_SECRET) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function createSession(user, res) {
  const exp = Date.now() + TTL_MINUTES * 60 * 1000;
  const token = sign({ u: user, exp, jti: crypto.randomBytes(8).toString('hex') });
  res.setHeader(
    'Set-Cookie',
    serializeCookie(COOKIE_NAME, token, {
      maxAgeSeconds: TTL_MINUTES * 60,
      path: '/',
      httpOnly: true,
      sameSite: 'Strict',
      secure: true,
    })
  );
  return token;
}

function destroySession(res) {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(COOKIE_NAME, '', { maxAgeSeconds: 0, path: '/', httpOnly: true, sameSite: 'Strict', secure: true })
  );
}

function currentUser(req) {
  if (!ADMIN_HASH || !SESSION_SECRET) return null;
  const cookies = parseCookies(req.headers.cookie);
  const payload = unsign(cookies[COOKIE_NAME]);
  if (!payload) return null;
  return payload.u === ADMIN_USER ? payload.u : null;
}

/** Freno best-effort por instancia contra fuerza bruta. */
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function loginAllowed(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.start > WINDOW_MS) {
    attempts.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= MAX_ATTEMPTS;
}

function loginSucceeded(ip) {
  attempts.delete(ip);
}

module.exports = {
  ADMIN_USER,
  ADMIN_HASH,
  verifyPassword,
  createSession,
  destroySession,
  currentUser,
  loginAllowed,
  loginSucceeded,
};
