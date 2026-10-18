'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const auth = require('./auth');
const H = require('./http');
const { sendMail } = require('./mail');

const CRM_DIR = path.join(config.dataDir, 'crm');
const COOKIE_CRM = 'opia_crm';
const TOKEN_MINUTOS = 15;
const SESION_DIAS = 7;

const CLIENTE_FIELDS = [
  'nombre', 'sector', 'zona', 'notas', 'numEmpleadosAprox',
  'direccion', 'departamento', 'sitioWeb', 'telefono', 'email', 'archivoOrigen',
  'contactoPrincipalId', 'estadoSeguimiento', 'ultimaFechaContacto',
];
const NOTA_FIELDS = ['clienteId', 'contactoId', 'texto'];
const CONTACTO_FIELDS = [
  'clienteId', 'nombres', 'apellidos', 'cargo', 'email', 'email2', 'email3',
  'celular', 'telefono', 'telefono2', 'descripcion', 'sector', 'zona', 'origen',
  'estado', 'etapa', 'propietario', 'leadScoring', 'ultimoContacto', 'tags',
  'observaciones', 'notas', 'idExterno', 'archivoOrigen',
];
// Levantamiento estructurado que llena el agente de IA (metodología SPIN +
// cualificación): campos comunes + pista software + pista marketing.
const LEVANTAMIENTO_FIELDS = [
  'tipo', 'situacion', 'problema', 'impacto', 'objetivo',
  'usuarios', 'procesos', 'funcionalidades', 'integraciones', 'datos', 'plataforma',
  'publico', 'propuesta', 'canales', 'competencia', 'kpis', 'assets', 'inversionAds',
  'decisor', 'plazo', 'presupuesto',
];
const TIPOS_LEVANTAMIENTO = ['software', 'marketing', 'otro'];
// Etiquetas legibles: las usa el correo interno del agente y la ficha del CRM.
const ETIQUETAS_LEVANTAMIENTO = {
  tipo: 'Pista', situacion: 'Situación actual', problema: 'Problema', impacto: 'Impacto si no se resuelve',
  objetivo: 'Objetivo / beneficio esperado', usuarios: 'Usuarios', procesos: 'Proceso a apoyar',
  funcionalidades: 'Funcionalidades', integraciones: 'Integraciones', datos: 'Datos y migración',
  plataforma: 'Plataforma y requisitos', publico: 'Público objetivo', propuesta: 'Propuesta de valor',
  canales: 'Canales actuales', competencia: 'Competencia', kpis: 'Cómo mide resultados',
  assets: 'Material disponible', inversionAds: 'Inversión en pauta', decisor: 'Decisor / quién más opina',
  plazo: 'Plazo', presupuesto: 'Presupuesto de referencia del cliente',
};
const LIMITES = {
  nombre: 200, sector: 120, zona: 120, notas: 1000, texto: 2000, nombres: 120, apellidos: 120,
  numEmpleadosAprox: 8,
  direccion: 200, departamento: 60, sitioWeb: 200, telefono: 40, email: 160,
  cargo: 160, email: 160, email2: 160, email3: 160, celular: 40, telefono: 40,
  telefono2: 40, descripcion: 400, origen: 120, estado: 60, etapa: 120,
  propietario: 120, leadScoring: 20, ultimoContacto: 40, tags: 200,
  observaciones: 500, idExterno: 64, archivoOrigen: 120,
  contactoPrincipalId: 20, estadoSeguimiento: 20, ultimaFechaContacto: 40,
  tipo: 20, situacion: 600, problema: 600, impacto: 600, objetivo: 600,
  usuarios: 600, procesos: 600, funcionalidades: 600, integraciones: 600, datos: 600,
  plataforma: 600, publico: 600, propuesta: 600, canales: 600, competencia: 600,
  kpis: 600, assets: 600, inversionAds: 600, decisor: 600, plazo: 600, presupuesto: 600,
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* Embudo comercial de seguimiento por empresa. La clave se guarda en el JSON;
   la etiqueta la pone la interfaz. */
const ESTADOS_SEGUIMIENTO = ['sin_contactar', 'pendiente_respuesta', 'interesado', 'negociacion', 'no_interesado', 'listo_cotizar'];

/* ------------------------------------------------------------- configuración */

// Dentro de dataDir (volumen en producción): así el contenedor lo ve sin
// tocar la imagen, y vive junto a secret.key y los datos del CRM.
const RUTA_CONFIG = path.join(config.dataDir, 'crm-config.json');
const MAX_CORREOS_AUTORIZADOS = 20;

function leerCrmConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(RUTA_CONFIG, 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch {
    // sin archivo: el CRM avisa qué falta, no falla
  }
  return {};
}

function guardarCrmConfig(raw) {
  const tmp = RUTA_CONFIG + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, RUTA_CONFIG);
}

