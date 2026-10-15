'use strict';

/** Utilidades HTTP para las funciones de Vercel (req/res estilo Node http). */

function normalizeIp(raw) {
  if (!raw) return '';
  let ip = String(raw).trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1];
  if (ip === '::1') ip = '127.0.0.1';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === 'localhost' || ip === '::1' || ip === '::') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true;
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) return false;
  const [a, b] = [Number(parts[0]), Number(parts[1])];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * En Vercel el tráfico pasa por su proxy: x-forwarded-for es confiable.
 */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return normalizeIp(String(xff).split(',')[0]);
  const real = req.headers['x-real-ip'];
  if (real) return normalizeIp(real);
  return normalizeIp((req.socket && req.socket.remoteAddress) || '');
}

function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

function serializeCookie(name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAgeSeconds !== undefined) bits.push(`Max-Age=${Math.floor(opts.maxAgeSeconds)}`);
  bits.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly !== false) bits.push('HttpOnly');
  bits.push(`SameSite=${opts.sameSite || 'Strict'}`);
  if (opts.secure) bits.push('Secure');
  return bits.join('; ');
}

function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function readBody(req, limitBytes = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('payload_too_large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readBodyParsed(req, limitBytes = 8192) {
  const raw = await readBody(req, limitBytes);
  if (!raw) return {};
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json')) return JSON.parse(raw);
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return {};
}

function truncate(value, max) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

/** Quita caracteres de control y recorta. Nada de esto se interpola como HTML. */
function clean(value, max = 512) {
  if (value === null || value === undefined) return '';
  return truncate(String(value), max).replace(/[\u0000-\u001F\u007F]/g, '');
}

module.exports = {
  normalizeIp,
  isPrivateIp,
  clientIp,
  parseCookies,
  serializeCookie,
  sendJson,
  readBody,
  readBodyParsed,
  truncate,
  clean,
};
