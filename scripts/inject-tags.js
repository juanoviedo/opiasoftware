'use strict';

/**
 * Hornea en cada página pública del sitio los tags que el servidor local
 * inyectaba en tiempo real. En Vercel el HTML es estático: la inyección
 * tiene que quedar escrita en el archivo.
 *
 *   node scripts/inject-tags.js
 *
 * Lee los IDs de server/ads-config.json (mismo formato que el servidor
 * local). Es idempotente: se puede correr las veces que haga falta y solo
 * agrega lo que falte (GA4/GTM por un lado, beacon+conversions por otro).
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ADS_CONFIG = path.join(ROOT, 'server', 'ads-config.json');

// Directorios que no son páginas públicas del sitio.
const EXCLUDE_DIRS = new Set(['.git', '.tools', 'node_modules', 'server', 'opadmin', '.vercel']);
const EXCLUDE_PATHS = new Set(['marketing/plan-leads']);

function readAds() {
  try {
    const raw = JSON.parse(fs.readFileSync(ADS_CONFIG, 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch {
    // sin archivo: solo se hornean beacon y conversions
  }
  return {};
}

function validId(primary, secondary) {
  const value = String(primary || secondary || '').trim();
  return /^(G-[A-Z0-9]{6,}|AW-\d{6,}|GTM-[A-Z0-9]+|UA-\d+-\d+)$/.test(value) ? value : '';
}

/** Mismo bloque que inyectaba server/lib/static.js, con el guard de localhost
 *  que ya usa el Pixel: las pruebas en local no contaminan GA4. */
function buildAnalyticsHead(ads) {
  const gtmId = validId(ads.gtmId);
  const ga4Id = validId(ads.ga4Id);
  const googleAdsId = validId(ads.googleAdsId);

  if (gtmId) {
    return `<!-- Google Tag Manager --><script>if(!['localhost','127.0.0.1','::1','[::1]'].includes(window.location.hostname)){(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${gtmId}');}</script><!-- End Google Tag Manager -->`;
  }

  if (ga4Id || googleAdsId) {
    const primary = ga4Id || googleAdsId;
    const configs = [];
    if (ga4Id) configs.push(`gtag('config','${ga4Id}');`);
    if (googleAdsId) configs.push(`gtag('config','${googleAdsId}');`);
    const leadSend = googleAdsId && ads.googleAdsLeadLabel ? `'${googleAdsId}/${ads.googleAdsLeadLabel}'` : "''";
    const contactSend = googleAdsId && ads.googleAdsContactLabel ? `'${googleAdsId}/${ads.googleAdsContactLabel}'` : "''";
    const currency = String(ads.currency || 'COP').toUpperCase();

    return (
      `<!-- Google tag --><script async src="https://www.googletagmanager.com/gtag/js?id=${primary}"></script>` +
      `<script>if(!['localhost','127.0.0.1','::1','[::1]'].includes(window.location.hostname)){` +
      `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}` +
      `gtag('js',new Date());${configs.join('')}` +
      `window.opiaAds={lead:${leadSend},contact:${contactSend},currency:'${currency}'};` +
      `window.opiaConvert=function(kind,value){try{var to=window.opiaAds[kind];` +
      `if(to)gtag('event','conversion',{send_to:to,value:value||0,currency:window.opiaAds.currency});` +
      `gtag('event',kind==='lead'?'generate_lead':'contact',{value:value||0,currency:window.opiaAds.currency});}catch(e){}};` +
      `}</script><!-- End Google tag -->`
    );
  }

  return '';
}

const TRACKING_SCRIPTS = '<script src="/__opia/beacon.js" defer></script>\n<script src="/__opia/conversions.js" defer></script>';

const HAS_ANALYTICS = /googletagmanager\.com\/(gtag\/js|gtm\.js)/;
const HAS_TRACKING = /<script[^>]+src=["']\/__opia\/conversions\.js["']/;

function listHtmlFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      listHtmlFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      const rel = path.relative(ROOT, path.join(dir, entry.name)).split(path.sep).join('/');
      if (EXCLUDE_PATHS.has(path.dirname(rel))) continue;
      out.push(rel);
    }
  }
  return out;
}

function insertBeforeHeadEnd(html, block) {
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${block}\n</head>`);
  return `${block}\n${html}`;
}

function main() {
  const ads = readAds();
  const analyticsHead = buildAnalyticsHead(ads);
  const files = listHtmlFiles(ROOT);

  let addedAnalytics = 0;
  let addedTracking = 0;
  let untouched = 0;

  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    let html = fs.readFileSync(abs, 'utf8');
    const original = html;

    if (analyticsHead && !HAS_ANALYTICS.test(html)) {
      html = insertBeforeHeadEnd(html, analyticsHead);
      addedAnalytics += 1;
    }
    if (!HAS_TRACKING.test(html)) {
      html = insertBeforeHeadEnd(html, TRACKING_SCRIPTS);
      addedTracking += 1;
    }

    if (html !== original) {
      fs.writeFileSync(abs, html);
      console.log(`  ${rel}`);
    } else {
      untouched += 1;
    }
  }

  console.log(`\nPáginas revisadas: ${files.length}`);
  console.log(`  GA4/GTM agregado: ${addedAnalytics}${analyticsHead ? '' : '  (sin IDs en server/ads-config.json: corre de nuevo cuando existan)'}`);
  console.log(`  beacon+conversions agregado: ${addedTracking}`);
  console.log(`  ya estaban completas: ${untouched}`);
}

main();
