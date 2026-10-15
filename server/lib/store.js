'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Almacenamiento append-only en JSONL: una línea por registro.
 * Sin dependencias nativas ni base de datos que compilar, que es lo que
 * suele romper un despliegue en un servidor local Windows.
 */
class JsonlStore {
  constructor(file) {
    this.file = file;
    this.cache = null;
    this.cacheStamp = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  append(record) {
    fs.appendFileSync(this.file, JSON.stringify(record) + '\n', 'utf8');
  }

  #stamp() {
    try {
      const st = fs.statSync(this.file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return 'none';
    }
  }

  /** Lee y cachea. El dashboard consulta mucho y el archivo cambia poco. */
  readAll() {
    const stamp = this.#stamp();
    if (this.cache && this.cacheStamp === stamp) return this.cache;
    let rows = [];
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          // línea truncada por un corte de energía: se descarta, no tira el panel
        }
      }
    } catch {
      rows = [];
    }
    this.cache = rows;
    this.cacheStamp = stamp;
    return rows;
  }

  readSince(isoTime) {
    const cutoff = Date.parse(isoTime);
    if (!Number.isFinite(cutoff)) return this.readAll();
    return this.readAll().filter((r) => {
      const t = Date.parse(r.t);
      return Number.isFinite(t) ? t >= cutoff : false;
    });
  }

  /** Reescribe el archivo conservando solo lo posterior a cutoffIso. */
  prune(cutoffIso) {
    const cutoff = Date.parse(cutoffIso);
    if (!Number.isFinite(cutoff)) return 0;
    const all = this.readAll();
    const kept = all.filter((r) => {
      const t = Date.parse(r.t);
      return Number.isFinite(t) && t >= cutoff;
    });
    const removed = all.length - kept.length;
    if (removed <= 0) return 0;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, this.file);
    this.cache = null;
    this.cacheStamp = null;
    return removed;
  }

  count() {
    return this.readAll().length;
  }
}

/** Mapa JSON persistente con escritura diferida. */
class JsonMap {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    this.dirty = false;
    this.timer = null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(raw)) this.map.set(k, v);
    } catch {
      this.map = new Map();
    }
  }

  get(key) {
    return this.map.get(key);
  }

  set(key, value) {
    this.map.set(key, value);
    this.scheduleFlush();
  }

  delete(key) {
    const had = this.map.delete(key);
    if (had) this.scheduleFlush();
    return had;
  }

  get size() {
    return this.map.size;
  }

  entries() {
    return this.map.entries();
  }

  scheduleFlush(delayMs = 1500) {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delayMs);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const obj = Object.create(null);
    for (const [k, v] of this.map) obj[k] = v;
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {
      // si el disco falla, la caché en memoria sigue sirviendo
    }
  }
}

module.exports = { JsonlStore, JsonMap };
