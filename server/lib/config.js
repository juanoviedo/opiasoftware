'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const SERVER_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(SERVER_DIR, '..');

const DATA_DIR = process.env.OPIA_DATA_DIR
  ? path.resolve(process.env.OPIA_DATA_DIR)
  : path.join(SERVER_DIR, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

function readOrCreateSecret() {
  const file = path.join(DATA_DIR, 'secret.key');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // first run
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function flag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Los identificadores de publicidad viven en un archivo editable, no solo en
 * variables de entorno: quien administra el sitio no tiene que pelearse con el
 * shell para pegar un ID de GA4. Las variables de entorno tienen prioridad.
 */
function readAdsConfig() {
  const file = path.join(SERVER_DIR, 'ads-config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch {
    // sin archivo o inválido: se usan las variables de entorno o queda vacío
  }
  return {};
}

const ads = readAdsConfig();

function id(primary, secondary) {
  const value = String(primary || secondary || '').trim();
  return /^(G-[A-Z0-9]{6,}|AW-\d{6,}|GTM-[A-Z0-9]+|UA-\d+-\d+)$/.test(value) ? value : '';
}

const config = {
  serverDir: SERVER_DIR,
  repoRoot: REPO_ROOT,
  dataDir: DATA_DIR,
  publicRoot: process.env.OPIA_PUBLIC_ROOT
    ? path.resolve(process.env.OPIA_PUBLIC_ROOT)
    : REPO_ROOT,

  host: process.env.OPIA_HOST || '0.0.0.0',
  port: int(process.env.OPIA_PORT, 3000),
  publicUrl: (process.env.OPIA_PUBLIC_URL || '').replace(/\/+$/, ''),

  // Detrás de Cloudflare Tunnel / nginx la IP real viene en cabeceras.
  // Solo activar cuando el proxy es de confianza, si no el cliente puede falsearla.
  trustProxy: flag(process.env.OPIA_TRUST_PROXY),

  adminUser: process.env.OPIA_ADMIN_USER || 'opia',
  adminFile: path.join(DATA_DIR, 'admin.json'),
  sessionSecret: readOrCreateSecret(),
  sessionTtlMinutes: int(process.env.OPIA_SESSION_TTL_MINUTES, 720),

  retentionDays: int(process.env.OPIA_RETENTION_DAYS, 90),
  timezone: process.env.OPIA_TZ || 'America/Bogota',

  geoPrimary: process.env.OPIA_GEO_PRIMARY || 'https://ipwho.is/{ip}',
  geoFallback: process.env.OPIA_GEO_FALLBACK || 'https://ipapi.co/{ip}/json/',
  geoTimeoutMs: int(process.env.OPIA_GEO_TIMEOUT_MS, 3000),
  geoCacheDays: int(process.env.OPIA_GEO_CACHE_DAYS, 30),
  geoRetryMinutes: int(process.env.OPIA_GEO_RETRY_MINUTES, 60),
  geoMaxConcurrent: int(process.env.OPIA_GEO_MAX_CONCURRENT, 3),

  trackEnabled: process.env.OPIA_TRACK_ENABLED !== 'false',
  // Registra visitas desde IPs privadas/locales marcándolas como internas.
  trackInternal: process.env.OPIA_TRACK_INTERNAL !== 'false',

  // Medición de pauta. Vacíos = no se inyecta nada y el sitio sigue funcionando.
  ga4Id: id(process.env.OPIA_GA4_ID, ads.ga4Id),
  googleAdsId: id(process.env.OPIA_GOOGLE_ADS_ID, ads.googleAdsId),
  googleAdsLeadLabel: String(process.env.OPIA_ADS_LEAD_LABEL || ads.googleAdsLeadLabel || '').trim(),
  googleAdsContactLabel: String(process.env.OPIA_ADS_CONTACT_LABEL || ads.googleAdsContactLabel || '').trim(),
  gtmId: id(process.env.OPIA_GTM_ID, ads.gtmId),
  adsCurrency: String(ads.currency || process.env.OPIA_ADS_CURRENCY || 'COP').toUpperCase(),
};

module.exports = config;