function emailConfigurado() {
  const c = leerCrmConfig();
  return Boolean(c.smtp && c.smtp.host && c.smtp.user && c.from);
}

function correosPermitidos() {
  const c = leerCrmConfig();
  return Array.isArray(c.adminEmails) ? c.adminEmails.map((e) => String(e).toLowerCase().trim()) : [];
}

/** La lista de autorizados la administra el dueño desde el propio CRM. */
function listarCorreos() {
  return correosPermitidos();
}

function agregarCorreo(email) {
  const limpio = String(email || '').toLowerCase().trim();
  if (!EMAIL_RE.test(limpio)) return { error: 'Correo inválido.' };
  const lista = correosPermitidos();
  if (lista.includes(limpio)) return { error: 'Ese correo ya está autorizado.' };
  if (lista.length >= MAX_CORREOS_AUTORIZADOS) return { error: `Máximo ${MAX_CORREOS_AUTORIZADOS} correos autorizados.` };
  const c = leerCrmConfig();
  c.adminEmails = [...lista, limpio];
  guardarCrmConfig(c);
  return { correos: c.adminEmails };
}

function quitarCorreo(email) {
  const limpio = String(email || '').toLowerCase().trim();
  const lista = correosPermitidos();
  if (!lista.includes(limpio)) return { error: 'Ese correo no está en la lista.' };
  const c = leerCrmConfig();
  c.adminEmails = lista.filter((e) => e !== limpio);
  guardarCrmConfig(c);
  return { correos: c.adminEmails };
}

/* ----------------------------------------------------------------- almacén */

class Tabla {
  constructor(archivo) {
    this.archivo = path.join(CRM_DIR, archivo);
    this.filas = null;
    this.sello = null;
    fs.mkdirSync(CRM_DIR, { recursive: true });
  }

