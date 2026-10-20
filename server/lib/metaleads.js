'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const crm = require('./crm');

const API = 'https://graph.facebook.com/v25.0';
const ACTOR = 'meta_ads';
const PAIS_CELULAR = 'CO';
const MAX_VISTOS = 5000;

/* --------------------------------------------------------------- configuración
 * En producción la config efectiva vive en el volumen (dataDir), junto a los
 * demás secretos del servidor; en desarrollo se usa la del repo, que está
 * fuera de git. El token de corta duración que pegue el dueño se convierte en
 * tokens de larga duración y se guarda de vuelta en el mismo archivo.
 */

function rutaConfig() {
  const enVolumen = path.join(config.dataDir, 'meta-config.json');
  if (fs.existsSync(enVolumen)) return enVolumen;
  return path.join(config.serverDir, 'meta-config.json');
}

function configurado() {
  const cfg = leerConfig();
  return Boolean(cfg && cfg.app_id && cfg.app_secret && cfg.access_token);
}

function leerConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(rutaConfig(), 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch {
    // sin archivo: el ciclo queda desactivado
  }
  return null;
}

function guardarConfig(raw) {
  const destino = rutaConfig();
  const tmp = destino + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8');
  fs.renameSync(tmp, destino);
}

/* --------------------------------------------------------------------- estado
 * IDs de leads ya importados: sin esto, cada ciclo duplicaría contactos.
 */

function rutaEstado() {
  return path.join(config.dataDir, 'meta-leads-state.json');
}

function leerEstado() {
  try {
    const raw = JSON.parse(fs.readFileSync(rutaEstado(), 'utf8'));
    if (raw && typeof raw === 'object' && raw.vistos && typeof raw.vistos === 'object') return raw;
  } catch {
    // primer ciclo
  }
  return { vistos: {} };
}

function guardarEstado(estado) {
  const ids = Object.keys(estado.vistos);
  if (ids.length > MAX_VISTOS) {
    const recientes = ids
      .sort((a, b) => String(estado.vistos[b]).localeCompare(String(estado.vistos[a])))
      .slice(0, MAX_VISTOS);
    estado.vistos = Object.fromEntries(recientes.map((id) => [id, estado.vistos[id]]));
  }
  const tmp = rutaEstado() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(estado, null, 2), 'utf8');
  fs.renameSync(tmp, rutaEstado());
}

/* ---------------------------------------------------------------------- API */

class ErrorMeta extends Error {}

function prueba(appSecret, token) {
  return crypto.createHmac('sha256', appSecret).update(token).digest('hex');
}

