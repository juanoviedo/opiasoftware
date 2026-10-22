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
 * Disponibilidad: calendarView sobre el día y huecos que caben completos
 * entre 8 y 19 h (horario comercial del dueño) con la duración pedida.
 * Reunión: evento con isOnlineMeeting=true, que
 * en cuentas organizacionales genera el joinUrl de Teams automáticamente.
 */
const RUTA_CONFIG = path.join(config.dataDir, 'teams-config.json');
const TENANT = 'b1c9a1d1-edc0-4d43-bb85-ba82c9e5b493';
const SCOPES_BASE = 'offline_access openid email profile';
// Mail.Read lo usa lib/rebotes.js para leer los avisos de devolución del buzón
const SCOPES = 'Calendars.ReadWrite Mail.Read ' + SCOPES_BASE;
const BASE_TOKEN = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
const BASE_GRAPH = 'https://graph.microsoft.com/v1.0';
// Colombia no tiene horario de verano: -05:00 todo el año
const TZ_WINDOWS = 'SA Pacific Standard Time';
const APERTURA = 8;
const CIERRE = 19; // nunca agendar reuniones que terminen después de las 7 pm
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

/** ¿El consentimiento vigente incluye lectura de correo? (lo pide lib/rebotes.js)
 *  No exige el access token vivo: dura una hora y graph() lo renueva solo. */
function correoAccesible() {
  const c = leerConfig();
  const haySesion = Boolean(c.tokens && c.tokens.refresh_token);
  return haySesion && /(^|\s)Mail\.Read(\s|$)/i.test(String(c.scopeConcedido || ''));
}

/**
 * El access token dura ~1 hora y el refresh meses: si solo venció el de acceso
 * se renueva solo. Sin esto el guarda de conectado() bloqueaba el refresh y el
 * calendario quedaba "no conectado" para siempre.
 */
async function asegurarActivo() {
  if (!configurado()) return false;
  const c = leerConfig();
  if (!c.tokens || !c.tokens.refresh_token) return false;
  try {
    await tokenFresco();
    return true;
  } catch {
    return false;
  }
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
  // Al renovar se pide solo lo que YA se consintió: si se pidiera Mail.Read
  // antes de que el dueño lo autorice, Azure rechaza el refresco y el calendario
  // del agente se cae con él.
  const scope = params.grant_type === 'refresh_token' ? c.scopeConcedido || 'Calendars.ReadWrite ' + SCOPES_BASE : SCOPES;
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    redirect_uri: c.redirectUri,
    scope,
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

/** Correo de la cuenta consentida, leído del id_token sin llamar a Graph
 *  (el token trae solo Calendars.ReadWrite: /me responde 403). */
function correoDeIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return String(payload.email || payload.preferred_username || payload.unique_name || '').toLowerCase();
  } catch {
    return '';
  }
}

/** Cambia el código de consentimiento por tokens; devuelve el correo de la cuenta. */
async function cambiarPorCodigo(code) {
  const data = await intercambiar({ grant_type: 'authorization_code', code });
  const c = leerConfig();
  c.tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  if (data.scope) c.scopeConcedido = data.scope;
  guardarConfig(c);
  return { accessToken: c.tokens.access_token, correo: correoDeIdToken(data.id_token) };
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
  if (data.scope) c.scopeConcedido = data.scope;
  guardarConfig(c);
  return c.tokens.access_token;
}

async function graph(metodo, ruta, cuerpo, headersExtra) {
  let token = await tokenFresco();
  const haz = (t) =>
    fetch(BASE_GRAPH + ruta, {
      method: metodo,
      headers: { Authorization: 'Bearer ' + t, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}), ...(headersExtra || {}) },
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
    '&$select=subject,start,end,showAs,isAllDay,isCancelled,id';
  // sin este header Graph devuelve los dateTime en UTC y el "-05:00" que se
  // agrega abajo queda 5 horas corrido (bug de huecos/encontrarEvento)
  const data = await graph('GET', ruta, undefined, { Prefer: 'outlook.timezone="SA Pacific Standard Time"' });
  return (data.value || []).filter((e) => !e.isCancelled);
}

