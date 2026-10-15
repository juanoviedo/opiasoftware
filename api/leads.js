'use strict';

/** POST /api/leads — formulario de la landing de diagnóstico. */

const H = require('./_lib/http');
const { makeLimiter } = require('./_lib/limit');
const { isBot } = require('./_lib/bots');
const { parseUserAgent } = require('./_lib/ua');
const { classifyTraffic } = require('./_lib/analytics');
const geo = require('./_lib/geo');
const db = require('./_lib/supabase');

const limiter = makeLimiter(6, 60 * 60_000);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function safePath(value) {
  const raw = H.clean(value, 400);
  if (!raw.startsWith('/')) return { pathname: '/', search: '' };
  try {
    const url = new URL(raw, 'http://localhost');
    return { pathname: H.truncate(url.pathname, 300), search: H.truncate(url.search, 300) };
  } catch {
    return { pathname: '/', search: '' };
  }
}

function mergedParams(search, firstTouch) {
  const params = new URLSearchParams(search || '');
  if (firstTouch && typeof firstTouch === 'object') {
    for (const [key, value] of Object.entries(firstTouch)) {
      if (value && !params.has(key)) params.set(key, String(value));
    }
  }
  return params;
}

function utmFrom(params) {
  return {
    src_utm: H.clean(params.get('utm_source'), 120),
    med: H.clean(params.get('utm_medium'), 120),
    cmp: H.clean(params.get('utm_campaign'), 160),
    cnt: H.clean(params.get('utm_content'), 160),
    trm: H.clean(params.get('utm_term'), 120),
    fbclid: params.has('fbclid'),
    gclid: params.has('gclid') || params.has('gbraid') || params.has('wbraid'),
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return H.sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const ip = H.clientIp(req);
  if (!limiter(ip)) return H.sendJson(res, 429, { ok: false, error: 'Demasiados envíos. Intenta más tarde.' });

  let body;
  try {
    body = await H.readBodyParsed(req, 16_384);
  } catch (err) {
    return H.sendJson(res, err.status === 413 ? 413 : 400, { ok: false, error: 'Solicitud inválida.' });
  }

  // Trampa de spam: los bots rellenan campos ocultos, las personas no los ven.
  if (H.clean(body.website, 200) || H.clean(body.url_field, 200)) {
    return H.sendJson(res, 200, { ok: true });
  }

  const name = H.clean(body.name, 120).trim();
  const email = H.clean(body.email, 160).trim();
  const phone = H.clean(body.phone, 40).replace(/[^\d+()\-\s]/g, '').trim();
  const consent = body.consent === true || body.consent === 'true' || body.consent === 'on';

  const errors = {};
  if (name.length < 2) errors.name = 'Escribe tu nombre.';
  if (email && !EMAIL_RE.test(email)) errors.email = 'Ese correo no parece válido.';
  if (!email && !phone) errors.phone = 'Necesitamos un correo o un teléfono para responderte.';
  if (!consent) errors.consent = 'Debes autorizar el tratamiento de tus datos.';
  if (Object.keys(errors).length) return H.sendJson(res, 422, { ok: false, errors });

  const { pathname, search } = safePath(body.page || req.headers.referer || '');
  const referer = H.clean(req.headers.referer, 300);
  const params = mergedParams(search, body.ft);
  const { source, adNetwork, refHost } = classifyTraffic(referer, params);
  const userAgent = H.clean(req.headers['user-agent'], 400);
  const uaInfo = parseUserAgent(userAgent);
  const internal = H.isPrivateIp(ip);

  const lead = {
    t: new Date().toISOString(),
    name,
    email,
    phone,
    company: H.clean(body.company, 160).trim(),
    role: H.clean(body.role, 120).trim(),
    service: H.clean(body.service, 120).trim(),
    message: H.clean(body.message, 2000).trim(),
    urgency: H.clean(body.urgency, 120).trim(),
    page: pathname,
    ref: referer,
    refHost,
    source,
    ad: adNetwork || '',
    ...utmFrom(params),
    ip,
    iph: '',
    ua: userAgent,
    device: uaInfo.device,
    os: uaInfo.os,
    browser: uaInfo.browser,
    bot: isBot(userAgent),
    internal,
    status: 'nuevo',
  };

  if (!lead.bot && !internal) lead.geo = await geo.lookup(ip);

  try {
    await db.insert('leads', db.toLeadRow(lead));
    await db.insert('visits', db.toVisitRow({ ...lead, ev: 'lead', vid: H.clean(body.vid, 64), sid: H.clean(body.sid, 64), path: pathname, ti: '' }));
  } catch (err) {
    console.error('[leads] Supabase:', err.message);
    return H.sendJson(res, 503, { ok: false, error: 'No pudimos guardar tu solicitud. Escríbenos por WhatsApp y lo resolvemos contigo.' });
  }

  H.sendJson(res, 201, { ok: true });
};
