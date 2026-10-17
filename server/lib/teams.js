'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const auth = require('./auth');

/**
 * Integración con Microsoft Teams del dueño (cuenta joviedo@opiasoftware.com,
 * tenant Power Processes). Delegada: el servidor actúa con el consentimiento
 * del dueño y toca SOLO su calendario. La clave de la app y los tokens viven en
 * server/data/teams-config.json (ignorado por git), igual que ai-config.json.
 *
 * Disponibilidad: calendarView sobre el día y huecos de 30 min entre 8 y 18 h
 * (horario comercial del dueño). Reunión: evento con isOnlineMeeting=true, que
 * en cuentas organizacionales genera el joinUrl de Teams automáticamente.
 */
const RUTA_CONFIG = path.join(config.dataDir, 'teams-config.json');
const TENANT = 'b1c9a1d1-edc0-4d43-bb85-ba82c9e5b493';
const SCOPES = 'Calendars.ReadWrite offline_access openid email profile';
const BASE_TOKEN = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
const BASE_GRAPH = 'https://graph.microsoft.com/v1.0';
// Colombia no tiene horario de verano: -05:00 todo el año
const TZ_WINDOWS = 'SA Pacific Standard Time';
const APERTURA = 8;
const CIERRE = 18;
const DURACION_SLOT = 30;

function leerConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(RUTA_CONFIG, 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch {
    // sin archivo: las rutas avisan qué falta, no fallan
  }
  return {};
}

function guardarConfig(c) {
  const tmp = RUTA_CONFIG + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), 'utf8');
  fs.renameSync(tmp, RUTA_CONFIG);
}

function configurado() {
  const c = leerConfig();
  return Boolean(c.clientId && c.clientSecret);
}

function conectado() {
  const c = leerConfig();
  return Boolean(c.tokens && c.tokens.access_token && c.tokens.expires_at > Date.now() + 5 * 60_000);
}

/** URL de consentimiento firmada: el state evita que inyecten un callback ajenos. */
function urlConsentimiento() {
  const c = leerConfig();
  const state = auth.sign({ t: 'teams', exp: Date.now() + 10 * 60_000, jti: crypto.randomBytes(8).toString('hex') });
  const params = new URLSearchParams({
    client_id: c.clientId,
    response_type: 'code',
    redirect_uri: c.redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    state,
    login_hint: c.organizadorEmail || '',
  });
  return `${BASE_TOKEN}/authorize?${params.toString()}`;
}