/**
 * Huecos libres de un día (YYYY-MM-DD local a Bogotá) para una reunión de la
 * duración indicada (por defecto 60 min): el hueco debe caber completo dentro
 * del horario 8–19 y sin pisar eventos ocupados.
 * Devuelve { huecos: ['HH:MM'...], ocupados: [{inicio, fin}...] } en hora local.
 */
async function disponibilidad(fecha, duracionMinutos = 60) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error('fecha debe ser YYYY-MM-DD');
  const dur = Math.min(Math.max(Number(duracionMinutos) || 60, 15), 240);
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
  for (let min = APERTURA * 60; min + dur <= CIERRE * 60; min += DURACION_SLOT) {
    const pisa = ocupados.some((r) => min < r.fin && min + dur > r.ini);
    if (!pisa) huecos.push(`${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`);
  }
  return { huecos, fecha };
}

/**
 * Crea la reunión de Teams en el calendario del dueño e invita al cliente.
 * fecha YYYY-MM-DD + hora HH:MM (Bogotá). Lanza error si el hueco está ocupado.
 */
async function agendarReunion({ fecha, hora, duracion = 60, titulo, nombre, email, notas }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error('fecha debe ser YYYY-MM-DD');
  if (!/^\d{2}:\d{2}$/.test(hora)) throw new Error('hora debe ser HH:MM');
  const dur = Math.min(Math.max(Number(duracion) || 60, 15), 240);
  const [hI, mI] = hora.split(':').map(Number);
  // horario comercial: nunca antes de las 8:00 ni terminando después de las 19:00
  if (hI * 60 + mI < APERTURA * 60 || hI * 60 + mI + dur > CIERRE * 60) {
    throw new Error('ese horario queda fuera del horario de reuniones (8:00 a 19:00, hora de Colombia); ofrece otro');
  }
  const inicio = new Date(`${fecha}T${hora}:00-05:00`);
  if (Number.isNaN(inicio.getTime()) || inicio < new Date(Date.now() + 15 * 60_000)) {
    throw new Error('la reunión debe ser en el futuro (mínimo 15 minutos)');
  }
  const fin = new Date(inicio.getTime() + dur * 60_000);

  // doble chequeo del hueco justo antes de escribir
  const solapados = (await eventosEn(inicio.toISOString(), fin.toISOString())).filter(estaOcupado);
  if (solapados.length) throw new Error('ese hueco acaba de ocuparse, vuelve a consultar la disponibilidad');

  // hora local de Bogotá: Graph la interpreta con la zona declarada
  const finTotal = hI * 60 + mI + dur;
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

/**
 * Busca en el calendario el evento de una reunión agendada cuando la sesión aún
 * no guardaba eventoId (reuniones de antes de ese campo): coincide por la hora
 * de inicio guardada y porque es un evento de reunión OPIA.
 */
async function encontrarEvento(inicio) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(String(inicio || ''));
  if (!m) return '';
  const fecha = m[1];
  const eventos = await eventosEn(`${fecha}T00:00:00-05:00`, `${fecha}T23:59:59-05:00`);
  for (const e of eventos) {
    if (!/reunión/i.test(e.subject || '')) continue;
    const crudo = e.start.dateTime;
    const ini = new Date(crudo + (crudo.includes('Z') || /[+-]\d{2}:?\d{2}$/.test(crudo) ? '' : '-05:00'));
    const horaBog = new Date(ini.getTime() - 5 * 3600_000).toISOString().slice(11, 16);
    if (horaBog === m[2]) return e.id || '';
  }
  return '';
}

/**
 * Mueve una reunión ya creada a otra fecha/hora: PATCH sobre el mismo evento,
 * así el enlace de Teams y la lista de invitados se conservan y Microsoft reenvía
 * la invitación actualizada al cliente. Lanza error si el hueco está ocupado.
 */