async function apiGet(cfg, ruta, params = {}, token) {
  const accessToken = token || cfg.access_token;
  const q = new URLSearchParams({
    access_token: accessToken,
    appsecret_proof: prueba(cfg.app_secret, accessToken),
    ...params,
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25_000);
  try {
    const resp = await fetch(`${API}/${ruta}?${q}`, { signal: ctl.signal });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const detalle = data && data.error ? data.error : {};
      const err = new ErrorMeta(
        `Meta ${ruta}: ${detalle.code || resp.status} ${detalle.message || resp.statusText}`
      );
      err.codigo = detalle.code;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* El intercambio de tokens se autentica con client_secret directo: la appsecret_proof
 * no aplica en /oauth/access_token. */
async function intercambiarTokenLargo(cfg, tokenCorto) {
  const q = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: cfg.app_id,
    client_secret: cfg.app_secret,
    fb_exchange_token: tokenCorto,
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25_000);
  try {
    const resp = await fetch(`${API}/oauth/access_token?${q}`, { signal: ctl.signal });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.access_token) {
      const detalle = data && data.error ? data.error : {};
      throw new ErrorMeta(`Meta oauth: ${detalle.code || resp.status} ${detalle.message || 'sin token'}`);
    }
    return data.access_token;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deja en cfg (y en disco) un token de página de larga duración, que es el que
 * lee formularios y leads. El token pegado a mano dura ~1 hora: por eso se
 * canjea de inmediato por uno de usuario de 60 días y con ese se saca el de
 * página, que no vence mientras no cambien la contraseña ni se revoque.
 */
async function asegurarTokenPagina(cfg) {
  if (cfg.page_access_token && cfg.page_id) return;

  const usuarioLargo = await intercambiarTokenLargo(cfg, cfg.access_token);
  const paginas = await apiGet(
    { ...cfg, access_token: usuarioLargo },
    'me/accounts',
    { fields: 'id,name,username' },
    usuarioLargo
  );
  const lista = (paginas.data || []).filter((p) => p && p.id);
  let elegida = lista.find((p) => p.id === cfg.page_id);
  if (!elegida) elegida = lista.find((p) => (p.username || '').toLowerCase() === 'opiasoftware');
  if (!elegida && lista.length === 1) elegida = lista[0];
  if (!elegida) throw new ErrorMeta('Meta: no se pudo elegir la página de OPIA (revisa page_id en meta-config.json).');

  const pagina = await apiGet(
    { ...cfg, access_token: usuarioLargo },
    String(elegida.id),
    { fields: 'access_token' },
    usuarioLargo
  );
  if (!pagina.access_token) throw new ErrorMeta('Meta: la página no devolvió access_token.');

  const nuevo = {
    ...cfg,
    access_token: usuarioLargo,
    page_id: String(elegida.id),
    page_username: elegida.username || '',
    page_access_token: pagina.access_token,
  };
  guardarConfig(nuevo);
  cfg.access_token = nuevo.access_token;
  cfg.page_id = nuevo.page_id;
  cfg.page_access_token = nuevo.page_access_token;
}

/* ------------------------------------------------------------------- parsing */

function normalizaClave(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
}

function camposDeLead(lead) {
  const resultado = { extra: [] };
  for (const campo of lead.field_data || []) {
    const valor = (campo.values || []).filter(Boolean).join(', ').trim();
    if (!valor) continue;
    const clave = normalizaClave(campo.name);
    if (clave === 'full name' || clave === 'full_name' || clave === 'nombre completo') {
      resultado.nombre = valor;
    } else if (clave === 'email' || clave === 'correo') {
      resultado.email = valor;
    } else if (clave.startsWith('phone') || clave === 'celular' || clave === 'telefono' || clave === 'telefono movil') {
      resultado.celular = valor;
    } else if (clave.includes('personas trabajan') || clave.includes('cuantas personas') || clave.includes('tamano de la empresa') || clave.includes('tamaño')) {
      resultado.tamano = valor;
    } else if (clave.includes('proceso')) {
      resultado.proceso = valor;
    } else {
      resultado.extra.push({ nombre: campo.name, valor });
    }
  }
  return resultado;
}

function fechaLegible(iso) {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return String(iso || '');
  return fecha.toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'medium', timeStyle: 'short' });
}

/* -------------------------------------------------------------- alta en CRM */

// El mismo lead puede entrar por dos vías (a mano hoy, por API mañana):
// si ya existe un contacto con ese correo o celular, no se crea de nuevo.
function contactoDuplicado(email, celular) {
  const emailN = crm.normaliza(email || '');
  const digitos = String(celular || '').replace(/\D/g, '');
  if (!emailN && !(digitos.length >= 7)) return null;
  return (
    crm.contactos.todas().find((c) => {
      if (emailN && crm.normaliza(c.email || '') === emailN) return true;
      if (digitos.length >= 7 && String(c.celular || '').replace(/\D/g, '') === digitos) return true;
      return false;
    }) || null
  );
}

function empresaDelFormulario(form) {
  const nombre = `Meta · ${(form.name || 'formulario').trim()}`;
  const previa = crm.clientes.todas().find((c) => crm.normaliza(c.nombre) === crm.normaliza(nombre));
  if (previa) return previa;
  const { datos, errores } = crm.validarCliente({
    nombre,
    notas: `Empresa contenedora de los leads que llegan por el formulario de Meta "${form.name}". El equipo los reclasifica a su empresa real.`,
    archivoOrigen: 'meta_ads',
  });
  if (Object.keys(errores).length) throw new Error('No se pudo crear la empresa del formulario: ' + Object.values(errores).join(' '));
  return crm.clientes.agregar({ id: crm.siguienteId('c'), ...datos }, ACTOR);
}

function crearRegistroLead(lead, form) {
  const f = camposDeLead(lead);
  const empresa = empresaDelFormulario(form);

  const lineas = [
    `Lead de Meta Ads · formulario "${form.name}".`,
    `Recibido: ${fechaLegible(lead.created_time)} (hora Colombia).`,
  ];
  if (lead.ad_id) lineas.push(`Anuncio: ${lead.ad_id}.`);
  if (f.tamano) lineas.push(`Tamaño de empresa: ${f.tamano}.`);
  if (f.proceso) lineas.push(`Proceso de interés: ${f.proceso}.`);
  for (const extra of f.extra) lineas.push(`${extra.nombre}: ${extra.valor}.`);

  const contactoData = {
    clienteId: empresa.id,
    nombres: f.nombre || 'Lead Meta sin nombre',
    apellidos: '',
    email: f.email || '',
    celular: f.celular || '',
    descripcion: f.tamano ? `Tamaño de empresa (según formulario): ${f.tamano}` : '',
    observaciones: f.proceso || '',
    origen: 'Meta Ads',
    estado: 'lead',
    idExterno: String(lead.id),
    archivoOrigen: 'meta_ads',
  };
  const { datos, errores } = crm.validarContacto(contactoData);
  if (Object.keys(errores).length) {
    return { omitido: Object.values(errores).join(' ') };
  }
  const contacto = crm.contactos.agregar({ id: crm.siguienteId('p'), ...datos }, ACTOR);
  crm.notas.agregar({ id: crm.siguienteId('n'), clienteId: empresa.id, contactoId: contacto.id, texto: lineas.join('\n') }, ACTOR);
  return { contacto, empresa };
}

/* --------------------------------------------------------------------- ciclo */

/**
 * Consulta los formularios leadgen de la página e importa al CRM los leads
 * que aún no están en el estado. Deduplica por ID de lead en disco, así un
 * reinicio no vuelve a crear nada.
 */
async function importarCiclo() {
  const cfg = leerConfig();
  if (!cfg || !cfg.app_id || !cfg.app_secret || !cfg.access_token) {
    return { ok: false, razon: 'sin_config' };
  }

  try {
    await asegurarTokenPagina(cfg);
  } catch (e) {
    if (e.codigo === 190 || /oauth/i.test(e.message)) {
      return { ok: false, razon: `token_meta_invalido: ${e.message}` };
    }
    throw e;
  }

  const formularios = await apiGet(
    cfg,
    `${cfg.page_id}/leadgen_forms`,
    { fields: 'id,name,status,leads_count', limit: 100 },
    cfg.page_access_token
  );

  const estado = leerEstado();
  const ahora = new Date().toISOString();
  const creados = [];
  const omitidos = [];
  let formulariosRevisados = 0;

  for (const form of (formularios.data || []).filter((f) => f && f.id)) {
    formulariosRevisados += 1;
    const leads = await apiGet(
      cfg,
      `${form.id}/leads`,
      { fields: 'id,created_time,ad_id,form_id,field_data', limit: 100 },
      cfg.page_access_token
    );
    for (const lead of (leads.data || []).filter((l) => l && l.id)) {
      if (estado.vistos[lead.id]) continue;
      const f = camposDeLead(lead);
      const previo = contactoDuplicado(f.email, f.celular);
      if (previo) {
        console.log(`[metaleads] lead ${lead.id} omitido: ya existe el contacto ${previo.id} (${previo.email || previo.celular}).`);
        estado.vistos[lead.id] = ahora;
        continue;
      }
      try {
        const r = crearRegistroLead(lead, form);
        if (r.omitido) omitidos.push({ lead: lead.id, razon: r.omitido });
        else creados.push(r);
      } catch (e) {
        omitidos.push({ lead: lead.id, razon: e.message });
      }
      estado.vistos[lead.id] = ahora;
    }
  }

  guardarEstado(estado);

  if (creados.length) {
    const nombres = creados
      .map((r) => {
        const c = r.contacto;
        return `· ${[c.nombres, c.apellidos].filter(Boolean).join(' ')} (${c.email || c.celular || 'sin contacto'})`;
      })
      .join('\n');
    crm.notificarEquipo({
      subject: `${creados.length} lead(s) nuevo(s) de Meta Ads ya en el CRM`,
      text: `Llegaron por la campaña de Meta y quedaron creados en el CRM:\n\n${nombres}\n\nRevisarlos en ${config.publicUrl || 'el CRM'} → contactos con origen "Meta Ads".`,
    });
  }

  return { ok: true, nuevos: creados.length, creados, omitidos, formularios: formulariosRevisados };
}

/* Para el setInterval del servidor: nunca debe tumbar el proceso. */
function ciclo() {
  return importarCiclo()
    .then((r) => {
      if (r.ok && r.nuevos) console.log(`[metaleads] ${r.nuevos} lead(s) nuevo(s) importados al CRM.`);
      if (!r.ok && r.razon && r.razon !== 'sin_config') console.error('[metaleads]', r.razon);
      return r;
    })
    .catch((e) => {
      console.error('[metaleads] falló el ciclo:', e.message);
      return { ok: false, razon: e.message };
    });
}

module.exports = { importarCiclo, ciclo, configurado, camposDeLead, crearRegistroLead, contactoDuplicado };
