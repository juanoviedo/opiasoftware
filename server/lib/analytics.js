'use strict';

const config = require('./config');

const SOURCE_RULES = [
  { name: 'Facebook', test: /(^|\.)(facebook\.com|fb\.com|fb\.me|m\.facebook\.com|l\.facebook\.com|lm\.facebook\.com)$/i },
  { name: 'Instagram', test: /(^|\.)(instagram\.com|l\.instagram\.com|lm\.instagram\.com)$/i },
  { name: 'WhatsApp', test: /(^|\.)(wa\.me|whatsapp\.com|web\.whatsapp\.com)$/i },
  { name: 'Google', test: /(^|\.)(google\.[a-z.]+|bing\.com)$/i },
  { name: 'LinkedIn', test: /(^|\.)(linkedin\.com|lnkd\.in)$/i },
  { name: 'X / Twitter', test: /(^|\.)(t\.co|twitter\.com|x\.com)$/i },
  { name: 'YouTube', test: /(^|\.)(youtube\.com|youtu\.be)$/i },
  { name: 'TikTok', test: /(^|\.)(tiktok\.com)$/i },
];

function hostOf(ref) {
  if (!ref) return '';
  try {
    return new URL(ref).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/**
 * Clasifica la procedencia. "Meta Ads" se detecta por fbclid, que es la señal
 * real de un clic pagado: sin evento de conversión, el referer de Facebook
 * llega enmascarado por l.facebook.com y no distingue orgánico de pagado.
 */
function classifyTraffic(ref, query) {
  const fbclid = query.get('fbclid');
  const gclid = query.get('gclid') || query.get('gbraid') || query.get('wbraid');
  const utmSource = (query.get('utm_source') || '').toLowerCase();
  const utmMedium = (query.get('utm_medium') || '').toLowerCase();
  const host = hostOf(ref);

  let adNetwork = null;
  if (fbclid) adNetwork = 'meta';
  else if (gclid) adNetwork = 'google';
  else if (/cpc|ppc|paid|paidsocial|paidsocial/.test(utmMedium)) adNetwork = /google/.test(utmSource) ? 'google' : 'meta';

  let source = 'Directo';
  for (const rule of SOURCE_RULES) {
    if (host && rule.test.test(host)) {
      source = rule.name;
      break;
    }
  }
  if (source === 'Directo' && utmSource) {
    source = utmSource.charAt(0).toUpperCase() + utmSource.slice(1);
  }

  return { source, adNetwork, refHost: host };
}

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const hourFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: config.timezone,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Fecha y hora en la zona configurada: la franja 5-9 pm se mide en hora Colombia. */
function localParts(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '1970-01-01', hour: 0, hm: '00:00' };
  const hm = hourFormatter.format(d);
  return { date: dateFormatter.format(d), hour: Number(hm.slice(0, 2)), hm };
}

function bump(map, key, field = 'visits') {
  if (!key) key = '(sin dato)';
  const entry = map.get(key) || { key, visits: 0, uniques: new Set() };
  entry[field] = (entry[field] || 0) + 1;
  map.set(key, entry);
  return entry;
}

/** Crea la entrada sin contar visita: un lead puede caer en un día sin tráfico. */
function newDay(map, key) {
  let entry = map.get(key);
  if (!entry) {
    entry = { key, visits: 0, leads: 0, uniques: new Set() };
    map.set(key, entry);
  }
  return entry;
}

function finalize(map, sortKey = 'visits', limit = 25) {
  return [...map.values()]
    .map((e) => ({ ...e, uniques: e.uniques ? e.uniques.size : 0 }))
    .sort((a, b) => b[sortKey] - a[sortKey] || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function geoOf(record, geoCache) {
  if (record.geo) return record.geo;
  const cached = record.ip ? geoCache.get(record.ip) : null;
  return cached || { country: 'Pendiente', cc: '', region: '', city: '', isp: '' };
}

/**
 * Agrega todo lo que necesita el panel en una pasada.
 * Excluye bots e internas de las métricas de negocio, pero las reporta aparte:
 * si el 90 % del tráfico son bots, esa es la razón de "cero leads".
 */
function buildStats({ records, leads, geoCache, days = 30, limitRecent = 150 }) {
  const now = Date.now();
  const since = now - days * 24 * 60 * 60 * 1000;

  const totals = {
    visits: 0,
    uniques: new Set(),
    sessions: new Set(),
    humans: 0,
    bots: 0,
    internal: 0,
    adClicksMeta: 0,
    adClicksGoogle: 0,
    whatsappClicks: 0,
    leads: 0,
  };

  const byDate = new Map();
  const byHour = new Array(24).fill(0).map((_, h) => ({ hour: h, visits: 0, uniques: new Set() }));
  const byCountry = new Map();
  const byCity = new Map();
  const bySource = new Map();
  const byPage = new Map();
  const byDevice = new Map();
  const byBrowser = new Map();
  const byOs = new Map();
  const byCampaign = new Map();
  const byRefHost = new Map();
  const byIsp = new Map();
  const recent = [];

  for (const r of records) {
    const t = Date.parse(r.t);
    if (!Number.isFinite(t) || t < since) continue;

    if (r.bot) {
      totals.bots += 1;
      continue;
    }
    if (r.internal) {
      totals.internal += 1;
      continue;
    }

    const isEvent = r.ev && r.ev !== 'pageview';
    if (isEvent) {
      if (r.ev === 'whatsapp') totals.whatsappClicks += 1;
      continue; // los eventos no cuentan como página vista
    }

    totals.visits += 1;
    totals.humans += 1;
    if (r.vid) totals.uniques.add(r.vid);
    if (r.sid) totals.sessions.add(r.sid);
    if (r.ad === 'meta') totals.adClicksMeta += 1;
    if (r.ad === 'google') totals.adClicksGoogle += 1;

    const parts = localParts(r.t);
    const day = byDate.get(parts.date) || newDay(byDate, parts.date);
    day.visits += 1;
    if (r.vid) day.uniques.add(r.vid);

    const slot = byHour[parts.hour];
    slot.visits += 1;
    if (r.vid) slot.uniques.add(r.vid);

    const geo = geoOf(r, geoCache);
    const countryKey = `${geo.cc || '??'}|${geo.country || 'Desconocido'}`;
    const c = bump(byCountry, countryKey);
    if (r.vid) c.uniques.add(r.vid);

    const cityKey = [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || 'Desconocido';
    const city = bump(byCity, cityKey);
    city.cc = geo.cc || '';
    city.lat = geo.lat ?? null;
    city.lon = geo.lon ?? null;
    if (r.vid) city.uniques.add(r.vid);

    const src = bump(bySource, r.source);
    if (r.vid) src.uniques.add(r.vid);

    const page = bump(byPage, r.path);
    if (r.vid) page.uniques.add(r.vid);

    bump(byDevice, r.device);
    bump(byBrowser, r.browser);
    bump(byOs, r.os);

    if (r.refHost) {
      const rh = bump(byRefHost, r.refHost);
      if (r.vid) rh.uniques.add(r.vid);
    }
    if (geo.isp) {
      const isp = bump(byIsp, geo.isp);
      if (r.vid) isp.uniques.add(r.vid);
    }

    const campaign = r.cmp || (r.ad ? `(clic de anuncio ${r.ad})` : '');
    if (campaign) {
      const key = [r.src_utm, r.med, campaign].filter(Boolean).join(' / ') || campaign;
      const cm = bump(byCampaign, key);
      if (r.vid) cm.uniques.add(r.vid);
    }

    recent.push({
      t: r.t,
      local: `${parts.date} ${parts.hm}`,
      ip: r.ip,
      country: geo.country || '',
      cc: geo.cc || '',
      region: geo.region || '',
      city: geo.city || '',
      isp: geo.isp || '',
      path: r.path,
      source: r.source,
      ad: r.ad || '',
      ref: r.ref || '',
      device: r.device,
      os: r.os,
      browser: r.browser,
      vid: r.vid,
    });
  }

  recent.sort((a, b) => (a.t < b.t ? 1 : -1));

  const leadRows = [];
  for (const l of leads) {
    const t = Date.parse(l.t);
    if (!Number.isFinite(t) || t < since) continue;
    totals.leads += 1;
    const parts = localParts(l.t);
    const day = newDay(byDate, parts.date);
    day.leads = (day.leads || 0) + 1;
    const geo = geoOf(l, geoCache);
    leadRows.push({ ...l, local: `${parts.date} ${parts.hm}`, geoCity: geo.city || '', geoCountry: geo.country || '' });
  }
  leadRows.sort((a, b) => (a.t < b.t ? 1 : -1));

  const trend = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, visits: v.visits, uniques: v.uniques.size, leads: v.leads || 0 }));

  return {
    generatedAt: new Date().toISOString(),
    timezone: config.timezone,
    range: { days, since: new Date(since).toISOString(), until: new Date(now).toISOString() },
    totals: {
      visits: totals.visits,
      uniqueVisitors: totals.uniques.size,
      sessions: totals.sessions.size,
      humanVisits: totals.humans,
      botVisits: totals.bots,
      internalVisits: totals.internal,
      adClicksMeta: totals.adClicksMeta,
      adClicksGoogle: totals.adClicksGoogle,
      whatsappClicks: totals.whatsappClicks,
      leads: totals.leads,
      pagesPerSession: totals.sessions.size ? +(totals.visits / totals.sessions.size).toFixed(2) : 0,
    },
    trend,
    hourly: byHour.map((h) => ({ hour: h.hour, visits: h.visits, uniques: h.uniques.size })),
    countries: finalize(byCountry).map((c) => {
      const [cc, country] = c.key.split('|');
      return { cc, country, visits: c.visits, uniques: c.uniques };
    }),
    cities: finalize(byCity).map((c) => ({ city: c.key, cc: c.cc, lat: c.lat, lon: c.lon, visits: c.visits, uniques: c.uniques })),
    sources: finalize(bySource),
    refHosts: finalize(byRefHost),
    pages: finalize(byPage, 'visits', 40),
    devices: finalize(byDevice),
    browsers: finalize(byBrowser),
    operatingSystems: finalize(byOs),
    campaigns: finalize(byCampaign),
    isps: finalize(byIsp, 'visits', 15),
    leads: leadRows.slice(0, 200),
    recent: recent.slice(0, limitRecent),
    pendingGeo: records.filter((r) => r.ip && !r.bot && !r.internal && !geoCache.get(r.ip)).length,
  };
}

module.exports = { buildStats, classifyTraffic, localParts, hostOf };
