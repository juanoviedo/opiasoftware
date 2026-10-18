'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('./lib/config');
const H = require('./lib/http');
const { JsonlStore, JsonMap } = require('./lib/store');
const { GeoIp } = require('./lib/geoip');
const { isBot, isSocialPreview } = require('./lib/bots');
const { parseUserAgent } = require('./lib/ua');
const { buildStats, classifyTraffic } = require('./lib/analytics');
const auth = require('./lib/auth');
const crm = require('./lib/crm');
const aiagent = require('./lib/aiagent');
const teams = require('./lib/teams');
const { serveStatic, sendFile } = require('./lib/static');

const visits = new JsonlStore(path.join(config.dataDir, 'visits.jsonl'));
const leadsStore = new JsonlStore(path.join(config.dataDir, 'leads.jsonl'));
const geoCache = new JsonMap(path.join(config.dataDir, 'geoip-cache.json'));
const geo = new GeoIp(geoCache);

const ADMIN_DIR = path.join(config.serverDir, 'opadmin');
const PUBLIC_ASSETS_DIR = path.join(config.serverDir, 'public');
// Lista cerrada: /__opia/ nunca sirve un archivo arbitrario del disco.
const PUBLIC_ASSETS = {
  '/__opia/beacon.js': { file: 'beacon.js', type: 'text/javascript; charset=utf-8' },
  '/__opia/conversions.js': { file: 'conversions.js', type: 'text/javascript; charset=utf-8' },
};

/* ---------------------------------------------------------------- límites */

function makeLimiter(max, windowMs) {
  const hits = new Map();
  const allow = (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  };
  allow.sweep = () => {
    const now = Date.now();
    for (const [key, entry] of hits) if (now - entry.start > windowMs) hits.delete(key);
  };
  return allow;
}

const trackLimiter = makeLimiter(60, 60_000);
const leadLimiter = makeLimiter(6, 60 * 60_000);
const statsLimiter = makeLimiter(120, 60_000);
const crmLoginLimiter = makeLimiter(5, 15 * 60_000);
const crmApiLimiter = makeLimiter(600, 60 * 60_000);
const aiMessageLimiter = makeLimiter(15, 60_000);
const aiHistoryLimiter = makeLimiter(120, 60_000);
const aiEmailLimiter = makeLimiter(5, 15 * 60_000);

setInterval(() => {
  trackLimiter.sweep();
  leadLimiter.sweep();
  statsLimiter.sweep();
  crmLoginLimiter.sweep();
  crmApiLimiter.sweep();
  aiMessageLimiter.sweep();
  aiHistoryLimiter.sweep();
  aiEmailLimiter.sweep();
}, 5 * 60_000).unref();

/* ------------------------------------------------------------------ útiles */

function isSecureRequest(req) {
  if (config.publicUrl.startsWith('https://')) return true;
  if (config.trustProxy) {
    const proto = req.headers['x-forwarded-proto'];
    if (proto && String(proto).split(',')[0].trim() === 'https') return true;
  }
  return false;
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(`${ip}|${config.sessionSecret}`).digest('hex').slice(0, 32);
}

