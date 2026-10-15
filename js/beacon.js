(function () {
  'use strict';

  if (window.__opiaBeaconLoaded) return;
  window.__opiaBeaconLoaded = true;

  var VID_KEY = 'opia_vid';
  var SID_KEY = 'opia_sid';
  var ENDPOINT = '/api/track';

  function uuid() {
    try {
      if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (e) {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function persistentId(store, key) {
    try {
      var existing = store.getItem(key);
      if (existing) return existing;
      var created = uuid();
      store.setItem(key, created);
      return created;
    } catch (e) {
      return uuid();
    }
  }

  var vid = persistentId(window.localStorage, VID_KEY);
  var sid = persistentId(window.sessionStorage, SID_KEY);

  // La navegación interna es con recarga completa, así que el UTM del anuncio
  // se pierde al pasar de / a /contacto. Se guarda el primer toque de la sesión
  // para poder atribuir ese lead a la campaña que realmente lo trajo.
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  var FT_KEY = 'opia_ft';

  function firstTouch() {
    var params = new URLSearchParams(window.location.search);
    var found = null;
    UTM_KEYS.forEach(function (key) {
      var value = params.get(key);
      if (value) {
        found = found || {};
        found[key] = value;
      }
    });
    if (params.get('fbclid')) {
      found = found || {};
      found.fbclid = true;
    }
    if (params.get('gclid') || params.get('gbraid') || params.get('wbraid')) {
      found = found || {};
      found.gclid = true;
    }
    if (found) {
      try {
        window.sessionStorage.setItem(FT_KEY, JSON.stringify(found));
      } catch (e) {}
      return found;
    }
    try {
      return JSON.parse(window.sessionStorage.getItem(FT_KEY) || 'null') || {};
    } catch (e) {
      return {};
    }
  }

  var ft = firstTouch();
  window.opiaFirstTouch = ft;

  function send(payload) {
    var body;
    try {
      body = JSON.stringify(payload);
    } catch (e) {
      return;
    }
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(ENDPOINT, blob)) return;
      }
    } catch (e) {}
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        body: body,
        keepalive: true,
        mode: 'same-origin',
        credentials: 'omit',
      });
    } catch (e) {}
  }

  function basePayload(event) {
    var offsetMinutes = new Date().getTimezoneOffset();
    return {
      v: 1,
      ev: event || 'pageview',
      vid: vid,
      sid: sid,
      p: window.location.pathname + window.location.search,
      r: document.referrer || '',
      ti: document.title || '',
      sw: window.screen ? window.screen.width : 0,
      sh: window.screen ? window.screen.height : 0,
      lang: navigator.language || '',
      tz: Number.isFinite(offsetMinutes) ? -offsetMinutes / 60 : null,
      ft: ft,
    };
  }

  send(basePayload('pageview'));

  // WhatsApp es hoy el único canal de contacto del sitio, así que cada clic
  // se registra: es el proxy de lead mientras no exista un formulario.
  document.addEventListener(
    'click',
    function (event) {
      var node = event.target;
      if (!node || typeof node.closest !== 'function') return;
      var link = node.closest('a[href]');
      if (!link) return;
      var href = link.getAttribute('href') || '';
      if (!/wa\.me\/|api\.whatsapp\.com|whatsapp:\/\//i.test(href)) return;
      var payload = basePayload('whatsapp');
      payload.href = href;
      send(payload);
    },
    true
  );

  window.opiaTrack = function (name, data) {
    var payload = basePayload(name);
    if (data) {
      for (var key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key)) payload[key] = data[key];
      }
    }
    send(payload);
  };
})();