  #estampa() {
    try {
      const st = fs.statSync(this.archivo);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return 'none';
    }
  }

  leer() {
    const estampa = this.#estampa();
    if (this.filas && this.sello === estampa) return this.filas;
    try {
      this.filas = JSON.parse(fs.readFileSync(this.archivo, 'utf8'));
    } catch {
      this.filas = [];
    }
    this.sello = estampa;
    return this.filas;
  }

  guardar(filas) {
    const tmp = `${this.archivo}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(filas, null, 1), 'utf8');
    fs.renameSync(tmp, this.archivo);
    this.filas = filas;
    this.sello = this.#estampa();
  }

  todas() {
    return this.leer();
  }

  porId(id) {
    return this.leer().find((f) => f.id === id) || null;
  }

  // Sello de auditoría estilo Dynamics: quién y cuándo en cada fila.
  agregar(fila, actor) {
    const ahora = new Date().toISOString();
    const conSello = {
      ...fila,
      createdby: actor || fila.createdby || '',
      createdon: fila.createdon || ahora,
      modifiedby: actor || '',
      modifiedon: ahora,
    };
    const filas = this.leer().slice();
    filas.push(conSello);
    this.guardar(filas);
    return conSello;
  }

  actualizar(id, cambios, actor) {
    const filas = this.leer().slice();
    const i = filas.findIndex((f) => f.id === id);
    if (i < 0) return null;
    filas[i] = { ...filas[i], ...cambios, id, modifiedby: actor || '', modifiedon: new Date().toISOString() };
    this.guardar(filas);
    return filas[i];
  }

  eliminar(id) {
    const filas = this.leer();
    const restantes = filas.filter((f) => f.id !== id);
    if (restantes.length === filas.length) return false;
    this.guardar(restantes);
    return true;
  }

  contar(predicado) {
    return this.leer().reduce((n, f) => (predicado(f) ? n + 1 : n), 0);
  }
}

const clientes = new Tabla('clientes.json');
const contactos = new Tabla('contactos.json');
const notas = new Tabla('notas.json');
const levantamientos = new Tabla('levantamientos.json');

function siguienteId(prefijo) {
  let meta = { seqCliente: 0, seqContacto: 0, seqNota: 0, seqLevantamiento: 0, seqEnvio: 0 };
  try {
    meta = { ...meta, ...JSON.parse(fs.readFileSync(path.join(CRM_DIR, 'meta.json'), 'utf8')) };
  } catch {
    // primer arranque
  }
  const campos = { c: 'seqCliente', p: 'seqContacto', n: 'seqNota', l: 'seqLevantamiento', e: 'seqEnvio' };
  const rellenos = { c: 5, p: 6, n: 6, l: 6, e: 6 };
  const campo = campos[prefijo];
  meta[campo] += 1;
  fs.writeFileSync(path.join(CRM_DIR, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return `${prefijo}${String(meta[campo]).padStart(rellenos[prefijo], '0')}`;
}

function normaliza(cadena) {
  return String(cadena || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/* --------------------------------------------------------------- validación */

function limpiarCampos(data, campos) {
  const out = {};
  for (const campo of campos) {
    out[campo] = H.clean(data[campo], LIMITES[campo] || 300).trim();
  }
  return out;
}

function validarCliente(data, clienteId) {
  const c = limpiarCampos(data, CLIENTE_FIELDS);
  const errores = {};
  if (c.nombre.length < 2) errores.nombre = 'Escribe el nombre de la empresa.';
  const num = c.numEmpleadosAprox;
  if (num) {
    const n = Number(num);
    if (!Number.isInteger(n) || n < 0 || n > 99999999) errores.numEmpleadosAprox = 'Número de empleados inválido.';
    else c.numEmpleadosAprox = n;
  } else {
    c.numEmpleadosAprox = null;
  }
  if (c.email && !EMAIL_RE.test(c.email)) errores.email = 'Ese correo no parece válido.';
  if (c.sitioWeb && !/^https?:\/\//i.test(c.sitioWeb)) c.sitioWeb = 'https://' + c.sitioWeb;
  if (!c.estadoSeguimiento) c.estadoSeguimiento = 'sin_contactar';
  else if (!ESTADOS_SEGUIMIENTO.includes(c.estadoSeguimiento)) {
    errores.estadoSeguimiento = 'Estado de seguimiento no válido.';
  }
  if (c.contactoPrincipalId) {
    const principal = contactos.porId(c.contactoPrincipalId);
    if (!principal || principal.clienteId !== clienteId) {
      errores.contactoPrincipalId = 'El contacto principal debe ser un contacto de esta empresa.';
    }
  } else {
    c.contactoPrincipalId = '';
  }
  return { datos: c, errores };
}

function validarContacto(data) {
  const c = limpiarCampos(data, CONTACTO_FIELDS);
  const errores = {};
  if (!clientes.porId(c.clienteId)) errores.clienteId = 'El cliente no existe.';
  if (c.nombres.length < 2 && !c.email && !c.celular) {
    errores.nombres = 'Escribe al menos un nombre, correo o celular.';
  }
  for (const campo of ['email', 'email2', 'email3']) {
    if (c[campo] && !EMAIL_RE.test(c[campo])) errores[campo] = 'Ese correo no parece válido.';
  }
  if (data.numEmpleadosAprox !== undefined && String(data.numEmpleadosAprox).trim() !== '') {
    const n = Number(data.numEmpleadosAprox);
    if (!Number.isInteger(n) || n < 0 || n > 99999999) errores.numEmpleadosAprox = 'Número de empleados inválido.';
  }
  return { datos: c, errores };
}

function validarNota(data) {
  const n = limpiarCampos(data, NOTA_FIELDS);
  const errores = {};
  if (!clientes.porId(n.clienteId)) errores.clienteId = 'El cliente no existe.';
  if (n.texto.length < 2) errores.texto = 'Escribe la nota (mínimo 2 caracteres).';
  return { datos: n, errores };
}

function validarLevantamiento(data) {
  const l = limpiarCampos(data, LEVANTAMIENTO_FIELDS);
  const errores = {};
  if (l.tipo && !TIPOS_LEVANTAMIENTO.includes(l.tipo)) errores.tipo = 'Pista inválida.';
  return { datos: l, errores };
}

/**
 * Levantamiento del agente de IA: uno por conversación (guid de la sesión);
 * las llamadas sucesivas fusionan solo los campos que traigan valor, así el
 * agente puede ir guardando a medida que averigua.
 */
function guardarLevantamiento({ guid, clienteId, contactoId, campos }, actor) {
  const { datos, errores } = validarLevantamiento(campos || {});
  if (Object.keys(errores).length) return { error: Object.values(errores).join(' ') };
  const existente = levantamientos.todas().find((l) => l.guid === guid);
  if (existente) {
    const cambios = {};
    for (const [campo, valor] of Object.entries(datos)) if (valor) cambios[campo] = valor;
    if (existente.clienteId !== clienteId || existente.contactoId !== contactoId) {
      cambios.clienteId = clienteId;
      cambios.contactoId = contactoId;
    }
    return { levantamiento: levantamientos.actualizar(existente.id, cambios, actor) };
  }
  const fila = { id: siguienteId('l'), guid, clienteId, contactoId };
  for (const [campo, valor] of Object.entries(datos)) if (valor) fila[campo] = valor;
  return { levantamiento: levantamientos.agregar(fila, actor) };
}

/** Levantamientos de una empresa, del más reciente al más viejo. */
function listarLevantamientos(clienteId) {
  return levantamientos
    .todas()
    .filter((l) => l.clienteId === clienteId)
    .sort((a, b) => String(b.modifiedon || b.createdon || '').localeCompare(String(a.modifiedon || a.createdon || '')));
}

/**
 * Un clic en el botón de WhatsApp = gestión comercial: pasa a "pendiente de
 * respuesta", registra la fecha y deja la nota de apertura para que el equipo
 * complete con lo que responda el cliente.
 * contactoId es opcional: cuando se gestiona un contacto concreto (lista de
 * contactos) se usa ese; si no, el contacto principal de la empresa.
 */
function registrarContactoWhatsapp(clienteId, contactoId, actor) {
  const cliente = clientes.porId(clienteId);
  if (!cliente) return { error: 'Cliente no encontrado.', status: 404 };
  const suyos = contactos.todas().filter((k) => k.clienteId === clienteId);
  // 7–15 dígitos: el techo internacional descarta fechas u otros basureros
  // heredados en la columna de celular (ej. "2023-11-29 05:00:00.0000000").
  const conCelular = (k) => {
    if (!k) return false;
    const d = String(k.celular || '').replace(/\D/g, '');
    return d.length >= 7 && d.length <= 15;
  };
  let destino;
  if (contactoId) {
    destino = suyos.find((k) => k.id === contactoId);
    if (!conCelular(destino)) {
      return { error: 'Ese contacto no tiene un celular válido.', status: 422 };
    }
  } else {
    const marcado = suyos.find((k) => k.id === cliente.contactoPrincipalId);
    destino = conCelular(marcado) ? marcado : suyos.find(conCelular);
  }
  if (!destino) {
    return { error: 'Ningún contacto de esta empresa tiene celular. Agrégalo en un contacto primero.', status: 422 };
  }
  const nombre = [destino.nombres, destino.apellidos].filter(Boolean).join(' ').trim() || 'sin nombre';
  const ahora = new Date().toISOString();
  clientes.actualizar(clienteId, { estadoSeguimiento: 'pendiente_respuesta', ultimaFechaContacto: ahora }, actor);
  const nota = notas.agregar({
    id: siguienteId('n'),
    clienteId,
    contactoId: destino.id,
    texto: `📱 Se inició contacto por WhatsApp con ${nombre} (${destino.celular}). Esperando respuesta…`,
  }, actor);
  return { ok: true, nota, contacto: destino };
}

/**
 * El número de empleados vive en la empresa. Si se edita desde el formulario
 * de un contacto, se propaga a la empresa (y por tanto a todos sus contactos).
 */
function propagarEmpleados(clienteId, valor, actor) {
  if (valor === undefined) return;
  const crudo = String(valor).trim();
  const nuevo = crudo === '' ? null : Number(crudo);
  const cliente = clientes.porId(clienteId);
  // sin cambio real no se toca el sello: editar un contacto sin tocar
  // empleados no debe dejar "modificado" a la empresa
  if (!cliente || cliente.numEmpleadosAprox === nuevo) return;
  clientes.actualizar(clienteId, { numEmpleadosAprox: nuevo }, actor);
}

/* ------------------------------------------------------------------- auth */

const tokens = new Map(); // jti -> { email, exp } ; el enlace es de un solo uso

function solicitarAcceso(emailCrudo) {
  const email = H.clean(emailCrudo, 160).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'Ese correo no parece válido.', status: 422 };
  if (!emailConfigurado()) {
    return {
      ok: false,
      status: 503,
      error: 'El correo del CRM no está configurado todavía. Avisa al administrador.',
    };
  }
  const permitidos = correosPermitidos();
  if (!permitidos.includes(email)) {
    // Respuesta igual que el caso exitoso: no revelar qué correos tienen acceso.
    return { ok: true, enviado: false };
  }
  const jti = crypto.randomBytes(16).toString('hex');
  const exp = Date.now() + TOKEN_MINUTOS * 60 * 1000;
  tokens.set(jti, { email, exp });
  const token = auth.sign({ e: email, exp, jti });
  const base = config.publicUrl || `http://localhost:${config.port}`;
  const enlace = `${base}/api/crm/auth/verificar?token=${encodeURIComponent(token)}`;
  const c = leerCrmConfig();
  return sendMail({
    host: c.smtp.host,
    port: Number(c.smtp.port) || (c.smtp.secure === false ? 587 : 465),
    secure: c.smtp.secure !== false,
    user: c.smtp.user,
    pass: c.smtp.pass,
    from: c.from,
    to: email,
    subject: 'Tu enlace de acceso al CRM de OPIA',
    text:
      `Hola,\n\nAbre este enlace para entrar al CRM (vence en ${TOKEN_MINUTOS} minutos y solo sirve una vez):\n\n` +
      `${enlace}\n\nSi no lo pediste, ignora este mensaje.\n— OPIA Software`,
  }).then(() => ({ ok: true, enviado: true })).catch((err) => {
    console.error('[crm] falló el envío del correo:', err.message);
    tokens.delete(jti);
    return { ok: false, status: 502, error: 'No pudimos enviar el correo. Intenta de nuevo en unos minutos.' };
  });
}

