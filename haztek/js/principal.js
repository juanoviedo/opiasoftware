/* ================================================================
   Haztek — comportamiento de la página
   Navegación, cifras animadas, animaciones de entrada, filtros de
   proyectos, formulario de cotización y eventos de analítica
   (dataLayer listo para GTM/GA4, que se activan al llenar los IDs).
   ================================================================ */
'use strict';

(function () {
  /* ------------------------------------------- analítica (ganchos GTM/GA4) */

  // Se llenan cuando existan las propiedades contratadas por Haztek.
  // Con solo ponerlos aquí, el snippet correspondiente se activa.
  var HAZTEK_GA4 = '';
  var HAZTEK_GTM = '';

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }

  if (HAZTEK_GTM) {
    window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
    var g = document.createElement('script');
    g.async = true;
    g.src = 'https://www.googletagmanager.com/gtm.js?id=' + HAZTEK_GTM;
    document.head.appendChild(g);
  } else if (HAZTEK_GA4) {
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + HAZTEK_GA4;
    document.head.appendChild(s);
    gtag('js', new Date());
    gtag('config', HAZTEK_GA4, { send_page_view: true });
  }

  // Eventos clave del brief: clic WhatsApp, envío de cotización y
  // apertura de una nube de puntos. Siempre van al dataLayer aunque
  // aún no haya contenedor conectado.
  window.haztekTrack = function (evento, datos) {
    window.dataLayer.push(Object.assign({ event: evento }, datos || {}));
  };

  /* -------------------------------------------------- datos de contacto */

  // Cambiar aquí el número y el mensaje prellenado de WhatsApp.
  var WHATSAPP_NUM = '573001234567';
  var WHATSAPP_MSG = 'Hola, vengo del sitio de Haztek y quiero cotizar un levantamiento.';

  function enlaceWhatsApp() {
    return 'https://wa.me/' + WHATSAPP_NUM + '?text=' + encodeURIComponent(WHATSAPP_MSG);
  }

  document.querySelectorAll('[data-wa]').forEach(function (el) {
    el.setAttribute('href', enlaceWhatsApp());
    el.addEventListener('click', function () {
      window.haztekTrack('whatsapp_click', { ubicacion: el.getAttribute('data-wa') });
    });
  });

  /* ---------------------------------------------------------------- cabecera */

  var cab = document.querySelector('.cab');
  var onCab = false;

  function pintarCab() {
    var nuevo = window.scrollY > 40;
    if (nuevo !== onCab) {
      onCab = nuevo;
      cab.classList.toggle('cab--on', onCab);
    }
  }
  window.addEventListener('scroll', pintarCab, { passive: true });
  pintarCab();

  var btnMenu = document.getElementById('btnMenu');
  var navegacion = document.querySelector('.navegacion');

  if (btnMenu && navegacion) {
    btnMenu.addEventListener('click', function () {
      var abierta = navegacion.classList.toggle('navegacion--abierta');
      btnMenu.setAttribute('aria-expanded', String(abierta));
    });
    navegacion.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        navegacion.classList.remove('navegacion--abierta');
        btnMenu.setAttribute('aria-expanded', 'false');
      });
    });
  }

  /* --------------------------------------------------- canvas del hero */

  var lienzo = document.getElementById('heroCanvas');
  var reduceMovimiento = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (lienzo && !reduceMovimiento) {
    var ctx = lienzo.getContext('2d');
    var puntos = [];
    var W = 0, H = 0;
    var escaneo = { y: 0, activo: true };

    function dimensionar() {
      var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      W = lienzo.clientWidth;
      H = lienzo.clientHeight;
      lienzo.width = Math.floor(W * dpr);
      lienzo.height = Math.floor(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function crearPuntos() {
      puntos = [];
      var n = Math.min(700, Math.floor((W * H) / 2600));
      for (var i = 0; i < n; i++) {
        puntos.push({
          x: Math.random() * W,
          y: Math.random() * H,
          r: Math.random() * 1.6 + 0.5,
          vx: (Math.random() - 0.5) * 0.14,
          vy: (Math.random() - 0.5) * 0.1,
          a: Math.random() * 0.5 + 0.15,
          cian: Math.random() < 0.3,
        });
      }
    }

    function cuadro(t) {
      ctx.clearRect(0, 0, W, H);

      // línea de barrido tipo escáner
      if (escaneo.activo) {
        var pos = (Math.sin(t / 3400) * 0.5 + 0.5) * H;
        var grad = ctx.createLinearGradient(0, pos - 60, 0, pos + 60);
        grad.addColorStop(0, 'rgba(56,189,248,0)');
        grad.addColorStop(0.5, 'rgba(56,189,248,0.055)');
        grad.addColorStop(1, 'rgba(56,189,248,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, pos - 60, W, 120);
        ctx.fillStyle = 'rgba(140,225,255,0.16)';
        ctx.fillRect(0, pos, W, 1);
      }

      for (var i = 0; i < puntos.length; i++) {
        var p = puntos[i];
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < -4) p.x = W + 4; else if (p.x > W + 4) p.x = -4;
        if (p.y < -4) p.y = H + 4; else if (p.y > H + 4) p.y = -4;
        var brillo = p.a * (0.7 + 0.3 * Math.sin(t / 900 + i));
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, 6.2832);
        ctx.fillStyle = p.cian
          ? 'rgba(120,215,255,' + brillo.toFixed(3) + ')'
          : 'rgba(255,255,255,' + (brillo * 0.75).toFixed(3) + ')';
        ctx.fill();
      }
      requestAnimationFrame(cuadro);
    }

    dimensionar();
    crearPuntos();
    requestAnimationFrame(cuadro);

    var reDim;
    window.addEventListener('resize', function () {
      clearTimeout(reDim);
      reDim = setTimeout(function () { dimensionar(); crearPuntos(); }, 180);
    });
    document.addEventListener('visibilitychange', function () {
      escaneo.activo = !document.hidden;
    });
  }

  /* ---------------------------------------------------- cifras animadas */

  function animarCifra(el) {
    var fin = parseFloat(el.getAttribute('data-fin').replace(',', '.'));
    var decimales = (el.getAttribute('data-fin').split(',')[1] || '').length;
    var sufijo = el.getAttribute('data-sufijo') || '';
    var inicio = null;
    var duracion = 1500;

    function valor(k) {
      var v = fin * k;
      var texto = decimales
        ? v.toFixed(decimales).replace('.', ',')
        : Math.round(v).toLocaleString('es-CO');
      return texto;
    }

    function paso(t) {
      if (inicio === null) inicio = t;
      var k = Math.min(1, (t - inicio) / duracion);
      var suave = 1 - Math.pow(1 - k, 3);
      el.innerHTML = '<em>' + valor(suave) + (sufijo ? ' ' + sufijo : '') + '</em>';
      if (k < 1) requestAnimationFrame(paso);
    }
    requestAnimationFrame(paso);
  }

  /* ------------------------------------------------- aparición de secciones */

  var observadores = [];
  if ('IntersectionObserver' in window) {
    var obsCifras = new IntersectionObserver(function (entradas) {
      entradas.forEach(function (e) {
        if (e.isIntersecting) {
          animarCifra(e.target);
          obsCifras.unobserve(e.target);
        }
      });
    }, { threshold: 0.4 });
    document.querySelectorAll('.cifra-num[data-fin]').forEach(function (el) {
      obsCifras.observe(el);
    });
    observadores.push(obsCifras);

    var obsRev = new IntersectionObserver(function (entradas) {
      entradas.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('rev--visible');
          obsRev.unobserve(e.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -30px 0px' });
    document.querySelectorAll('.rev').forEach(function (el) {
      obsRev.observe(el);
    });
    observadores.push(obsRev);
  } else {
    document.querySelectorAll('.cifra-num[data-fin]').forEach(animarCifra);
    document.querySelectorAll('.rev').forEach(function (el) {
      el.classList.add('rev--visible');
    });
  }

  /* -------------------------------------------- selector industria → proyectos */

  document.querySelectorAll('[data-ir-a-industria]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.preventDefault();
      var filtro = el.getAttribute('data-ir-a-industria');
      var chips = document.querySelectorAll('.filtro');
      chips.forEach(function (c) {
        var coincide = c.getAttribute('data-filtro') === filtro;
        c.classList.toggle('filtro--activo', coincide);
      });
      document.querySelectorAll('.proyecto').forEach(function (p) {
        var cats = (p.getAttribute('data-categorias') || '').split(' ');
        p.hidden = filtro !== 'todos' && !cats.includes(filtro);
      });
      document.getElementById('proyectos').scrollIntoView({ behavior: reduceMovimiento ? 'auto' : 'smooth' });
    });
  });

  /* ---------------------------------------------------------- filtros proyectos */

  document.querySelectorAll('.filtro').forEach(function (chip) {
    chip.addEventListener('click', function () {
      var filtro = chip.getAttribute('data-filtro');
      document.querySelectorAll('.filtro').forEach(function (c) {
        c.classList.toggle('filtro--activo', c === chip);
      });
      document.querySelectorAll('.proyecto').forEach(function (p) {
        var cats = (p.getAttribute('data-categorias') || '').split(' ');
        p.hidden = filtro !== 'todos' && !cats.includes(filtro);
      });
    });
  });

  /* --------------------------------------------------------------------- FAQ */

  document.querySelectorAll('.faq__pregunta').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var item = btn.closest('.faq__item');
      var abierto = item.classList.contains('faq__item--abierto');
      document.querySelectorAll('.faq__item').forEach(function (i) {
        i.classList.remove('faq__item--abierto');
      });
      item.classList.toggle('faq__item--abierto', !abierto);
    });
  });

  /* -------------------------------------------------------- formulario */

  var formulario = document.getElementById('formCotizar');

  if (formulario) {
    var arrancado = false;
    formulario.addEventListener('focusin', function () {
      if (!arrancado) {
        arrancado = true;
        window.haztekTrack('form_start');
      }
    });

    formulario.addEventListener('submit', function (e) {
      e.preventDefault();

      var datos = new FormData(formulario);
      var errores = [];

      var nombre = String(datos.get('nombre') || '').trim();
      var correo = String(datos.get('correo') || '').trim();
      var telefono = String(datos.get('telefono') || '').trim();
      var tipo = String(datos.get('tipo') || '');
      var detalle = String(datos.get('detalle') || '').trim();
      var consentimiento = formulario.querySelector('#consentimiento').checked;

      function marcar(id, hay) {
        var campo = formulario.querySelector('#' + id).closest('.campo');
        if (campo) campo.classList.toggle('campo--error', hay);
        if (hay) errores.push(id);
      }

      marcar('nombre', nombre.length < 2);
      marcar('correo', correo !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo));
      marcar('telefono', telefono.replace(/\D/g, '').length < 7);
      marcar('detalle', detalle.length < 10);
      marcar('consentimiento', !consentimiento);

      var aviso = document.getElementById('formAviso');
      if (errores.length) {
        aviso.textContent = 'Revisa los campos marcados antes de enviar.';
        aviso.style.display = 'block';
        return;
      }
      aviso.style.display = 'none';

      var boton = formulario.querySelector('button[type="submit"]');
      boton.disabled = true;
      boton.textContent = 'Enviando…';

      fetch('/api/haztek/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre: nombre,
          correo: correo,
          telefono: telefono,
          tipo: tipo,
          detalle: detalle,
          consentimiento: true,
          website: '',
          url_field: '',
        }),
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (r) {
          if (!r.ok || !r.j.ok) throw new Error(r.j && r.j.error);
          window.haztekTrack('cotizacion_enviada', { tipo: tipo });
          formulario.style.display = 'none';
          var exito = document.getElementById('formExito');
          exito.style.display = 'block';
          var waExito = document.getElementById('waExito');
          if (waExito) waExito.href = enlaceWhatsApp();
        })
        .catch(function () {
          boton.disabled = false;
          boton.textContent = 'Enviar solicitud';
          aviso.textContent = 'No se pudo enviar. Escríbenos por WhatsApp y te atendemos al instante.';
          aviso.style.display = 'block';
        });
    });
  }

  /* ------------------------------------------------------------------ misc */

  var anio = document.getElementById('anio');
  if (anio) anio.textContent = String(new Date().getFullYear());
})();
