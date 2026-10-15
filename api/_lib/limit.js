'use strict';

/**
 * Límite por IP en memoria. En Vercel cada instancia de función tiene su
 * propio mapa: es un freno best-effort, no una garantía global.
 */
function makeLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  };
}

module.exports = { makeLimiter };