/** Correo interno a todos los autorizados del CRM (notificaciones del agente de IA). */
function notificarEquipo({ subject, text }) {
  if (!emailConfigurado()) return Promise.resolve({ ok: false, error: 'SMTP no configurado' });
  const destinatarios = correosPermitidos();
  if (!destinatarios.length) return Promise.resolve({ ok: false, error: 'sin correos autorizados' });
  const c = leerCrmConfig();
  return sendMail({
    host: c.smtp.host,
    port: Number(c.smtp.port) || (c.smtp.secure === false ? 587 : 465),
    secure: c.smtp.secure !== false,
    user: c.smtp.user,
    pass: c.smtp.pass,
    from: c.from,
    to: destinatarios.join(', '),
    subject,
    text,
  })
    .then(() => ({ ok: true }))
    .catch((err) => {
      console.error('[crm] falló el correo interno:', err.message);
      return { ok: false, error: err.message };
    });
}

/** Remitentes que Microsoft permite usar: el From configurado (con permiso
    Send As) y el propio buzón con el que se autentica el SMTP. */
function remitentesCorreo() {
  const c = leerCrmConfig();
  const lista = [];
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(String(c.from || ''));
  const principal = (m ? m[1] : String(c.from || '')).toLowerCase().trim();
  if (principal) lista.push({ valor: principal, porDefecto: true });
  const propio = String((c.smtp && c.smtp.user) || '').toLowerCase().trim();
  if (propio && !lista.some((r) => r.valor === propio)) lista.push({ valor: propio });
  return lista;
}

