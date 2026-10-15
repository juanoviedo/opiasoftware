'use strict';

/**
 * Cliente mínimo de Supabase por REST (PostgREST) con fetch nativo.
 * Cero dependencias: las funciones de Vercel no necesitan npm install.
 */

const BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || '';

function assertConfig() {
  if (!BASE || !KEY) {
    const err = new Error('SUPABASE_URL y SUPABASE_SERVICE_KEY no están definidos. Configúralos en Vercel > Project Settings > Environment Variables.');
    err.status = 503;
    throw err;
  }
}

async function rest(path, init = {}) {
  assertConfig();
  const res = await fetch(`${BASE}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Supabase ${res.status} en ${path}: ${body.slice(0, 300)}`);
    err.status = 502;
    throw err;
  }
  return res;
}

async function insert(table, rows) {
  await rest(table, {
    method: 'POST',
    body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
    headers: { Prefer: 'return=minimal' },
  });
}

async function selectSince(table, sinceIso, { limit = 30000 } = {}) {
  const res = await rest(`${table}?select=*&t=gte.${encodeURIComponent(sinceIso)}&order=t.asc&limit=${limit}`);
  return res.json();
}

async function countRows(table) {
  const res = await rest(`${table}?select=id&limit=1`, { headers: { Prefer: 'count=exact' } });
  const range = res.headers.get('content-range'); // p.ej. "0-0/1234" o "*/0"
  const total = range && range.split('/')[1];
  return total && total !== '*' ? Number(total) : 0;
}

/* Mapeo entre las claves del registro JS y las columnas de la base. */

const VISIT_COLS = {
  t: 't', ev: 'ev', vid: 'vid', sid: 'sid', ip: 'ip', iph: 'iph',
  path: 'path', q: 'q', ref: 'ref', refHost: 'refhost', source: 'source', ad: 'ad',
  src_utm: 'src_utm', med: 'med', cmp: 'cmp', cnt: 'cnt', trm: 'trm',
  fbclid: 'fbclid', gclid: 'gclid', ti: 'ti', ua: 'ua',
  device: 'device', os: 'os', browser: 'browser', sw: 'sw', sh: 'sh',
  lang: 'lang', tz: 'tz', bot: 'bot', preview: 'preview', internal: 'internal',
  href: 'href', geo: 'geo',
};

const LEAD_COLS = {
  t: 't', name: 'name', email: 'email', phone: 'phone', company: 'company',
  role: 'role', service: 'service', message: 'message', urgency: 'urgency',
  page: 'page', ref: 'ref', refHost: 'refhost', source: 'source', ad: 'ad',
  src_utm: 'src_utm', med: 'med', cmp: 'cmp', cnt: 'cnt', trm: 'trm',
  fbclid: 'fbclid', gclid: 'gclid', ip: 'ip', iph: 'iph', ua: 'ua',
  device: 'device', os: 'os', browser: 'browser', bot: 'bot', internal: 'internal',
  status: 'status', geo: 'geo',
};

function pick(record, map) {
  const out = {};
  for (const key of Object.keys(map)) {
    const value = record[key];
    out[map[key]] = value === undefined ? null : value;
  }
  return out;
}

function unpick(row, map) {
  const out = {};
  for (const key of Object.keys(map)) {
    out[key] = row[map[key]] === undefined ? null : row[map[key]];
  }
  return out;
}

module.exports = {
  insert,
  selectSince,
  countRows,
  toVisitRow: (record) => pick(record, VISIT_COLS),
  toLeadRow: (record) => pick(record, LEAD_COLS),
  fromVisitRow: (row) => unpick(row, VISIT_COLS),
  fromLeadRow: (row) => unpick(row, LEAD_COLS),
};
