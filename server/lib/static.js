'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { mimeFor, SECURITY_HEADERS } = require('./http');

// Nada de esto debe servirse aunque exista dentro de la raíz pública.
// plan-leads y supabase no son páginas: documentación interna y esquemas.
// haztek es otro sitio (host virtual propio): servirse aquí duplicaría URLs.
const DENY_SEGMENTS = new Set(['server', 'node_modules', '.git', '.tools', 'scripts', 'plan-leads', 'supabase', 'haztek']);

const IMMUTABLE_PREFIXES = ['/assets/'];

/**
 * Todo lo que se inyecta en cada HTML. Se hace aquí y no editando las 11 páginas
 * prerenderizadas para que haya una sola fuente de verdad: si cambia un ID de
 * GA4 o de Google Ads, se cambia en server/ads-config.json y nada más.
 * Los IDs vienen validados por config.id(), así que no hay riesgo de inyección.
 */
function buildInjectedHead() {
  const parts = [];

  if (config.gtmId) {
    parts.push(
      `<!-- Google Tag Manager --><script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${config.gtmId}');</script><!-- End Google Tag Manager -->`
    );
  } else if (config.ga4Id || config.googleAdsId) {
    const primary = config.ga4Id || config.googleAdsId;
    const configs = [];
    if (config.ga4Id) configs.push(`gtag('config','${config.ga4Id}');`);
    if (config.googleAdsId) configs.push(`gtag('config','${config.googleAdsId}');`);
    const leadSend = config.googleAdsId && config.googleAdsLeadLabel ? `'${config.googleAdsId}/${config.googleAdsLeadLabel}'` : "''";
    const contactSend = config.googleAdsId && config.googleAdsContactLabel ? `'${config.googleAdsId}/${config.googleAdsContactLabel}'` : "''";

    parts.push(
      `<!-- Google tag --><script async src="https://www.googletagmanager.com/gtag/js?id=${primary}"></script>` +
        `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}` +
        `gtag('js',new Date());${configs.join('')}` +
        `window.opiaAds={lead:${leadSend},contact:${contactSend},currency:'${config.adsCurrency}'};` +
        `window.opiaConvert=function(kind,value){try{var to=window.opiaAds[kind];` +
        `if(to)gtag('event','conversion',{send_to:to,value:value||0,currency:window.opiaAds.currency});` +
        `gtag('event',kind==='lead'?'generate_lead':'contact',{value:value||0,currency:window.opiaAds.currency});}catch(e){}};` +
        `</script><!-- End Google tag -->`
    );
  }

  if (config.trackEnabled) parts.push('<script src="/__opia/beacon.js" defer></script>');
  parts.push('<script src="/__opia/conversions.js" defer></script>');
  return parts.join('\n');
}

const INJECTED_HEAD = buildInjectedHead();
const ALREADY_INJECTED = /<script[^>]+src=["']\/__opia\/conversions\.js["']/i;

function resolvePublicPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const relative = decoded.replace(/^\/+/, '');
  const full = path.resolve(config.publicRoot, relative);
  const rootWithSep = config.publicRoot.endsWith(path.sep) ? config.publicRoot : config.publicRoot + path.sep;
  if (full !== config.publicRoot && !full.startsWith(rootWithSep)) return null;

  const segments = path.relative(config.publicRoot, full).split(path.sep).filter(Boolean);
  if (segments.some((s) => s.startsWith('.') || DENY_SEGMENTS.has(s))) return null;

  return full;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * cleanUrls igual que Vercel: /contacto -> /contacto/index.html y
 * /contacto.html -> /contacto. Sin esto la migración rompe todos los enlaces.
 */
function findFile(target) {
  if (!target) return null;
  if (isFile(target)) return target;
  const withIndex = path.join(target, 'index.html');
  if (isFile(withIndex)) return withIndex;
  const withHtml = `${target}.html`;
  if (isFile(withHtml)) return withHtml;
  const withoutHtml = target.endsWith('.html') ? target.slice(0, -5) : null;
  if (withoutHtml && isFile(withoutHtml)) return withoutHtml;
  return null;
}

function cacheControlFor(urlPath, file) {
  if (IMMUTABLE_PREFIXES.some((p) => urlPath.startsWith(p)) || /[.-][0-9a-f]{8,}\.(js|css)$/.test(file)) {
    return 'public, max-age=31536000, immutable';
  }
  if (file.endsWith('.html')) return 'no-cache';
  return 'public, max-age=3600';
}

function injectTags(html) {
  if (!INJECTED_HEAD) return html;
  // El guard tiene que mirar la etiqueta, no la ruta suelta: un comentario que
  // mencione /__opia/conversions.js no es una inyección previa.
  if (ALREADY_INJECTED.test(html)) return html;
  const marker = /<\/head>/i;
  if (marker.test(html)) return html.replace(marker, `${INJECTED_HEAD}</head>`);
  return `${INJECTED_HEAD}${html}`;
}

function sendFile(res, req, file, urlPath, status = 200) {
  const isHtml = file.endsWith('.html') || file.endsWith('.htm');
  let body;
  try {
    body = fs.readFileSync(file);
  } catch {
    return false;
  }
  if (isHtml) {
    body = Buffer.from(injectTags(body.toString('utf8')), 'utf8');
  }
  res.writeHead(status, {
    'Content-Type': mimeFor(file),
    'Content-Length': body.length,
    'Cache-Control': cacheControlFor(urlPath, file),
    ...SECURITY_HEADERS,
  });
  if (req.method === 'HEAD') {
    res.end();
  } else {
    res.end(body);
  }
  return true;
}

function sendNotFound(req, res) {
  const notFound = findFile(path.join(config.publicRoot, '404.html'));
  if (notFound && sendFile(res, req, notFound, '/404.html', 404)) return;
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
  res.end('404');
}

/**
 * Devuelve true si la petición quedó atendida por archivos estáticos.
 * La URL canónica no lleva barra final (lo confirma sitemap.xml), igual que
 * cleanUrls de Vercel: /contacto sirve contacto/index.html y /contacto/ redirige.
 */
function serveStatic(req, res, urlPath) {
  const pathname = urlPath.split('?')[0];

  if (pathname.length > 1 && pathname.endsWith('/')) {
    const query = urlPath.includes('?') ? urlPath.slice(urlPath.indexOf('?')) : '';
    res.writeHead(308, { Location: pathname.slice(0, -1) + query, 'Cache-Control': 'no-cache' });
    res.end();
    return true;
  }

  const target = findFile(resolvePublicPath(pathname));
  if (target) return sendFile(res, req, target, pathname);

  sendNotFound(req, res);
  return true;
}

module.exports = { serveStatic, sendFile, sendNotFound, resolvePublicPath, findFile };