/** Correo transaccional a un destinatario arbitrario (magic link del agente y campañas). */
function enviarCorreo({ to, subject, text, html, de }) {
  if (!emailConfigurado()) return Promise.resolve({ ok: false, error: 'SMTP no configurado' });
  const c = leerCrmConfig();
  const elegido = de ? remitentesCorreo().find((r) => r.valor === String(de).toLowerCase().trim()) : null;
  return sendMail({
    host: c.smtp.host,
    port: Number(c.smtp.port) || (c.smtp.secure === false ? 587 : 465),
    secure: c.smtp.secure !== false,
    user: c.smtp.user,
    pass: c.smtp.pass,
    from: elegido ? elegido.valor : c.from,
    to,
    subject,
    text,
    html,
  })
    .then(() => ({ ok: true }))
    .catch((err) => {
      console.error('[crm] falló el correo transaccional:', err.message);
      return { ok: false, error: err.message };
    });
}

function verificarAcceso(token) {
  const payload = auth.unsign(token);
  if (!payload) return { ok: false, error: 'El enlace es inválido o venció. Pide uno nuevo.' };
  const guardado = tokens.get(payload.jti);
  if (!guardado || guardado.email !== payload.e || guardado.exp < Date.now()) {
    return { ok: false, error: 'El enlace es inválido o venció. Pide uno nuevo.' };
  }
  tokens.delete(payload.jti); // un solo uso
  const exp = Date.now() + SESION_DIAS * 86_400_000;
  const sesion = auth.sign({ e: payload.e, exp, jti: crypto.randomBytes(8).toString('hex') });
  return { ok: true, email: payload.e, sesion, exp };
}

