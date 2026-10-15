'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const config = require('./config');
const { parseCookies, serializeCookie } = require('./http');

const COOKIE_NAME = 'opia_admin';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${derived.toString('hex')}`;
}

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

function loadAdmin() {
  try {
    const raw = JSON.parse(fs.readFileSync(config.adminFile, 'utf8'));
    if (raw && raw.hash) return raw;
  } catch {
    return null;
  }
  return null;
}

function saveAdmin(user, hash) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(config.adminFile, JSON.stringify({ user, hash, updatedAt: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  });
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payload) {
  const body = base64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
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

function createSession(user, res, secure) {
  const exp = Date.now() + config.sessionTtlMinutes * 60 * 1000;
  const token = sign({ u: user, exp, jti: crypto.randomBytes(8).toString('hex') });
  res.setHeader(
    'Set-Cookie',
    serializeCookie(COOKIE_NAME, token, {
      maxAgeSeconds: config.sessionTtlMinutes * 60,
      path: '/',
      httpOnly: true,
      sameSite: 'Strict',
      secure,
    })
  );
  return token;
}

function destroySession(res) {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(COOKIE_NAME, '', { maxAgeSeconds: 0, path: '/', httpOnly: true, sameSite: 'Strict', secure: false })
  );
}

function currentUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const payload = unsign(cookies[COOKIE_NAME]);
  const admin = loadAdmin();
  // Modo abierto a pedido del dueño: sin contraseña configurada el panel no exige
  // login. En cuanto exista admin.json, la sesión vuelve a ser obligatoria.
  if (!admin) return config.adminUser;
  if (!payload) return null;
  return payload.u === admin.user ? payload.u : null;
}

/** Límite simple por IP para frenar fuerza bruta contra el login. */
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
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  loadAdmin,
  saveAdmin,
  createSession,
  destroySession,
  currentUser,
  loginAllowed,
  loginSucceeded,
};