function safePath(value) {
  const raw = H.clean(value, 400);
  if (!raw.startsWith('/')) return { pathname: '/', search: '' };
  try {
    const url = new URL(raw, 'http://localhost');
    return { pathname: H.truncate(url.pathname, 300), search: H.truncate(url.search, 300) };
  } catch {
    return { pathname: '/', search: '' };
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function readFormOrJson(req) {
  return H.readBody(req, 16_384).then((raw) => {
    const type = String(req.headers['content-type'] || '');
    if (!raw) return {};
    if (type.includes('application/json')) return JSON.parse(raw);
    if (type.includes('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(raw));
    }
    return {};
  });
}

/**
 * La URL manda; si no trae UTM se usa el primer toque de la sesión.
 * Sin esto, un lead que llegó por un anuncio y luego navegó a /contacto
 * quedaría atribuido a "Directo".
 */
function mergedParams(search, firstTouch) {
  const params = new URLSearchParams(search || '');
  if (firstTouch && typeof firstTouch === 'object') {
    for (const [key, value] of Object.entries(firstTouch)) {
      if (value && !params.has(key)) params.set(key, String(value));
    }
  }
  return params;
}

function utmFrom(params) {
  return {
    src_utm: H.clean(params.get('utm_source'), 120),
    med: H.clean(params.get('utm_medium'), 120),
    cmp: H.clean(params.get('utm_campaign'), 160),
    cnt: H.clean(params.get('utm_content'), 160),
    trm: H.clean(params.get('utm_term'), 120),
    fbclid: params.has('fbclid'),
    gclid: params.has('gclid') || params.has('gbraid') || params.has('wbraid'),
  };
}

/* ------------------------------------------------------------- /api/track */

async function handleTrack(req, res) {
  if (!config.trackEnabled) return H.sendJson(res, 200, { ok: false, disabled: true });

  const ip = H.clientIp(req, config.trustProxy);
  if (!trackLimiter(ip)) return H.sendJson(res, 429, { ok: false, error: 'rate_limited' });

  let body;
  try {
    body = await H.readJsonBody(req, 4096);
  } catch (err) {
    return H.sendJson(res, err.status === 413 ? 413 : 400, { ok: false, error: 'bad_payload' });
  }

  const { pathname, search } = safePath(body.p);
  // No rastrear el propio panel ni los endpoints: inflaría las métricas.
  // /crm y /aiagent tampoco: son aplicaciones privadas (y el agente cambia de URL por guid).
  if (
    pathname.startsWith('/opadmin') ||
    pathname.startsWith('/crm') ||
    pathname.startsWith('/aiagent') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/__opia/')
  ) {
    return H.sendJson(res, 202, { ok: true, skipped: true });
  }

  const userAgent = H.clean(req.headers['user-agent'], 400);
  const ref = H.clean(body.r, 300);
  const params = mergedParams(search, body.ft);
  const { source, adNetwork, refHost } = classifyTraffic(ref, params);
  const utm = utmFrom(params);
  const ua = parseUserAgent(userAgent);
  const internal = H.isPrivateIp(ip);

  const record = {
    t: new Date().toISOString(),
    ev: ['pageview', 'whatsapp', 'lead', 'form_start'].includes(H.clean(body.ev, 20)) ? H.clean(body.ev, 20) : 'pageview',
    vid: H.clean(body.vid, 64),
    sid: H.clean(body.sid, 64),
    ip,
    iph: hashIp(ip),
    path: pathname,
    q: search,
    ref,
    refHost,
    source,
    ad: adNetwork || '',
    ...utm,
    ti: H.clean(body.ti, 200),
    ua: userAgent,
    device: ua.device,
    os: ua.os,
    browser: ua.browser,
    sw: clampInt(body.sw, 0, 20_000, 0),
    sh: clampInt(body.sh, 0, 20_000, 0),
    lang: H.clean(body.lang, 20),
    tz: typeof body.tz === 'number' ? body.tz : null,
    bot: isBot(userAgent),
    preview: isSocialPreview(userAgent),
    internal: internal && !config.trackInternal ? false : internal,
    href: body.href ? H.clean(body.href, 300) : '',
  };

  visits.append(record);
  if (!record.bot) geo.enqueue(ip);

  H.sendJson(res, 202, { ok: true });
}

/* -------------------------------------------------------------- /api/leads */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function handleLead(req, res) {
  const ip = H.clientIp(req, config.trustProxy);
  if (!leadLimiter(ip)) return H.sendJson(res, 429, { ok: false, error: 'Demasiados envíos. Intenta más tarde.' });

  let body;
  try {
    body = await readFormOrJson(req);
  } catch {
    return H.sendJson(res, 400, { ok: false, error: 'Solicitud inválida.' });
  }

  // Trampa de spam: los bots rellenan campos ocultos, las personas no los ven.
  if (H.clean(body.website, 200) || H.clean(body.url_field, 200)) {
    return H.sendJson(res, 200, { ok: true });
  }

  const name = H.clean(body.name, 120).trim();
  const email = H.clean(body.email, 160).trim();
  const phone = H.clean(body.phone, 40).replace(/[^\d+()\-\s]/g, '').trim();
  const consent = body.consent === true || body.consent === 'true' || body.consent === 'on';

  const errors = {};
  if (name.length < 2) errors.name = 'Escribe tu nombre.';
  if (email && !EMAIL_RE.test(email)) errors.email = 'Ese correo no parece válido.';
  if (!email && !phone) errors.phone = 'Necesitamos un correo o un teléfono para responderte.';
  if (!consent) errors.consent = 'Debes autorizar el tratamiento de tus datos.';
  if (Object.keys(errors).length) return H.sendJson(res, 422, { ok: false, errors });

  const { pathname, search } = safePath(body.page || req.headers.referer || '');
  const referer = H.clean(req.headers.referer, 300);
  const params = mergedParams(search, body.ft);
  const { source, adNetwork, refHost } = classifyTraffic(referer, params);
  const userAgent = H.clean(req.headers['user-agent'], 400);
  const uaInfo = parseUserAgent(userAgent);

  const lead = {
    t: new Date().toISOString(),
    name,
    email,
    phone,
    company: H.clean(body.company, 160).trim(),
    role: H.clean(body.role, 120).trim(),
    service: H.clean(body.service, 120).trim(),
    message: H.clean(body.message, 2000).trim(),
    urgency: H.clean(body.urgency, 120).trim(),
    page: pathname,
    ref: referer,
    refHost,
    source,
    ad: adNetwork || '',
    ...utmFrom(params),
    ip,
    iph: hashIp(ip),
    ua: userAgent,
    device: uaInfo.device,
    os: uaInfo.os,
    browser: uaInfo.browser,
    bot: isBot(userAgent),
    internal: H.isPrivateIp(ip),
    status: 'nuevo',
  };

  leadsStore.append(lead);
  visits.append({ ...lead, ev: 'lead', vid: H.clean(body.vid, 64), sid: H.clean(body.sid, 64), path: pathname, ti: '' });
  geo.enqueue(ip);

  H.sendJson(res, 201, { ok: true });
}

/* --------------------------------------------------------------- /opadmin */

function sendAdminPage(res, req, file) {
  const target = path.join(ADMIN_DIR, file);
  if (!fs.existsSync(target)) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Panel no instalado.');
  }
  const body = fs.readFileSync(target);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    ...H.SECURITY_HEADERS,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function requireAuth(req, res) {
  const user = auth.currentUser(req);
  if (!user) {
    H.sendJson(res, 401, { ok: false, error: 'unauthorized' }, { 'X-Robots-Tag': 'noindex, nofollow' });
    return null;
  }
  return user;
}

async function handleLogin(req, res) {
  const ip = H.clientIp(req, config.trustProxy);
  if (!auth.loginAllowed(ip)) {
    return H.sendJson(res, 429, { ok: false, error: 'Demasiados intentos. Espera 15 minutos.' });
  }

  const admin = auth.loadAdmin();
  if (!admin) {
    return H.sendJson(res, 503, {
      ok: false,
      error: 'El panel está abierto sin contraseña. Para protegerlo ejecuta: node server/scripts/set-password.js',
    });
  }

  let body;
  try {
    body = await readFormOrJson(req);
  } catch {
    return H.sendJson(res, 400, { ok: false, error: 'Solicitud inválida.' });
  }

  const user = H.clean(body.user, 80);
  const password = String(body.password || '');
  if (user !== admin.user || !auth.verifyPassword(password, admin.hash)) {
    return H.sendJson(res, 401, { ok: false, error: 'Usuario o contraseña incorrectos.' });
  }

  auth.loginSucceeded(ip);
  auth.createSession(user, res, isSecureRequest(req));
  H.sendJson(res, 200, { ok: true, user });
}

function handleStats(req, res, url) {
  if (!statsLimiter(H.clientIp(req, config.trustProxy))) {
    return H.sendJson(res, 429, { ok: false, error: 'rate_limited' });
  }
  const days = clampInt(url.searchParams.get('days'), 1, 365, 30);
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();

  const records = visits.readSince(sinceIso);
  const leadRows = leadsStore.readSince(sinceIso);

  // La geolocalización se resuelve en segundo plano: el panel responde ya y
  // las ubicaciones pendientes aparecen en el siguiente refresco.
  geo.hydrate(records);
  geo.hydrate(leadRows);

  const stats = buildStats({ records, leads: leadRows, geoCache, days });
  stats.admin = {
    user: auth.loadAdmin()?.user || config.adminUser,
    retentionDays: config.retentionDays,
    storedVisits: visits.count(),
    storedLeads: leadsStore.count(),
    cachedIps: geoCache.size,
    trustProxy: config.trustProxy,
    publicUrl: config.publicUrl,
  };
  H.sendJson(res, 200, stats);
}

/* ---------------------------------------------------------------- /crm */

function segmentos(pathname) {
  return pathname.split('/').filter(Boolean);
}

async function handleCrmSolicitar(req, res) {
  const ip = H.clientIp(req, config.trustProxy);
  if (!crmLoginLimiter(ip)) {
    return H.sendJson(res, 429, { ok: false, error: 'Demasiados intentos. Espera 15 minutos.' });
  }
  let body;
  try {
    body = await readFormOrJson(req);
  } catch {
    return H.sendJson(res, 400, { ok: false, error: 'Solicitud inválida.' });
  }
  const resultado = await crm.solicitarAcceso(body.email);
  if (!resultado.ok) return H.sendJson(res, resultado.status || 500, { ok: false, error: resultado.error });
  H.sendJson(res, 200, { ok: true });
}

function handleCrmVerificar(req, res, url) {
  const token = String(url.searchParams.get('token') || '');
  const resultado = crm.verificarAcceso(token);
  if (!resultado.ok) {
    res.writeHead(303, { Location: '/crm?error=' + encodeURIComponent(resultado.error) });
    return res.end();
  }
  crm.crearCookieSesion(res, resultado.sesion, resultado.exp, isSecureRequest(req));
  res.writeHead(303, { Location: '/crm' });
  res.end();
}

function handleCrmSalir(req, res) {
  crm.borrarCookieSesion(res);
  H.sendJson(res, 200, { ok: true });
}

function listadoClientes(url) {
  const q = crm.normaliza(H.clean(url.searchParams.get('q'), 120));
  const orden = H.clean(url.searchParams.get('orden') || '', 20);
  const dir = H.clean(url.searchParams.get('dir') || '', 4) === 'desc' ? -1 : 1;
  const seguimiento = H.clean(url.searchParams.get('seguimiento') || '', 20);
  const todas = crm.clientes.todas();
  let filtradas = q
    ? todas.filter((c) =>
        [c.nombre, c.sector, c.zona].some((v) => crm.normaliza(v).includes(q))
      )
    : todas;
  if (seguimiento && crm.ESTADOS_SEGUIMIENTO.includes(seguimiento)) {
    filtradas = filtradas.filter((c) => (c.estadoSeguimiento || 'sin_contactar') === seguimiento);
  }
  const conteos = new Map();
  const porId = new Map();
  const primeroConCelular = new Map();
  // 7–15 dígitos: el techo internacional descarta fechas u otros basureros
  // heredados en la columna de celular (ej. "2023-11-29 05:00:00.0000000").
  const conCelular = (k) => {
    if (!k) return false;
    const d = String(k.celular || '').replace(/\D/g, '');
    return d.length >= 7 && d.length <= 15;
  };
  for (const k of crm.contactos.todas()) {
    conteos.set(k.clienteId, (conteos.get(k.clienteId) || 0) + 1);
    porId.set(k.id, k);
    if (!primeroConCelular.has(k.clienteId) && conCelular(k)) primeroConCelular.set(k.clienteId, k);
  }
  // Para el botón de WhatsApp: el contacto principal explícito; si no tiene
  // celular o no hay, el primero con celular. El servidor decide y lo cuenta
  // como la gestión hecha a ese contacto.
  const principalDe = (c) => conCelular(porId.get(c.contactoPrincipalId))
    ? porId.get(c.contactoPrincipalId)
    : primeroConCelular.get(c.id) || null;
  const valor = {
    nombre: (c) => String(c.nombre || ''),
    sector: (c) => String(c.sector || ''),
    zona: (c) => String(c.zona || ''),
    empleados: (c) => (c.numEmpleadosAprox == null ? null : Number(c.numEmpleadosAprox)),
    seguimiento: (c) => c.estadoSeguimiento || 'sin_contactar',
    contactos: (c) => conteos.get(c.id) || 0,
  }[orden];
  filtradas.sort((a, b) => {
    if (!valor) return String(a.nombre).localeCompare(String(b.nombre), 'es');
    const va = valor(a);
    const vb = valor(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1; // empleados sin dato van siempre al final
    if (vb === null) return -1;
    const cmp = typeof va === 'number' && typeof vb === 'number'
      ? va - vb
      : String(va).localeCompare(String(vb), 'es');
    return cmp * dir;
  });
  return {
    total: filtradas.length,
    clientes: filtradas.slice(0, 500).map((c) => {
      const principal = principalDe(c);
      return {
        ...c,
        contactos: conteos.get(c.id) || 0,
        contactoPrincipal: principal
          ? {
              id: principal.id,
              nombre: [principal.nombres, principal.apellidos].filter(Boolean).join(' ') || '—',
              celular: principal.celular || '',
            }
          : null,
      };
    }),
  };
}

function listadoContactos(url) {
  const q = crm.normaliza(H.clean(url.searchParams.get('q'), 120));
  const clienteId = H.clean(url.searchParams.get('clienteId'), 20);
  const nombreCliente = new Map(crm.clientes.todas().map((c) => [c.id, c.nombre]));
  const minRaw = url.searchParams.get('empleadosMin');
  const maxRaw = url.searchParams.get('empleadosMax');
  const soloSinDato = url.searchParams.get('empleadosVacios') === '1';
  const empleadosMin = minRaw ? Number(minRaw) : NaN;
  const empleadosMax = maxRaw ? Number(maxRaw) : NaN;
  const empleadosPorCliente = new Map(
    crm.clientes.todas().map((c) => [c.id, c.numEmpleadosAprox == null ? null : Number(c.numEmpleadosAprox)])
  );
  let filas = crm.contactos.todas();
  if (clienteId) filas = filas.filter((k) => k.clienteId === clienteId);
  if (soloSinDato) {
    filas = filas.filter((k) => empleadosPorCliente.get(k.clienteId) == null);
  } else if (Number.isFinite(empleadosMin) || Number.isFinite(empleadosMax)) {
    filas = filas.filter((k) => {
      const n = empleadosPorCliente.get(k.clienteId);
      if (n == null) return false; // sin dato de empleados no entra al filtro
      if (Number.isFinite(empleadosMin) && n < empleadosMin) return false;
      if (Number.isFinite(empleadosMax) && n > empleadosMax) return false;
      return true;
    });
  }
  if (q) {
    // el nombre completo se reparte entre nombres y apellidos: se buscan TODAS
    // las palabras del texto en los campos unidos (da igual el orden)
    const palabras = q.split(/\s+/).filter(Boolean);
    filas = filas.filter((k) => {
      const texto = crm.normaliza(
        [k.nombres, k.apellidos, k.email, k.cargo, nombreCliente.get(k.clienteId)].join(' ')
      );
      return palabras.every((palabra) => texto.includes(palabra));
    });
  }
  const orden = H.clean(url.searchParams.get('orden') || '', 20);
  const dir = H.clean(url.searchParams.get('dir') || '', 4) === 'desc' ? -1 : 1;
  if (orden === 'empleados') {
    // los empleados son de la empresa; sin dato van siempre al final
    filas.sort((a, b) => {
      const va = empleadosPorCliente.get(a.clienteId);
      const vb = empleadosPorCliente.get(b.clienteId);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * dir;
    });
  }
  filas = filas.slice(0, 500).map((k) => ({
    ...k,
    empresa: nombreCliente.get(k.clienteId) || '',
    // dato duplicado de la empresa para verlo y filtrarlo sin abrir la ficha
    numEmpleadosAprox: empleadosPorCliente.get(k.clienteId) ?? null,
  }));
  return { total: filas.length, contactos: filas };
}

async function handleCrmApi(req, res, pathname, url) {
  const email = crm.sesionActual(req);
  if (!email) return H.sendJson(res, 401, { ok: false, error: 'unauthorized' });
  if (!crmApiLimiter(email)) return H.sendJson(res, 429, { ok: false, error: 'rate_limited' });

  const partes = segmentos(pathname); // ['api','crm',...resto]
  const coleccion = partes[2];
  const id = partes[3];
  const metodo = req.method;

  if (pathname === '/api/crm/sesion' && metodo === 'GET') {
    return H.sendJson(res, 200, { ok: true, email, emailConfigurado: crm.emailConfigurado() });
  }
  if (pathname === '/api/crm/resumen' && metodo === 'GET') {
    const porEstado = {};
    for (const k of crm.contactos.todas()) {
      const e = k.estado || 'sin estado';
      porEstado[e] = (porEstado[e] || 0) + 1;
    }
    return H.sendJson(res, 200, {
      ok: true,
      clientes: crm.clientes.todas().length,
      contactos: crm.contactos.todas().length,
      porEstado,
    });
  }

  let body = {};
  if (metodo === 'POST' || metodo === 'PUT') {
    try {
      body = await readFormOrJson(req);
    } catch {
      return H.sendJson(res, 400, { ok: false, error: 'Solicitud inválida.' });
    }
  }

  if (partes[2] === 'admin' && partes[3] === 'correos') {
    if (metodo === 'GET') return H.sendJson(res, 200, { ok: true, correos: crm.listarCorreos() });
    if (metodo === 'POST') {
      const r = crm.agregarCorreo(body.email);
      if (r.error) return H.sendJson(res, 422, { ok: false, error: r.error });
      return H.sendJson(res, 201, { ok: true, correos: r.correos });
    }
    if (metodo === 'DELETE') {
      const r = crm.quitarCorreo(url.searchParams.get('email'));
      if (r.error) return H.sendJson(res, 422, { ok: false, error: r.error });
      return H.sendJson(res, 200, { ok: true, correos: r.correos });
    }
    return H.sendJson(res, 405, { ok: false, error: 'Método no permitido.' });
  }

  if (coleccion === 'clientes') {
    if (!id && metodo === 'GET') return H.sendJson(res, 200, { ok: true, ...listadoClientes(url) });
    if (!id && metodo === 'POST') {
      const { datos, errores } = crm.validarCliente(body);
      if (Object.keys(errores).length) return H.sendJson(res, 422, { ok: false, errors: errores });
      const creado = crm.clientes.agregar({ id: crm.siguienteId('c'), ...datos }, email);
      return H.sendJson(res, 201, { ok: true, cliente: creado });
    }
    const cliente = crm.clientes.porId(id);
    if (!cliente) return H.sendJson(res, 404, { ok: false, error: 'Cliente no encontrado.' });
    if (metodo === 'GET') {
      const suyos = crm.contactos.todas().filter((k) => k.clienteId === id);
      return H.sendJson(res, 200, { ok: true, cliente, contactos: suyos });
    }
    if (partes[4] === 'whatsapp' && metodo === 'POST') {
      const r = crm.registrarContactoWhatsapp(id, H.clean(body.contactoId, 20), email);
      if (!r.ok) return H.sendJson(res, r.status || 500, { ok: false, error: r.error });
      return H.sendJson(res, 200, { ok: true, nota: r.nota, contacto: r.contacto });
    }
    if (metodo === 'PUT') {
      const { datos, errores } = crm.validarCliente(body, id);
      if (Object.keys(errores).length) return H.sendJson(res, 422, { ok: false, errors: errores });
      return H.sendJson(res, 200, { ok: true, cliente: crm.clientes.actualizar(id, datos, email) });
    }
    if (metodo === 'DELETE') {
      crm.clientes.eliminar(id);
      const restantes = crm.contactos.todas().filter((k) => k.clienteId !== id);
      const borrados = crm.contactos.todas().length - restantes.length;
      crm.contactos.guardar(restantes);
      const notasRestantes = crm.notas.todas().filter((n) => n.clienteId !== id);
      const notasBorradas = crm.notas.todas().length - notasRestantes.length;
      crm.notas.guardar(notasRestantes);
      const levRestantes = crm.levantamientos.todas().filter((l) => l.clienteId !== id);
      crm.levantamientos.guardar(levRestantes);
      return H.sendJson(res, 200, { ok: true, contactosBorrados: borrados, notasBorradas });
    }
  }

  if (coleccion === 'contactos') {
    if (!id && metodo === 'GET') return H.sendJson(res, 200, { ok: true, ...listadoContactos(url) });
    if (!id && metodo === 'POST') {
      const { datos, errores } = crm.validarContacto(body);
      if (Object.keys(errores).length) return H.sendJson(res, 422, { ok: false, errors: errores });
      const creado = crm.contactos.agregar({ id: crm.siguienteId('p'), ...datos }, email);
      crm.propagarEmpleados(creado.clienteId, body.numEmpleadosAprox, email);
      return H.sendJson(res, 201, { ok: true, contacto: creado });
    }
    const contacto = crm.contactos.porId(id);
    if (!contacto) return H.sendJson(res, 404, { ok: false, error: 'Contacto no encontrado.' });
    if (metodo === 'PUT') {
      const { datos, errores } = crm.validarContacto({ ...contacto, ...body });
      if (Object.keys(errores).length) return H.sendJson(res, 422, { ok: false, errors: errores });
      const guardado = crm.contactos.actualizar(id, datos, email);
      crm.propagarEmpleados(guardado.clienteId, body.numEmpleadosAprox, email);
      return H.sendJson(res, 200, { ok: true, contacto: guardado });
    }
    if (metodo === 'DELETE') {
      crm.contactos.eliminar(id);
      // que no quede apuntando a un contacto que ya no existe
      const dueno = crm.clientes.todas().find((c) => c.contactoPrincipalId === id);
      if (dueno) crm.clientes.actualizar(dueno.id, { contactoPrincipalId: '' }, email);
      // el borrado es en cascada: sus notas y todo el chat del agente de IA
      // (conversación, mensajes y levantamiento) se van con el contacto
      const notasRestantes = crm.notas.todas().filter((n) => n.contactoId !== id);
      const notasBorradas = crm.notas.todas().length - notasRestantes.length;
      crm.notas.guardar(notasRestantes);
      const agente = aiagent.eliminarPorContacto(id);
      return H.sendJson(res, 200, { ok: true, notasBorradas, ...agente });
    }
  }

  if (coleccion === 'notas') {
    if (!id && metodo === 'GET') {
      const clienteId = url.searchParams.get('clienteId') || '';
      if (!crm.clientes.porId(clienteId)) return H.sendJson(res, 404, { ok: false, error: 'Cliente no encontrado.' });
      // más nueva primero: la galería se lee de arriba hacia abajo
      const suyas = crm.notas.todas().filter((n) => n.clienteId === clienteId).sort((a, b) => String(b.createdon || b.creadoEl || '').localeCompare(String(a.createdon || a.creadoEl || '')));
      return H.sendJson(res, 200, { ok: true, notas: suyas.slice(0, 500) });
    }
    if (!id && metodo === 'POST') {
      const { datos, errores } = crm.validarNota(body);
      if (Object.keys(errores).length) return H.sendJson(res, 422, { ok: false, errors: errores });
      const creada = crm.notas.agregar({ id: crm.siguienteId('n'), ...datos }, email);
      return H.sendJson(res, 201, { ok: true, nota: creada });
    }
    const nota = crm.notas.porId(id);
    if (!nota) return H.sendJson(res, 404, { ok: false, error: 'Nota no encontrada.' });
    if (metodo === 'PUT') {
      const { datos, errores } = crm.validarNota({ ...nota, ...body });
      if (Object.keys(errores).length) return H.sendJson(res, 422, { ok: false, errors: errores });
      return H.sendJson(res, 200, { ok: true, nota: crm.notas.actualizar(id, datos, email) });
    }
    if (metodo === 'DELETE') {
      crm.notas.eliminar(id);
      return H.sendJson(res, 200, { ok: true });
    }
  }

  if (coleccion === 'levantamientos') {
    // solo lectura: los levantamientos los escribe el agente de IA desde el chat
    if (!id && metodo === 'GET') {
      const clienteId = url.searchParams.get('clienteId') || '';
      if (!crm.clientes.porId(clienteId)) return H.sendJson(res, 404, { ok: false, error: 'Cliente no encontrado.' });
      return H.sendJson(res, 200, { ok: true, levantamientos: crm.listarLevantamientos(clienteId).slice(0, 20) });
    }
    return H.sendJson(res, 405, { ok: false, error: 'Método no permitido.' });
  }

  return H.sendJson(res, 404, { ok: false, error: 'not_found' });
}

/* ------------------------------------------------------------- /aiagent */

const RE_GUID = /^[A-Za-z0-9_-]{8,64}$/;

async function handleAiMensaje(req, res) {
  const ip = H.clientIp(req, config.trustProxy);
  if (!aiMessageLimiter(ip)) return H.sendJson(res, 429, { ok: false, error: 'rate_limited' });

  let body;
  try {
    body = await readFormOrJson(req);
  } catch {
    return H.sendJson(res, 400, { ok: false, error: 'Solicitud inválida.' });
  }
  const texto = H.clean(body.texto, 2000).trim();
  if (texto.length < 1) return H.sendJson(res, 422, { ok: false, error: 'Escribe un mensaje.' });
  let guid = H.clean(body.guid, 64);
  if (!RE_GUID.test(guid)) guid = '';

  try {
    const r = await aiagent.mensaje(guid, texto);
    if (r.error) return H.sendJson(res, r.status || 500, { ok: false, error: r.error });
    return H.sendJson(res, 200, { ok: true, guid: r.guid, respuesta: r.texto });
  } catch (err) {
    console.error('[aiagent]', err.message);
    return H.sendJson(res, 502, { ok: false, error: 'El asistente falló. Intenta de nuevo en un momento.' });
  }
}

/** Envía el magic link al correo que la persona escribe en el chat. */
async function handleAiEmail(req, res) {
  const ip = H.clientIp(req, config.trustProxy);
  if (!aiEmailLimiter(ip)) {
    return H.sendJson(res, 429, { ok: false, error: 'Demasiados intentos. Espera unos minutos.' });
  }
  let body = {};
  try {
    body = await readFormOrJson(req);
  } catch {
    body = {};
  }
  try {
    const r = await aiagent.solicitarEnlace(H.clean(body.correo, 160));
    return H.sendJson(res, r.status || 200, r);
  } catch (err) {
    console.error('[aiagent]', err.message);
    return H.sendJson(res, 502, { ok: false, error: 'No pudimos enviar el correo. Intenta de nuevo en un momento.' });
  }
}

function handleAiSesion(req, res, url) {
  if (!aiHistoryLimiter(H.clientIp(req, config.trustProxy))) {
    return H.sendJson(res, 429, { ok: false, error: 'rate_limited' });
  }
  // el guid puede venir por query (enlace directo) o por la cookie de sesión
  let guid = H.clean(url.searchParams.get('guid'), 64);
  if (!RE_GUID.test(guid)) guid = H.parseCookies(req.headers.cookie)[aiagent.COOKIE_AI] || '';
  const s = RE_GUID.test(guid) ? aiagent.obtenerSesion(guid) : null;
  if (!s) return H.sendJson(res, 404, { ok: false, error: 'not_found' });
  return H.sendJson(res, 200, { ok: true, guid: s.id, estado: s.estado, historial: aiagent.historialVisible(s) });
}

/* ------------------------------------------------------ teams del dueño */

function handleTeamsConectar(req, res) {
  if (teams.conectado()) {
    return H.sendJson(res, 200, { ok: true, conectado: true, mensaje: 'El calendario ya está conectado.' });
  }
  if (!teams.configurado()) {
    return H.sendJson(res, 409, {
      ok: false,
      error: 'Falta registrar la aplicación (clientId y clientSecret en teams-config.json).',
    });
  }
  res.writeHead(303, { Location: teams.urlConsentimiento() });
  return res.end();
}

/** Microsoft devuelve el código aquí; se cambia por tokens y se valida la cuenta. */
async function handleTeamsCallback(req, res, url) {
  const estado = url.searchParams.get('state') || '';
  const payload = auth.unsign(estado);
  if (!payload || payload.t !== 'teams' || payload.exp < Date.now()) {
    return H.sendJson(res, 400, { ok: false, error: 'state inválido o vencido. Empieza de nuevo.' });
  }
  const code = url.searchParams.get('code') || '';
  if (!code) {
    const desc = url.searchParams.get('error_description') || url.searchParams.get('error') || 'sin código';
    return H.sendJson(res, 400, { ok: false, error: 'Microsoft devolvió un error: ' + desc });
  }
  try {
    // el correo viene del id_token: /me falla 403 (el token no trae User.Read)
    const r = await teams.cambiarPorCodigo(code);
    const esperado = (teams.organizador() || '').toLowerCase();
    if (esperado && r.correo && r.correo !== esperado) {
      teams.limpiarTokens();
      return H.sendJson(res, 403, {
        ok: false,
        error: `Consentiste con ${r.correo} y se esperaba ${esperado}. Vuelve a intentar con la cuenta correcta.`,
      });
    }
    res.writeHead(303, { Location: '/crm/?teams=conectado' });
    return res.end();
  } catch (err) {
    console.error('[teams]', err.message);
    return H.sendJson(res, 500, { ok: false, error: 'No pude completar la conexión con Microsoft.' });
  }
}

/**
 * Página pública del asistente virtual.
 * /aiagent?token=…    → consume el magic link: crea/reusa la sesión del contacto,
 *                        planta la cookie (30 días, Strict) y redirige al chat.
 * /aiagent            → con cookie de sesión válida redirige al chat; si no,
 *                        sirve la página para pedir el correo.
 * /aiagent/<guid>     → sirve la página y refresca la cookie de continuidad.
 */
async function handleAiAgentPage(req, res, pathname, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return H.sendJson(res, 405, { ok: false, error: 'Método no permitido.' });
  }
  const archivo = path.join(config.publicRoot, 'aiagent', 'index.html');

  if (pathname === '/aiagent') {
    const token = url.searchParams.get('token');
    if (token) {
      try {
        const r = await aiagent.verificarEnlace(token);
        if (r.error) {
          res.writeHead(303, { Location: '/aiagent?enlace=invalido' });
          return res.end();
        }
        res.setHeader(
          'Set-Cookie',
          H.serializeCookie(aiagent.COOKIE_AI, r.guid, {
            maxAgeSeconds: 30 * 86_400,
            path: '/',
            httpOnly: true,
            sameSite: 'Strict',
            secure: isSecureRequest(req),
          })
        );
        res.writeHead(303, { Location: '/aiagent/' + encodeURIComponent(r.guid) });
        return res.end();
      } catch (err) {
        console.error('[aiagent]', err.message);
        res.writeHead(303, { Location: '/aiagent?enlace=invalido' });
        return res.end();
      }
    }
    const cookies = H.parseCookies(req.headers.cookie);
    const guid = cookies[aiagent.COOKIE_AI] || '';
    if (RE_GUID.test(guid) && aiagent.obtenerSesion(guid)) {
      res.writeHead(303, { Location: '/aiagent/' + encodeURIComponent(guid) });
      return res.end();
    }
    if (sendFile(res, req, archivo, pathname)) return;
    return serveStatic(req, res, req.url);
  }

  const m = /^\/aiagent\/([A-Za-z0-9_-]{8,64})$/.exec(pathname);
  if (m) {
    res.setHeader(
      'Set-Cookie',
      H.serializeCookie(aiagent.COOKIE_AI, m[1], {
        maxAgeSeconds: 30 * 86_400,
        path: '/',
        httpOnly: true,
        sameSite: 'Strict',
        secure: isSecureRequest(req),
      })
    );
    if (sendFile(res, req, archivo, pathname)) return;
  }
  return serveStatic(req, res, req.url);
}

/* ---------------------------------------------------------------- servidor */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  const done = (err) => {
    if (res.headersSent) return res.end();
    const status = err && err.status ? err.status : 500;
    if (status >= 500) console.error(`[opia] ${req.method} ${pathname}`, err && err.message);
    H.sendJson(res, status, { ok: false, error: status === 500 ? 'internal_error' : 'bad_request' });
  };

  Promise.resolve()
    .then(async () => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { Allow: 'GET,POST,HEAD,OPTIONS' });
        return res.end();
      }

      const asset = PUBLIC_ASSETS[pathname];
      if (asset) {
        const file = path.join(PUBLIC_ASSETS_DIR, asset.file);
        if (!fs.existsSync(file)) return H.sendText(res, 404, '');
        const body = fs.readFileSync(file);
        res.writeHead(200, {
          'Content-Type': asset.type,
          'Content-Length': body.length,
          'Cache-Control': 'no-cache',
          ...H.SECURITY_HEADERS,
        });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }

      if (pathname === '/api/health') {
        return H.sendJson(res, 200, { ok: true, ts: Date.now() });
      }

      if (req.method === 'POST' && pathname === '/api/track') return await handleTrack(req, res);
      if (req.method === 'POST' && pathname === '/api/leads') return await handleLead(req, res);
      if (req.method === 'POST' && pathname === '/opadmin/login') return await handleLogin(req, res);

      if (req.method === 'POST' && pathname === '/api/crm/auth/solicitar') return await handleCrmSolicitar(req, res);
      if (req.method === 'GET' && pathname === '/api/crm/auth/verificar') return handleCrmVerificar(req, res, url);
      if (req.method === 'POST' && pathname === '/api/crm/auth/salir') return handleCrmSalir(req, res);
      if (pathname.startsWith('/api/crm/')) return await handleCrmApi(req, res, pathname, url);

      if (req.method === 'POST' && pathname === '/api/aiagent/mensaje') return await handleAiMensaje(req, res);
      if (req.method === 'POST' && pathname === '/api/aiagent/email') return await handleAiEmail(req, res);
      if (req.method === 'GET' && pathname === '/api/aiagent/sesion') return handleAiSesion(req, res, url);

      if (req.method === 'GET' && pathname === '/api/teams/estado') {
        return H.sendJson(res, 200, {
          ok: true,
          configurado: teams.configurado(),
          conectado: teams.conectado(),
          organizador: teams.organizador(),
        });
      }
      if (req.method === 'GET' && pathname === '/api/teams/conectar') return handleTeamsConectar(req, res);
      if (req.method === 'GET' && pathname === '/api/teams/callback') return await handleTeamsCallback(req, res, url);

      // alias corto del enlace que va en el correo: /chat?token=… → /aiagent?token=…
      if (pathname === '/chat') {
        res.writeHead(308, { Location: '/aiagent' + (url.search || '') });
        return res.end();
      }

      if (pathname === '/aiagent' || pathname.startsWith('/aiagent/')) return await handleAiAgentPage(req, res, pathname, url);

      if (pathname === '/opadmin/logout') {
        auth.destroySession(res);
        res.writeHead(303, { Location: '/opadmin' });
        return res.end();
      }

      if (pathname === '/opadmin' || pathname === '/opadmin/') {
        const user = auth.currentUser(req);
        return sendAdminPage(res, req, user ? 'index.html' : 'login.html');
      }

      if (pathname.startsWith('/api/admin/')) {
        if (!requireAuth(req, res)) return;
        if (pathname === '/api/admin/stats' && req.method === 'GET') return handleStats(req, res, url);
        if (pathname === '/api/admin/leads' && req.method === 'GET') {
          const days = clampInt(url.searchParams.get('days'), 1, 365, 90);
          const rows = leadsStore.readSince(new Date(Date.now() - days * 86_400_000).toISOString());
          return H.sendJson(res, 200, { ok: true, leads: rows.reverse().slice(0, 500) });
        }
        return H.sendJson(res, 404, { ok: false, error: 'not_found' });
      }

      if (pathname.startsWith('/opadmin/') || pathname.startsWith('/api/')) {
        return H.sendJson(res, 404, { ok: false, error: 'not_found' });
      }

      return serveStatic(req, res, req.url);
    })
    .catch(done);
});