async function moverReunion(eventoId, { fecha, hora, duracion } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) throw new Error('fecha debe ser YYYY-MM-DD');
  if (!/^\d{2}:\d{2}$/.test(hora || '')) throw new Error('hora debe ser HH:MM');
  const [hI, mI] = hora.split(':').map(Number);

  // sin duración nueva se conserva la del evento (se lee del calendario)
  let dur = Number(duracion);
  if (!Number.isFinite(dur) || dur <= 0) {
    const previo = await graph('GET', `/me/events/${encodeURIComponent(eventoId)}?$select=start,end`);
    const a = new Date(previo.start.dateTime + (previo.start.dateTime.includes('Z') || /[+-]\d{2}:?\d{2}$/.test(previo.start.dateTime) ? '' : '-05:00'));
    const b = new Date(previo.end.dateTime + (previo.end.dateTime.includes('Z') || /[+-]\d{2}:?\d{2}$/.test(previo.end.dateTime) ? '' : '-05:00'));
    dur = Math.round((b.getTime() - a.getTime()) / 60000);
  }
  dur = Math.min(Math.max(Number(dur) || 60, 15), 240);

  if (hI * 60 + mI < APERTURA * 60 || hI * 60 + mI + dur > CIERRE * 60) {
    throw new Error('ese horario queda fuera del horario de reuniones (8:00 a 19:00, hora de Colombia); ofrece otro');
  }
  const inicio = new Date(`${fecha}T${hora}:00-05:00`);
  if (Number.isNaN(inicio.getTime()) || inicio < new Date(Date.now() + 15 * 60_000)) {
    throw new Error('la reunión debe ser en el futuro (mínimo 15 minutos)');
  }
  const fin = new Date(inicio.getTime() + dur * 60_000);

  // el evento propio en su hora vieja no cuenta como conflicto del hueco nuevo
  const solapados = (await eventosEn(inicio.toISOString(), fin.toISOString())).filter((e) => estaOcupado(e) && e.id !== eventoId);
  if (solapados.length) throw new Error('ese hueco acaba de ocuparse, vuelve a consultar la disponibilidad');

  const finTotal = hI * 60 + mI + dur;
  const horaFin = `${String(Math.floor(finTotal / 60)).padStart(2, '0')}:${String(finTotal % 60).padStart(2, '0')}`;
  const actualizado = await graph('PATCH', `/me/events/${encodeURIComponent(eventoId)}`, {
    start: { dateTime: `${fecha}T${hora}:00`, timeZone: TZ_WINDOWS },
    end: { dateTime: `${fecha}T${horaFin}:00`, timeZone: TZ_WINDOWS },
  });
  const joinUrl = actualizado && actualizado.onlineMeeting && actualizado.onlineMeeting.joinUrl;
  if (!joinUrl) throw new Error('se actualizó el evento pero Microsoft no devolvió el enlace de Teams');
  return { joinUrl, inicio: `${fecha} ${hora}`, fin: horaFin, eventoId };
}

/**
 * Cancela la reunión y avisa al cliente: el «cancel» de Graph borra el evento
 * y envía a los invitados el correo de cancelación con el motivo como comentario.
 */
async function cancelarReunion(eventoId, motivo) {
  if (!eventoId) throw new Error('falta el id del evento');
  await graph('POST', `/me/events/${encodeURIComponent(eventoId)}/cancel`, {
    comment: String(motivo || '').trim().slice(0, 500) || 'La reunión fue cancelada.',
  });
  return { eventoId };
}

module.exports = {
  configurado,
  conectado,
  correoAccesible,
  asegurarActivo,
  urlConsentimiento,
  cambiarPorCodigo,
  limpiarTokens,
  graph,
  disponibilidad,
  agendarReunion,
  moverReunion,
  cancelarReunion,
  encontrarEvento,
  organizador: () => leerConfig().organizadorEmail || '',
};