async function intercambiar(params) {
  const c = leerConfig();
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    redirect_uri: c.redirectUri,
    scope: SCOPES,
    ...params,
  });
  const resp = await fetch(`${BASE_TOKEN}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const detalle = await resp.text().catch(() => '');
    throw new Error(`token ${resp.status}: ${detalle.slice(0, 200)}`);
  }
  return resp.json();
}

async function cambiarPorCodigo(code) {
  const data = await intercambiar({ grant_type: 'authorization_code', code });
  const c = leerConfig();
  c.tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  guardarConfig(c);
  return c.tokens.access_token;
}

async function tokenFresco() {
  const c = leerConfig();
  if (c.tokens.expires_at > Date.now() + 5 * 60_000) return c.tokens.access_token;
  const data = await intercambiar({ grant_type: 'refresh_token', refresh_token: c.tokens.refresh_token });
  c.tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || c.tokens.refresh_token,
    expires_at: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  guardarConfig(c);
  return c.tokens.access_token;
}

async function graph(metodo, ruta, cuerpo) {
  let token = await tokenFresco();
  const haz = (t) =>
    fetch(BASE_GRAPH + ruta, {
      method: metodo,
      headers: { Authorization: 'Bearer ' + t, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  let resp = await haz(token);
  if (resp.status === 401) {
    // refresh forzado por si el anterior quedó viejo entre comprobaciones
    const c = leerConfig();
    c.tokens.expires_at = 0;
    guardarConfig(c);
    token = await tokenFresco();
    resp = await haz(token);
  }
  if (!resp.ok) {
    const detalle = await resp.text().catch(() => '');
    throw new Error(`graph ${resp.status}: ${detalle.slice(0, 200)}`);
  }
  return resp.status === 204 ? null : resp.json();
}

/** Quién es el dueño según el token (para validar la cuenta del consentimiento). */
async function quienSoy(accessToken) {
  const resp = await fetch(`${BASE_GRAPH}/me`, {
    headers: { Authorization: 'Bearer ' + accessToken },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error('graph /me ' + resp.status);
  return resp.json();
}

/* -------------------------------------------------------------- disponibilidad */

function estaOcupado(ev) {
  if (ev.isAllDay) return true;
  if (ev.showAs && ev.showAs !== 'busy' && ev.showAs !== 'oof') return false; // free/tenative/workingElsewhere
  return true;
}

/** Eventos del calendario del dueño en un rango ISO (interpretados en -05:00). */
async function eventosEn(inicioIso, finIso) {
  const ruta =
    '/me/calendarView?startDateTime=' +
    encodeURIComponent(inicioIso) +
    '&endDateTime=' +
    encodeURIComponent(finIso) +
    '&$select=subject,start,end,showAs,isAllDay,isCancelled';
  const data = await graph('GET', ruta);
  return (data.value || []).filter((e) => !e.isCancelled);
}

/**
 * Huecos libres de 30 min de un día (YYYY-MM-DD local a Bogotá).
 * Devuelve { huecos: ['HH:MM'...], ocupados: [{inicio, fin}...] } en hora local.
 */
async function disponibilidad(fecha) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error('fecha debe ser YYYY-MM-DD');
  const inicioDia = `${fecha}T00:00:00-05:00`;
  const finDia = `${fecha}T23:59:59-05:00`;
  const eventos = await eventosEn(inicioDia, finDia);

  // intervalos ocupados en minutos desde medianoche local
  const ocupados = eventos
    .filter(estaOcupado)
    .map((e) => {
      const ini = new Date(e.start.dateTime + (e.start.dateTime.includes('Z') || /[+-]\d{2}:?\d{2}$/.test(e.start.dateTime) ? '' : '-05:00'));
      const fin = new Date(e.end.dateTime + (e.end.dateTime.includes('Z') || /[+-]\d{2}:?\d{2}$/.test(e.end.dateTime) ? '' : '-05:00'));
      const base = new Date(`${fecha}T00:00:00-05:00`).getTime();
      return { ini: (ini.getTime() - base) / 60000, fin: (fin.getTime() - base) / 60000 };
    })
    .filter((r) => Number.isFinite(r.ini) && Number.isFinite(r.fin));

  const huecos = [];
  for (let min = APERTURA * 60; min + DURACION_SLOT <= CIERRE * 60; min += DURACION_SLOT) {
    const pisa = ocupados.some((r) => min < r.fin && min + DURACION_SLOT > r.ini);
    if (!pisa) huecos.push(`${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`);
  }
  return { huecos, fecha };
}

/**
 * Crea la reunión de Teams en el calendario del dueño e invita al cliente.
 * fecha YYYY-MM-DD + hora HH:MM (Bogotá). Lanza error si el hueco está ocupado.
 */
async function agendarReunion({ fecha, hora, duracion = 30, titulo, nombre, email, notas }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error('fecha debe ser YYYY-MM-DD');
  if (!/^\d{2}:\d{2}$/.test(hora)) throw new Error('hora debe ser HH:MM');
  const inicio = new Date(`${fecha}T${hora}:00-05:00`);
  if (Number.isNaN(inicio.getTime()) || inicio < new Date(Date.now() + 15 * 60_000)) {
    throw new Error('la reunión debe ser en el futuro (mínimo 15 minutos)');
  }
  const fin = new Date(inicio.getTime() + duracion * 60_000);

  // doble chequeo del hueco justo antes de escribir
  const solapados = (await eventosEn(inicio.toISOString(), fin.toISOString())).filter(estaOcupado);
  if (solapados.length) throw new Error('ese hueco acaba de ocuparse, vuelve a consultar la disponibilidad');

  // hora local de Bogotá: Graph la interpreta con la zona declarada
  const [hI, mI] = hora.split(':').map(Number);
  const finTotal = hI * 60 + mI + duracion;
  const horaFin = `${String(Math.floor(finTotal / 60)).padStart(2, '0')}:${String(finTotal % 60).padStart(2, '0')}`;
  const evento = {
    subject: titulo || `Reunión OPIA Software — ${nombre || 'cliente'}`,
    body: {
      contentType: 'text',
      content:
        `Reunión por Microsoft Teams para conocer el proyecto de ${nombre || 'el cliente'}.\n\n` +
        (notas ? `Notas del levantamiento:\n${notas}\n\n` : '') +
        'El enlace de Teams queda en este evento (unirse en línea).',
    },
    start: { dateTime: `${fecha}T${hora}:00`, timeZone: TZ_WINDOWS },
    end: { dateTime: `${fecha}T${horaFin}:00`, timeZone: TZ_WINDOWS },
    attendees: email ? [{ emailAddress: { address: email, name: nombre || email }, type: 'required' }] : [],
    allowNewTimeProposals: true,
    isOnlineMeeting: true,
    onlineMeetingProvider: 'teamsForBusiness',
  };
  const creado = await graph('POST', '/me/events', evento);
  const joinUrl = creado && creado.onlineMeeting && creado.onlineMeeting.joinUrl;
  if (!joinUrl) throw new Error('se creó el evento pero Microsoft no devolvió el enlace de Teams');
  return { joinUrl, asunto: creado.subject, inicio: `${fecha} ${hora}`, fin: horaFin, eventoId: creado.id };
}

/** Ojo: la cuenta consentida no era la esperada → se descartan sus tokens. */
function limpiarTokens() {
  const c = leerConfig();
  delete c.tokens;
  guardarConfig(c);
}

module.exports = {
  configurado,
  conectado,
  urlConsentimiento,
  cambiarPorCodigo,
  quienSoy,
  limpiarTokens,
  disponibilidad,
  agendarReunion,
  organizador: () => leerConfig().organizadorEmail || '',
};
