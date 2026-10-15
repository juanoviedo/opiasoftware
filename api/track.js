'use strict';

/** POST /api/track — página vistas y eventos del beacon. */

const H = require('./_lib/http');
const { makeLimiter } = require('./_lib/limit');
const { isBot, isSocialPreview } = require('./_lib/bots');
const { parseUserAgent } = require('./_lib/ua');
const { classifyTraffic } = require('./_lib/analytics');
const geo = require('./_lib/geo');
const db = require('./_lib/supabase');

const limiter = makeLimiter(60, 60_000);

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

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
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
  if (!limiter(ip)) return H.sendJson(res, 429, { ok: false, error: 'rate_limited' });

  let body;
  try {
    body = await H.readBodyParsed(req, 4096);
  } catch (err) {
    return H.sendJson(res, err.status === 413 ? 413 : 400, { ok: false, error: 'bad_payload' });
  }

  const { pathname, search } = safePath(body.p);
  // No rastrear el propio panel ni los endpoints: inflaría las métricas.
  if (pathname.startsWith('/opadmin') || pathname.startsWith('/api/') || pathname.startsWith('/__opia/')) {
    return H.sendJson(res, 202, { ok: true, skipped: true });
  }

  const userAgent = H.clean(req.headers['user-agent'], 400);
  const ref = H.clean(body.r, 300);
  const params = mergedParams(search, body.ft);
  const { source, adNetwork, refHost } = classifyTraffic(ref, params);
  const utm = utmFrom(params);
  const ua = parseUserAgent(userAgent);
  const internal = H.isPrivateIp(ip);

  const record = {
    t: new Date().toISOString(),
    ev: ['pageview', 'whatsapp', 'lead', 'form_start'].includes(H.clean(body.ev, 20)) ? H.clean(body.ev, 20) : 'pageview',
    vid: H.clean(body.vid, 64),
    sid: H.clean(body.sid, 64),
    ip,
    iph: '',
    path: pathname,
    q: search,
    ref,
    refHost,
    source,
    ad: adNetwork || '',
    ...utm,
    ti: H.clean(body.ti, 200),
    ua: userAgent,
    device: ua.device,
    os: ua.os,
    browser: ua.browser,
    sw: clampInt(body.sw, 0, 20_000, 0),
    sh: clampInt(body.sh, 0, 20_000, 0),
    lang: H.clean(body.lang, 20),
    tz: typeof body.tz === 'number' ? body.tz : null,
    bot: isBot(userAgent),
    preview: isSocialPreview(userAgent),
    internal,
    href: body.href ? H.clean(body.href, 300) : '',
  };

  if (!record.bot && !internal) record.geo = await geo.lookup(ip);

  try {
    await db.insert('visits', db.toVisitRow(record));
  } catch (err) {
    console.error('[track] Supabase:', err.message);
    return H.sendJson(res, 503, { ok: false, error: 'storage_unavailable' });
  }
  H.sendJson(res, 202, { ok: true });
};
