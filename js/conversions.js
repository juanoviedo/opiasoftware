(function () {
  'use strict';

  if (window.__opiaConvLoaded) return;
  window.__opiaConvLoaded = true;

  function firePixel(event, data) {
    try {
      if (typeof window.fbq === 'function') window.fbq('track', event, data || {});
    } catch (e) {}
  }

  function fireAds(kind) {
    try {
      if (typeof window.opiaConvert === 'function') window.opiaConvert(kind);
    } catch (e) {}
  }

  function pagePath() {
    return window.opiaPixelPath || window.location.pathname;
  }

  // Un solo Contact por carga de página: repetir el evento infla las
  // conversiones y hace que Google y Meta optimicen contra datos falsos.
  var contactFired = false;

  document.addEventListener(
    'click',
    function (event) {
      var node = event.target;
      if (!node || typeof node.closest !== 'function') return;
      var link = node.closest('a[href]');
      if (!link) return;
      var href = link.getAttribute('href') || '';
      if (!/wa\.me\/|api\.whatsapp\.com|whatsapp:\/\//i.test(href)) return;
      if (contactFired) return;
      contactFired = true;
      firePixel('Contact', { content_name: 'whatsapp', content_category: pagePath() });
      fireAds('contact');
      try {
        if (typeof window.opiaTrack === 'function') {
          window.opiaTrack('whatsapp_out', { href: href });
        }
      } catch (e) {}
    },
    true
  );

  // Señal de intención: útil mientras una campaña no junta volumen de Lead.
  var intentFired = false;
  document.addEventListener(
    'focusin',
    function (event) {
      if (intentFired) return;
      var node = event.target;
      if (!node || !node.form || node.form.getAttribute('data-lead-form') !== 'true') return;
      intentFired = true;
      try {
        if (typeof window.fbq === 'function') {
          window.fbq('trackCustom', 'FormStart', { content_category: pagePath() });
        }
      } catch (e) {}
      try {
        if (typeof window.opiaTrack === 'function') window.opiaTrack('form_start');
      } catch (e) {}
    },
    true
  );

  /** Lo llama el formulario cuando el registro quedó guardado de verdad. */
  window.opiaLeadSent = function (data) {
    firePixel('Lead', data || { content_name: 'formulario', content_category: pagePath() });
    fireAds('lead');
  };
})();
