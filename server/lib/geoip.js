'use strict';

const config = require('./config');
const { isPrivateIp } = require('./http');

const DAY_MS = 24 * 60 * 60 * 1000;

const LOCAL_GEO = {
  cc: '',
  country: 'Red local',
  region: '',
  city: '',
  lat: null,
  lon: null,
  isp: 'privada',
  internal: true,
};

async function fetchJson(urlTemplate, ip, timeoutMs) {
  const url = urlTemplate.replace('{ip}', encodeURIComponent(ip));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'OPIA-Analytics/1.0' },
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function fromIpwho(data) {
  if (!data || data.success === false) return null;
  const conn = data.connection || {};
  return {
    cc: String(data.country_code || '').toUpperCase(),
    country: data.country || '',
    region: data.region || '',
    city: data.city || '',
    lat: typeof data.latitude === 'number' ? data.latitude : null,
    lon: typeof data.longitude === 'number' ? data.longitude : null,
    isp: conn.isp || conn.org || '',
    tz: (data.timezone && data.timezone.id) || '',
  };
}

function fromIpApiCo(data) {
  if (!data || data.error) return null;
  return {
    cc: String(data.country_code || '').toUpperCase(),
    country: data.country || '',
    region: data.region || '',
    city: data.city || '',
    lat: typeof data.latitude === 'number' ? data.latitude : null,
    lon: typeof data.longitude === 'number' ? data.longitude : null,
    isp: data.org || data.asn || '',
    tz: data.timezone || '',
  };
}

/**
 * Resolución de ubicación por IP con caché persistente.
 * La caché es la capa "offline": una IP ya vista nunca vuelve a salir a internet,
 * que es lo que mantiene el consumo muy por debajo del límite gratuito del proveedor.
 */
class GeoIp {
  constructor(cache) {
    this.cache = cache;
    this.inflight = new Set();
    this.queue = [];
    this.running = 0;
  }

  /** Solo lectura, síncrono. Devuelve null si todavía no se resolvió. */
  peek(ip) {
    if (!ip) return null;
    if (isPrivateIp(ip)) return LOCAL_GEO;
    const hit = this.cache.get(ip);
    if (!hit) return null;
    return hit;
  }

  needsLookup(ip) {
    if (!ip || isPrivateIp(ip)) return false;
    const hit = this.cache.get(ip);
    if (!hit) return true;
    const age = Date.now() - (hit.at || 0);
    if (hit.failed) return age > config.geoRetryMinutes * 60 * 1000;
    return age > config.geoCacheDays * DAY_MS;
  }

  enqueue(ip) {
    if (!this.needsLookup(ip) || this.inflight.has(ip)) return;
    this.inflight.add(ip);
    this.queue.push(ip);
    this.pump();
  }

  pump() {
    while (this.running < config.geoMaxConcurrent && this.queue.length) {
      const ip = this.queue.shift();
      this.running += 1;
      this.resolve(ip)
        .catch(() => {})
        .finally(() => {
          this.running -= 1;
          this.inflight.delete(ip);
          this.pump();
        });
    }
  }

  async resolve(ip) {
    if (isPrivateIp(ip)) {
      this.cache.set(ip, { ...LOCAL_GEO, at: Date.now() });
      return LOCAL_GEO;
    }

    const providers = [
      { url: config.geoPrimary, parse: fromIpwho },
      { url: config.geoFallback, parse: fromIpApiCo },
    ].filter((p) => p.url);

    for (const provider of providers) {
      try {
        const geo = provider.parse(await fetchJson(provider.url, ip, config.geoTimeoutMs));
        if (geo) {
          const record = { ...geo, at: Date.now(), failed: false };
          this.cache.set(ip, record);
          return record;
        }
      } catch {
        // pasa al siguiente proveedor
      }
    }

    this.cache.set(ip, { ...LOCAL_GEO, country: 'Desconocido', isp: '', at: Date.now(), failed: true });
    return null;
  }

  /** Cola todas las IP pendientes de una lista de registros. */
  hydrate(records, key = 'ip') {
    for (const r of records) this.enqueue(r[key]);
  }
}

module.exports = { GeoIp, LOCAL_GEO };