function crearCookieSesion(res, sesion, exp, secure) {
  res.setHeader(
    'Set-Cookie',
    H.serializeCookie(COOKIE_CRM, sesion, {
      maxAgeSeconds: Math.max(0, Math.floor((exp - Date.now()) / 1000)),
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure,
    })
  );
}

function borrarCookieSesion(res) {
  res.setHeader(
    'Set-Cookie',
    H.serializeCookie(COOKIE_CRM, '', { maxAgeSeconds: 0, path: '/', httpOnly: true, sameSite: 'Lax' })
  );
}

function sesionActual(req) {
  const cookies = H.parseCookies(req.headers.cookie);
  const payload = auth.unsign(cookies[COOKIE_CRM]);
  if (!payload) return null;
  const permitidos = correosPermitidos();
  if (permitidos.length && !permitidos.includes(String(payload.e).toLowerCase())) return null;
  return payload.e;
}

module.exports = {
  Tabla,
  clientes,
  contactos,
  notas,
  levantamientos,
  siguienteId,
  normaliza,
  ESTADOS_SEGUIMIENTO,
  ETIQUETAS_LEVANTAMIENTO,
  registrarContactoWhatsapp,
  propagarEmpleados,
  validarCliente,
  validarContacto,
  validarNota,
  guardarLevantamiento,
  listarLevantamientos,
  solicitarAcceso,
  verificarAcceso,
  notificarEquipo,
  enviarCorreo,
  crearCookieSesion,
  borrarCookieSesion,
  sesionActual,
  emailConfigurado,
  remitentesCorreo,
  listarCorreos,
  agregarCorreo,
  quitarCorreo,
  COOKIE_CRM,
};
