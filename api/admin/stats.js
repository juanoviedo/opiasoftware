'use strict';

/** GET /api/admin/stats?days=30 — datos del panel /opadmin. */

const H = require('../_lib/http');
const { makeLimiter } = require('../_lib/limit');
const auth = require('../_lib/auth');
const { buildStats } = require('../_lib/analytics');
const db = require('../_lib/supabase');

const limiter = makeLimiter(120, 60_000);

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return H.sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const user = auth.currentUser(req);
  if (!user) return H.sendJson(res, 401, { ok: false, error: 'unauthorized' }, { 'X-Robots-Tag': 'noindex, nofollow' });

  const ip = H.clientIp(req);
  if (!limiter(ip)) return H.sendJson(res, 429, { ok: false, error: 'rate_limited' });

  const url = new URL(req.url, 'http://localhost');
  const days = clampInt(url.searchParams.get('days'), 1, 365, 30);
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();

  let visitRows;
  let leadRows;
  try {
    [visitRows, leadRows] = await Promise.all([
      db.selectSince('visits', sinceIso, { limit: 30000 }),
      db.selectSince('leads', sinceIso, { limit: 5000 }),
    ]);
  } catch (err) {
    console.error('[stats] Supabase:', err.message);
    return H.sendJson(res, 503, { ok: false, error: 'storage_unavailable' });
  }

  const [storedVisits, storedLeads] = await Promise.all([
    db.countRows('visits').catch(() => null),
    db.countRows('leads').catch(() => null),
  ]);

  const stats = buildStats({
    records: visitRows.map(db.fromVisitRow),
    leads: leadRows.map(db.fromLeadRow),
    days,
  });

  stats.admin = {
    user,
    retentionDays: 90,
    storedVisits: storedVisits ?? visitRows.length,
    storedLeads: storedLeads ?? leadRows.length,
    cachedIps: 0,
    trustProxy: true,
    publicUrl: process.env.OPIA_PUBLIC_URL || '',
  };

  H.sendJson(res, 200, stats);
};
