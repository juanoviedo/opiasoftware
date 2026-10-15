'use strict';

/**
 * Geolocalización best-effort en la propia función, con caché por instancia.
 * El servidor local lo resolvía en segundo plano; en serverless se hace en
 * línea con timeout corto para no demorar la respuesta más de lo justo.
 */

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 2500;
const cache = new Map();

async function fetchJson(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'opia-geo/1.0' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function fromIpwho(d) {
  if (!d || d.success === false) return null;
  return {
    country: d.country || '',
    cc: d.country_code || '',
    region: d.region || '',
    city: d.city || '',
    lat: typeof d.latitude === 'number' ? d.latitude : null,
    lon: typeof d.longitude === 'number' ? d.longitude : null,
    isp: (d.connection && d.connection.isp) || '',
  };
}

function fromIpapi(d) {
  if (!d || d.error) return null;
  return {
    country: d.country_name || '',
    cc: d.country_code || '',
    region: d.region || '',
    city: d.city || '',
    lat: typeof d.latitude === 'number' ? d.latitude : null,
    lon: typeof d.longitude === 'number' ? d.longitude : null,
    isp: d.org || '',
  };
}

async function lookup(ip) {
  if (!ip || ip === 'unknown') return null;
  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.geo;

  let geo = fromIpwho(await fetchJson(`https://ipwho.is/${encodeURIComponent(ip)}`));
  if (!geo) geo = fromIpapi(await fetchJson(`https://ipapi.co/${encodeURIComponent(ip)}/json/`));
  if (geo && geo.country) cache.set(ip, { geo, at: Date.now() });
  return geo || null;
}

module.exports = { lookup };
