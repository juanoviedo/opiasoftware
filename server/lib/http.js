'use strict';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webmanifest': 'application/manifest+json',
};

function mimeFor(file) {
  return MIME[file.slice(file.lastIndexOf('.')).toLowerCase()] || 'application/octet-stream';
}

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
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64.0.0/10)
  return false;
}

/**
 * La IP real solo se toma de cabeceras cuando hay un proxy de confianza.
 * Sin esa garantía, cualquier visitante podría falsear su ubicación.
 */
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return normalizeIp(String(cf).split(',')[0]);
    const xff = req.headers['x-forwarded-for'];
    if (xff) return normalizeIp(String(xff).split(',')[0]);
    const real = req.headers['x-real-ip'];
    if (real) return normalizeIp(real);
  }
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
  // Sin Secure el navegador descarta la cookie en producción HTTPS.
  // En http://localhost los navegadores sí aceptan cookies sin Secure.
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

function sendText(res, status, text, headers = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
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

async function readJsonBody(req, limitBytes = 8192) {
  const raw = await readBody(req, limitBytes);
  if (!raw) return {};
  return JSON.parse(raw);
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

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-XSS-Protection': '1; mode=block',
};

module.exports = {
  mimeFor,
  normalizeIp,
  isPrivateIp,
  clientIp,
  parseCookies,
  serializeCookie,
  sendJson,
  sendText,
  readBody,
  readJsonBody,
  truncate,
  clean,
  SECURITY_HEADERS,
};