/* -------------------------------------------------------------- retención */

function purgeOld() {
  const cutoff = new Date(Date.now() - config.retentionDays * 86_400_000).toISOString();
  const removedVisits = visits.prune(cutoff);
  const removedLeads = leadsStore.prune(cutoff);
  const removedAi = aiagent.podarSesiones();
  if (removedVisits || removedLeads || removedAi) {
    console.log(`[opia] retención: -${removedVisits} visitas, -${removedLeads} leads, -${removedAi} chats de agente (>${config.retentionDays} días)`);
  }
}

/* ------------------------------------------------------------------ inicio */

function start() {
  const admin = auth.loadAdmin();

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  ✖ El puerto ${config.port} ya está en uso.`);
      console.error(`    Cierra el otro proceso o arranca con otro puerto:`);
      console.error(`    OPIA_PORT=3100 node server/index.js\n`);
    } else if (err.code === 'EACCES') {
      console.error(`\n  ✖ Sin permiso para usar el puerto ${config.port}. Prueba uno mayor a 1024.\n`);
    } else {
      console.error('\n  ✖ Error al iniciar el servidor:', err.message, '\n');
    }
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    const shown = [];
    shown.push('');
    shown.push('  OPIA Software — servidor local');
    shown.push(`  Sitio:    http://localhost:${config.port}`);
    shown.push(`  Panel:    http://localhost:${config.port}/opadmin`);
    shown.push(`  CRM:      http://localhost:${config.port}/crm`);
    shown.push(`  Datos:    ${config.dataDir}`);
    shown.push(`  Retención: ${config.retentionDays} días   Zona: ${config.timezone}`);
    shown.push(`  Proxy de confianza: ${config.trustProxy ? 'sí' : 'no'}`);
    shown.push('');
    if (!admin) {
      shown.push('  ⚠ Panel ABIERTO sin contraseña. Protégelo con:');
      shown.push('     node server/scripts/set-password.js');
      shown.push('');
    }
    if (!config.publicUrl) {
      shown.push('  Para recibir tráfico de Meta necesitas una URL pública HTTPS.');
      shown.push('  Ver server/README.md (Cloudflare Tunnel).');
      shown.push('');
    }
    console.log(shown.join('\n'));
  });

  purgeOld();
  setInterval(purgeOld, 6 * 60 * 60_000).unref();

  const shutdown = (signal) => {
    console.log(`\n[opia] ${signal}, cerrando…`);
    geoCache.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) start();

module.exports = { server, start };
