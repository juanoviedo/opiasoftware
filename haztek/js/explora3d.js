/* ================================================================
   Haztek — Explora en 3D
   Visor WebGL de nubes de puntos sin dependencias: carga progresiva
   por bloques, órbita con arrastre, zoom con rueda o pellizco, y
   cuatro nubes de proyectos (demostración, en espera de los datos
   reales de cada proyecto).
   ================================================================ */
'use strict';

(function () {
  /* ------------------------------------------------------------ utilidades */

  function mulberry32(semilla) {
    let a = semilla >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const mezcla = (a, b, t) => a + (b - a) * t;

  /* Un color con ruido leve: las nubes reales nunca son planas. */
  function color(r, g, b, rnd, ruido) {
    const k = ruido === undefined ? 0.04 : ruido;
    const n = (rnd() - 0.5) * 2 * k;
    return [r + n, g + n, b + n];
  }

  /* --------------------------------------------------- nubes de proyectos */

  /* Cada generador produce la nube por fases (yield) para no congelar
     la interfaz, imitando la carga progresiva de un visor real. */

  function* genCorredorVial(rnd, d) {
    const out = [];
    const push = (x, y, z, c) => out.push(x, y, z, c[0], c[1], c[2]);

    const yCarretera = (x) => 1.2 * Math.sin(x * 0.013) + 0.8 * Math.sin(x * 0.031 + 1.7);
    const anchoCorredor = (z) => Math.exp(-((z / 26) ** 2)); // 1 sobre la vía, 0 en la montaña
    const yTerreno = (x, z) => {
      const base = yCarretera(x);
      const montana =
        Math.max(0, Math.abs(z) - 14) * 0.34 + 2.6 * Math.sin(z * 0.11 + x * 0.004) + 1.8 * Math.sin(x * 0.02) ** 2;
      return mezcla(base, base + montana, 1 - anchoCorredor(z));
    };

    // terreno
    for (let x = -220; x <= 220; x += 1.0 / d) {
      for (let z = -52; z <= 52; z += 1.0 / d) {
        const y = yTerreno(x, z);
        const cesped = color(0.44, 0.5, 0.3, rnd, 0.07);
        const roca = color(0.5, 0.47, 0.42, rnd, 0.06);
        const pendiente = Math.abs(yTerreno(x, z + 1.5) - y);
        push(x, y, z, mezclaColor(cesped, roca, Math.min(1, pendiente * 1.6)));
      }
      if (out.length > 42000) { yield new Float32Array(out); out.length = 0; }
    }
    yield new Float32Array(out); out.length = 0;

    // calzada, bermas y demarcación
    for (let x = -220; x <= 220; x += 0.55 / d) {
      const yv = yCarretera(x) + 0.16;
      for (let z = -8.4; z <= 8.4; z += 0.55 / d) {
        let c;
        const ax = Math.abs(z);
        if (ax <= 7.4) c = color(0.17, 0.18, 0.2, rnd, 0.025);
        else c = color(0.36, 0.33, 0.28, rnd, 0.05); // berma de grava
        if (ax < 0.28 && (x % 12 + 12) % 12 < 5.5) c = color(0.82, 0.69, 0.14, rnd, 0.03); // línea central amarilla
        if (ax > 6.9 && ax < 7.25) c = color(0.85, 0.85, 0.85, rnd, 0.03); // borde blanco
        push(x, yv - 0.04 * (z / 8.4) ** 2, z, c);
      }
      if (out.length > 42000) { yield new Float32Array(out); out.length = 0; }
    }
    yield new Float32Array(out); out.length = 0;

    // postes de guardarraya
    for (let x = -220; x <= 220; x += 4) {
      for (const lado of [-8.9, 8.9]) {
        const yt = yTerreno(x, lado);
        for (let h = 0.1; h <= 0.85; h += 0.18) push(x, yt + h, lado, color(0.55, 0.57, 0.6, rnd));
        push(x, yt + 0.62, lado + (lado < 0 ? 0.25 : -0.25), color(0.72, 0.74, 0.77, rnd));
      }
    }

    // postes de alumbrado
    for (let x = -204; x <= 204; x += 36) {
      const lado = (Math.floor(x / 36) % 2 === 0) ? 12.6 : -12.6;
      const yt = yTerreno(x, lado);
      for (let h = 0.2; h <= 9; h += 0.22) push(x, yt + h, lado, color(0.42, 0.44, 0.48, rnd));
      for (let b = 0; b <= 1.8; b += 0.3) push(x - b * Math.sign(lado), yt + 8.9, lado, color(0.42, 0.44, 0.48, rnd));
      push(x - 1.9 * Math.sign(lado), yt + 8.7, lado, color(0.98, 0.88, 0.55, rnd));
    }

    // vehículos en movimiento (para escala)
    const autos = [
      { x: -52, z: 3.6, c: [0.75, 0.16, 0.14] },
      { x: 40, z: -3.6, c: [0.9, 0.9, 0.92] },
      { x: 150, z: 3.6, c: [0.16, 0.3, 0.72] },
    ];
    for (const auto of autos) {
      const yv = yCarretera(auto.x) + 0.16;
      for (let l = -2.1; l <= 2.1; l += 0.35) {
        for (let w = -0.85; w <= 0.85; w += 0.3) {
          let h = 0.55;
          if (l > 0.2 && l < 1.4) h = 1.35; // cabina
          for (let hh = 0.25; hh <= h; hh += 0.28) {
            push(auto.x + l, yv + hh, auto.z + w, color(auto.c[0], auto.c[1], auto.c[2], rnd, 0.03));
          }
        }
      }
    }

    // vegetación de ribera
    for (let i = 0; i < 90; i++) {
      const x = -215 + rnd() * 430;
      const lado = rnd() > 0.5 ? 1 : -1;
      const z = lado * (16 + rnd() * 34);
      const yt = yTerreno(x, z);
      const radio = 0.9 + rnd() * 1.9;
      const n = Math.floor(26 * d * radio);
      for (let j = 0; j < n; j++) {
        const th = rnd() * Math.PI * 2;
        const r = radio * Math.sqrt(rnd());
        const hh = radio * (0.9 - Math.abs(r) / (radio * 2.4)) * rnd();
        push(x + r * Math.cos(th), yt + hh, z + r * 0.7 * Math.sin(th), color(0.22, 0.4, 0.19, rnd, 0.1));
      }
      if (out.length > 42000) { yield new Float32Array(out); out.length = 0; }
    }
    yield new Float32Array(out); out.length = 0;
  }

  function mezclaColor(a, b, t) {
    return [mezcla(a[0], b[0], t), mezcla(a[1], b[1], t), mezcla(a[2], b[2], t)];
  }

  function* genPlanta(rnd, d) {
    const out = [];
    const push = (x, y, z, c) => out.push(x, y, z, c[0], c[1], c[2]);

    // placa de piso con juntas de dilatación
    for (let x = -50; x <= 50; x += 0.5 / d) {
      for (let z = -35; z <= 35; z += 0.5 / d) {
        const junta = (x % 10 === 0 && x % 1 < 0.5 / d) || (z % 10 === 0 && z % 1 < 0.5 / d);
        const c = junta ? color(0.34, 0.35, 0.37, rnd, 0.02) : color(0.56, 0.57, 0.58, rnd, 0.035);
        push(x, 0, z, c);
      }
      if (out.length > 42000) { yield new Float32Array(out); out.length = 0; }
    }
    yield new Float32Array(out); out.length = 0;

    // columnas y vigas del portico (7x5, paso 15 m)
    const nudos = [];
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < 5; j++) {
        const x = -45 + i * 15;
        const z = -30 + j * 15;
        nudos.push([x, z]);
        for (let h = 0; h <= 12; h += 0.4 / d) {
          for (let t = 0; t < Math.PI * 2; t += 0.5 / d) {
            const r = 0.4;
            push(x + r * Math.cos(t), h, z + r * Math.sin(t), color(0.33, 0.4, 0.48, rnd));
          }
        }
      }
    }
    yield new Float32Array(out); out.length = 0;

    // vigas del techo conectando columnas
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < 5; j++) {
        const x = -45 + i * 15;
        const z = -30 + j * 15;
        if (i < 6) for (let l = 0; l <= 15; l += 0.4 / d) push(x + l, 12, z, color(0.36, 0.43, 0.5, rnd));
        if (j < 4) for (let l = 0; l <= 15; l += 0.4 / d) push(x, 12, z + l, color(0.36, 0.43, 0.5, rnd));
      }
    }
    yield new Float32Array(out); out.length = 0;

    // tanques de proceso
    const tanques = [[-28, -14, 5], [-28, 2, 5], [-10, -20, 3.5]];
    for (const [tx, tz, r] of tanques) {
      const alto = 10 + r;
      for (let h = 0; h <= alto; h += 0.45 / d) {
        for (let t = 0; t < Math.PI * 2; t += 0.28 / d) {
          const junta = Math.abs(h % 2.5) < 0.3;
          const c = junta ? color(0.52, 0.54, 0.56, rnd) : color(0.72, 0.74, 0.76, rnd);
          push(tx + r * Math.cos(t), h, tz + r * Math.sin(t), c);
        }
      }
      for (let rr = 0; rr <= r; rr += 0.5 / d) {
        for (let t = 0; t < Math.PI * 2; t += 0.3 / d) {
          push(tx + rr * Math.cos(t), alto, tz + rr * Math.sin(t), color(0.66, 0.68, 0.7, rnd));
        }
      }
    }

    // rack de tuberías
    for (let fila = 0; fila < 3; fila++) {
      const y0 = 1.2 + fila * 1.1;
      const z = 24 + fila * 2.2;
      for (let tubo = 0; tubo < 5; tubo++) {
        const zt = z + (tubo - 2) * 0.75;
        const c = tubo % 2 ? color(0.8, 0.62, 0.12, rnd) : color(0.45, 0.47, 0.5, rnd);
        for (let x = -48; x <= 20; x += 0.35 / d) {
          push(x, y0, zt, c);
        }
        for (let x = 20; x <= 26; x += 0.35 / d) {
          push(x, y0 + (x - 20) * 0.55, zt, c); // codo que sube
        }
      }
      // soportes del rack
      for (let x = -46; x <= 18; x += 8) {
        for (let h = 0; h <= y0; h += 0.4 / d) push(x, h, z, color(0.3, 0.36, 0.42, rnd));
      }
    }
    yield new Float32Array(out); out.length = 0;

    // equipos: cajas, intercambiadores y escaleras
    const equipos = [
      { x: 18, z: -6, dx: 7, dy: 4, dz: 3, c: [0.82, 0.66, 0.12] },
      { x: 32, z: 6, dx: 6, dy: 5, dz: 4, c: [0.5, 0.52, 0.55] },
      { x: 38, z: -18, dx: 5, dy: 3, dz: 5, c: [0.62, 0.3, 0.16] },
    ];
    for (const e of equipos) {
      for (let x = 0; x <= e.dx; x += 0.45 / d) {
        for (let y = 0; y <= e.dy; y += 0.45 / d) {
          push(e.x + x, y, e.z, color(e.c[0], e.c[1], e.c[2], rnd));
          push(e.x + x, y, e.z + e.dz, color(e.c[0], e.c[1], e.c[2], rnd));
        }
      }
      for (let y = 0; y <= e.dy; y += 0.45 / d) {
        for (let z = 0; z <= e.dz; z += 0.45 / d) {
          push(e.x, y, e.z + z, color(e.c[0], e.c[1], e.c[2], rnd));
          push(e.x + e.dx, y, e.z + z, color(e.c[0], e.c[1], e.c[2], rnd));
        }
      }
      for (let x = 0; x <= e.dx; x += 0.45 / d) {
        for (let z = 0; z <= e.dz; z += 0.45 / d) push(e.x + x, e.dy, e.z + z, color(e.c[0], e.c[1], e.c[2], rnd));
      }
    }

    // escalera de gato hacia el segundo nivel
    for (let p = 0; p <= 7; p += 0.5 / d) {
      push(-2, p, 32, color(0.75, 0.7, 0.2, rnd));
      push(2, p, 32, color(0.75, 0.7, 0.2, rnd));
    }
    yield new Float32Array(out); out.length = 0;
  }

  function* genEdificacion(rnd, d) {
    const out = [];
    const push = (x, y, z, c) => out.push(x, y, z, c[0], c[1], c[2]);

    const W = 20, L = 12, PISO = 3, PISOS = 12;
    const ALTO = PISOS * PISO;

    // fachadas con ventanería (fotogrametría: color real)
    for (let y = 0; y <= ALTO; y += 0.32 / d) {
      const nivel = Math.floor(y / PISO);
      const dentroVentana = (y % PISO) > 0.45 && (y % PISO) < 2.62;
      for (let x = -W; x <= W; x += 0.32 / d) {
        const vano = ((x + 100) % 2.5) > 0.3 && ((x + 100) % 2.5) < 2.2;
        for (const z of [-L, L]) {
          const c = dentroVentana && vano
            ? color(0.34, 0.5, 0.64, rnd, 0.08)
            : color(0.78, 0.76, 0.72, rnd, 0.05);
          push(x, y, z, c);
        }
        if (out.length > 42000) { yield new Float32Array(out); out.length = 0; }
      }
    }
    yield new Float32Array(out); out.length = 0;

    for (let y = 0; y <= ALTO; y += 0.32 / d) {
      const nivel = Math.floor(y / PISO);
      const dentroVentana = (y % PISO) > 0.45 && (y % PISO) < 2.62;
      for (let z = -L; z <= L; z += 0.32 / d) {
        const vano = ((z + 100) % 2.5) > 0.3 && ((z + 100) % 2.5) < 2.2;
        for (const x of [-W, W]) {
          const c = dentroVentana && vano
            ? color(0.34, 0.5, 0.64, rnd, 0.08)
            : color(0.78, 0.76, 0.72, rnd, 0.05);
          push(x, y, z, c);
        }
      }
    }
    yield new Float32Array(out); out.length = 0;

    // placas de balcón cada tres pisos
    for (let nivel = 3; nivel < PISOS; nivel += 3) {
      const y = nivel * PISO;
      for (let x = -W - 1.4; x <= W + 1.4; x += 0.3 / d) {
        for (let z = -L - 1.4; z <= L + 1.4; z += 0.3 / d) {
          const borde = Math.abs(x) > W || Math.abs(z) > L;
          if (borde) push(x, y, z, color(0.82, 0.8, 0.76, rnd, 0.04));
        }
      }
    }

    // cubierta con equipos HVAC
    for (let x = -W; x <= W; x += 0.35 / d) {
      for (let z = -L; z <= L; z += 0.35 / d) push(x, ALTO + 0.2, z, color(0.42, 0.42, 0.44, rnd, 0.05));
    }
    for (const [hx, hz] of [[-10, -4], [4, 5], [12, -6]]) {
      for (let x = 0; x <= 3.4; x += 0.4 / d) {
        for (let z = 0; z <= 2.6; z += 0.4 / d) {
          for (let y = 0; y <= 1.6; y += 0.4 / d) {
            const cara = x === 0 || x >= 3.4 || z === 0 || z >= 2.6 || y === 0 || y >= 1.6;
            if (cara) push(hx + x, ALTO + 0.2 + y, hz + z, color(0.66, 0.68, 0.7, rnd));
          }
        }
      }
    }
    yield new Float32Array(out); out.length = 0;

    // plaza, andenes y arbolado
    for (let x = -34; x <= 34; x += 0.4 / d) {
      for (let z = -32; z <= 32; z += 0.4 / d) {
        if (Math.abs(x) < W + 2 && Math.abs(z) < L + 2) continue;
        const junta = Math.abs(x % 4) < 0.25 || Math.abs(z % 4) < 0.25;
        const c = junta ? color(0.66, 0.65, 0.62, rnd, 0.03) : color(0.55, 0.54, 0.51, rnd, 0.04);
        push(x, 0.05, z, c);
      }
      if (out.length > 42000) { yield new Float32Array(out); out.length = 0; }
    }
    yield new Float32Array(out); out.length = 0;

    const arboles = [[-30, -24], [-30, 20], [30, -24], [28, 22], [30, 0]];
    for (const [ax, az] of arboles) {
      for (let h = 0; h < 2.4; h += 0.3 / d) push(ax, h, az, color(0.4, 0.3, 0.2, rnd, 0.05));
      for (let i = 0; i < 380 * d; i++) {
        const th = rnd() * Math.PI * 2;
        const r = 2.6 * Math.sqrt(rnd());
        push(ax + r * Math.cos(th), 2.4 + 2.8 * rnd() - r * 0.35, az + r * Math.sin(th), color(0.28, 0.48, 0.24, rnd, 0.12));
      }
    }

    // edificaciones vecinas de contexto
    const vecinos = [
      { x: -50, z: -14, dx: 14, dy: 9, dz: 20 },
      { x: 42, z: -10, dx: 16, dy: 15, dz: 18 },
      { x: 8, z: -34, dx: 22, dy: 6, dz: 12 },
    ];
    for (const v of vecinos) {
      for (let y = 0; y <= v.dy; y += 0.5 / d) {
        for (let s = 0; s <= v.dx; s += 0.5 / d) {
          push(v.x + s, y, v.z, color(0.6, 0.58, 0.55, rnd, 0.05));
          push(v.x + s, y, v.z + v.dz, color(0.6, 0.58, 0.55, rnd, 0.05));
        }
      }
      for (let y = 0; y <= v.dy; y += 0.5 / d) {
        for (let s = 0; s <= v.dz; s += 0.5 / d) {
          push(v.x, y, v.z + s, color(0.6, 0.58, 0.55, rnd, 0.05));
          push(v.x + v.dx, y, v.z + s, color(0.6, 0.58, 0.55, rnd, 0.05));
        }
      }
    }
    yield new Float32Array(out); out.length = 0;
  }

  function* genSubestacion(rnd, d) {
    const out = [];
    const push = (x, y, z, c) => out.push(x, y, z, c[0], c[1], c[2]);

    // patio en gravilla
    for (let x = -58; x <= 58; x += 0.55 / d) {
      for (let z = -38; z <= 38; z += 0.55 / d) {
        const tono = 0.48 + rnd() * 0.14;
        push(x, 0, z, color(tono, tono * 0.97, tono * 0.9, rnd, 0.03));
      }
      if (out.length > 42000) { yield new Float32Array(out); out.length = 0; }
    }
    yield new Float32Array(out); out.length = 0;

    // torres de celosía
    function torre(cx, cz, alto) {
      const semi = (y) => mezcla(3.2, 1.0, y / alto);
      for (let h = 0; h <= alto; h += 0.4 / d) {
        const s = semi(h);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          push(cx + sx * s, h, cz + sz * s, color(0.38, 0.44, 0.52, rnd));
        }
        // cruces de riostra por panel
        const panel = Math.floor(h / 2.5);
        if ((h % 2.5) < 0.4 / d && panel % 2 === 0) {
          for (let k = 0; k <= 1; k += 0.08) {
            const s2 = semi(h);
            push(cx - s2 + 2 * s2 * k, h, cz - s2, color(0.36, 0.42, 0.5, rnd));
            push(cx + s2 - 2 * s2 * k, h, cz + s2, color(0.36, 0.42, 0.5, rnd));
          }
        }
      }
      // brazos
      for (const dir of [-1, 1]) {
        for (let b = 0; b <= 5.5; b += 0.35 / d) {
          push(cx + b * dir, alto - 0.6, cz, color(0.38, 0.44, 0.52, rnd));
          push(cx + b * dir, alto - 2.2, cz, color(0.38, 0.44, 0.52, rnd));
        }
      }
      return { cx, cz, alto };
    }

    const t1 = torre(-30, 0, 22);
    const t2 = torre(30, 0, 22);

    // cadenas de aisladores y conductores
    function catenaria(x0, y0, z0, x1, y1, z1, flecha) {
      const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / (0.3 / d));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = mezcla(x0, x1, t);
        const y = mezcla(y0, y1, t) - Math.sin(t * Math.PI) * flecha;
        const z = mezcla(z0, z1, t);
        push(x, y, z, color(0.22, 0.23, 0.26, rnd, 0.03));
      }
    }
    for (const y of [20.4, 18.8]) {
      for (const dz of [-5, 0, 5]) {
        catenaria(t1.cx + 5, y, t1.cz + dz, t2.cx - 5, y, t2.cz + dz, 2.2);
        catenaria(t1.cx - 5, y, t1.cz + dz, t1.cx - 24, 6, -14, 1.4); // bajante al patio
        catenaria(t2.cx + 5, y, t2.cz + dz, t2.cx + 22, 6, 14, 1.4);
      }
    }
    yield new Float32Array(out); out.length = 0;

    // transformadores de potencia con aletas
    for (const [tx, tz] of [[-6, -16], [10, -16]]) {
      for (let x = 0; x <= 8; x += 0.45 / d) {
        for (let y = 0.6; y <= 5; y += 0.45 / d) {
          push(tx + x, y, tz, color(0.42, 0.44, 0.35, rnd));
          push(tx + x, y, tz + 4, color(0.42, 0.44, 0.35, rnd));
        }
      }
      for (let y = 0.6; y <= 5; y += 0.45 / d) {
        for (let z = 0; z <= 4; z += 0.45 / d) {
          push(tx, y, tz + z, color(0.42, 0.44, 0.35, rnd));
          push(tx + 8, y, tz + z, color(0.42, 0.44, 0.35, rnd));
        }
      }
      // aletas de refrigeración
      for (let x = 1; x < 8; x += 0.6) {
        for (let y = 1; y <= 4.6; y += 0.35 / d) {
          push(tx + x, y, tz - 0.7, color(0.38, 0.4, 0.32, rnd));
          push(tx + x, y, tz + 4.7, color(0.38, 0.4, 0.32, rnd));
        }
      }
      // pasamuros
      for (let k = 0; k < 3; k++) {
        for (let h = 0; h <= 2.2; h += 0.25 / d) {
          const r = 0.45 - h * 0.12;
          for (let t = 0; t < Math.PI * 2; t += 0.5 / d) {
            push(tx + 4 + Math.cos(t) * r, 5 + h, tz + 2 + Math.sin(t) * r, color(0.82, 0.83, 0.85, rnd));
          }
        }
      }
    }

    // casa de control y cerco perimetral
    for (let x = 0; x <= 12; x += 0.5 / d) {
      for (let y = 0; y <= 3.4; y += 0.5 / d) {
        push(-46 + x, y, 26, color(0.72, 0.7, 0.66, rnd));
        push(-46 + x, y, 36, color(0.72, 0.7, 0.66, rnd));
      }
    }
    for (let x = -56; x <= 56; x += 0.6 / d) {
      for (let y = 0.2; y <= 2.4; y += 0.7) {
        push(x, y, -36, color(0.5, 0.55, 0.6, rnd, 0.03));
        push(x, y, 36, color(0.5, 0.55, 0.6, rnd, 0.03));
      }
    }
    yield new Float32Array(out); out.length = 0;
  }

  /* ------------------------------------------------------------ catálogo */

  const NUBES = {
    'corredor-vial': {
      nombre: 'Corredor vial de montaña',
      tecnologia: 'LiDAR aéreo · dron',
      specs: '5 km · LOD web',
      total: 96000,
      gen: genCorredorVial,
      imgFallback: '/img/vial-600.webp',
    },
    planta: {
      nombre: 'Planta de proceso',
      tecnologia: 'Escaneo láser terrestre',
      specs: '7.000 m² · LOD web',
      total: 88000,
      gen: genPlanta,
      imgFallback: '/img/planta-600.webp',
    },
    edificacion: {
      nombre: 'Edificación en obra',
      tecnologia: 'Fotogrametría',
      specs: '12 pisos · LOD web',
      total: 84000,
      gen: genEdificacion,
      imgFallback: '/img/edificacion-600.webp',
    },
    subestacion: {
      nombre: 'Subestación eléctrica',
      tecnologia: 'LiDAR móvil · SLAM',
      specs: '4,5 ha · LOD web',
      total: 92000,
      gen: genSubestacion,
      imgFallback: '/img/subestacion-600.webp',
    },
  };

  /* --------------------------------------------------------- matemática 3D */

  function perspectiva(fovY, aspecto, cerca, lejos) {
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (cerca - lejos);
    return new Float32Array([
      f / aspecto, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (lejos + cerca) * nf, -1,
      0, 0, 2 * lejos * cerca * nf, 0,
    ]);
  }

  function mirarA(desde, hacia, arriba) {
    // Eje Z del ojo hacia el objetivo (OpenGL mira hacia -Z: sin este
    // signo la escena completa queda detrás de la cámara y se recorta).
    const [fx, fy, fz] = [desde[0] - hacia[0], desde[1] - hacia[1], desde[2] - hacia[2]];
    let len = Math.hypot(fx, fy, fz) || 1;
    const zx = fx / len, zy = fy / len, zz = fz / len;
    const xx = arriba[1] * zz - arriba[2] * zy;
    const xy = arriba[2] * zx - arriba[0] * zz;
    const xz = arriba[0] * zy - arriba[1] * zx;
    len = Math.hypot(xx, xy, xz) || 1;
    const ux = xx / len, uy = xy / len, uz = xz / len;
    const yx = zy * uz - zz * uy;
    const yy = zz * ux - zx * uz;
    const yz = zx * uy - zy * ux;
    return new Float32Array([
      ux, yx, zx, 0,
      uy, yy, zy, 0,
      uz, yz, zz, 0,
      -(ux * desde[0] + uy * desde[1] + uz * desde[2]),
      -(yx * desde[0] + yy * desde[1] + yz * desde[2]),
      -(zx * desde[0] + zy * desde[1] + zz * desde[2]),
      1,
    ]);
  }

  function multiplicar(a, b) {
    const out = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
        out[i * 4 + j] = s;
      }
    }
    return out;
  }

  /* --------------------------------------------------------------- shaders */

  const VERT = [
    'attribute vec3 aPos;',
    'attribute vec3 aCol;',
    'uniform mat4 uVP;',
    'uniform float uTam;',
    'uniform float uDpr;',
    'varying vec3 vCol;',
    'void main() {',
    '  gl_Position = uVP * vec4(aPos, 1.0);',
    '  gl_PointSize = clamp(uTam * uDpr / gl_Position.w, 1.0, 9.0);',
    '  vCol = aCol;',
    '}',
  ].join('\n');

  const FRAG = [
    'precision mediump float;',
    'varying vec3 vCol;',
    'void main() {',
    '  vec2 c = gl_PointCoord - vec2(0.5);',
    '  if (dot(c, c) > 0.25) discard;',
    '  gl_FragColor = vec4(vCol, 1.0);',
    '}',
  ].join('\n');

  /* ---------------------------------------------------------------- visor */

  const visor = {
    gl: null,
    programa: null,
    buffer: null,
    puntos: 0,
    capacidad: 0,
    radio: 1,
    cam: { yaw: 0.7, pitch: 0.42, dist: 2, objetivo: [0, 0, 0] },
    autoGirar: true,
    abierto: false,
    raf: 0,
    nubeActual: null,
  };

  function compilar(gl, tipo, fuente) {
    const s = gl.createShader(tipo);
    gl.shaderSource(s, fuente);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function iniciarGl(canvas) {
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false });
    if (!gl) return null;
    const programa = gl.createProgram();
    gl.attachShader(programa, compilar(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(programa, compilar(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(programa);
    if (!gl.getProgramParameter(programa, gl.LINK_STATUS)) return null;
    gl.useProgram(programa);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.016, 0.063, 0.118, 1);

    visor.gl = gl;
    visor.programa = programa;
    visor.buffer = gl.createBuffer();
    visor.uVP = gl.getUniformLocation(programa, 'uVP');
    visor.uTam = gl.getUniformLocation(programa, 'uTam');
    visor.uDpr = gl.getUniformLocation(programa, 'uDpr');
    visor.aPos = gl.getAttribLocation(programa, 'aPos');
    visor.aCol = gl.getAttribLocation(programa, 'aCol');
    // Los atributos quedan amarrados a este buffer para siempre: la carga
    // por bloques solo reemplaza su contenido con bufferData.
    gl.bindBuffer(gl.ARRAY_BUFFER, visor.buffer);
    gl.enableVertexAttribArray(visor.aPos);
    gl.vertexAttribPointer(visor.aPos, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(visor.aCol);
    gl.vertexAttribPointer(visor.aCol, 3, gl.FLOAT, false, 24, 12);
    return gl;
  }

  function dimensionar() {
    const canvas = visor.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return dpr;
  }

  function encuadrar(nubeId) {
    // límites aproximados de cada escena para posicionar la cámara
    const limites = {
      'corredor-vial': { r: 230, c: [0, 6, 0] },
      planta: { r: 62, c: [0, 6, 0] },
      edificacion: { r: 42, c: [0, 18, 0] },
      subestacion: { r: 64, c: [0, 10, 0] },
    };
    const l = limites[nubeId] || { r: 50, c: [0, 0, 0] };
    visor.radio = l.r;
    visor.cam = { yaw: 0.7, pitch: 0.4, dist: l.r * 2.35, objetivo: l.c };
  }

  function dibujar() {
    if (!visor.abierto) return;
    const gl = visor.gl;
    const dpr = dimensionar();
    gl.viewport(0, 0, visor.canvas.width, visor.canvas.height);

    if (visor.autoGirar && !document.hidden) visor.cam.yaw += 0.0022;

    const cam = visor.cam;
    const pos = [
      cam.objetivo[0] + cam.dist * Math.cos(cam.pitch) * Math.sin(cam.yaw),
      cam.objetivo[1] + cam.dist * Math.sin(cam.pitch),
      cam.objetivo[2] + cam.dist * Math.cos(cam.pitch) * Math.cos(cam.yaw),
    ];
    const proj = perspectiva(0.9, visor.canvas.width / visor.canvas.height, visor.radio * 0.02, visor.radio * 12);
    const vista = mirarA(pos, cam.objetivo, [0, 1, 0]);
    gl.uniformMatrix4fv(visor.uVP, false, multiplicar(proj, vista));
    gl.uniform1f(visor.uTam, visor.radio * 4.2);
    gl.uniform1f(visor.uDpr, dpr);

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (visor.puntos > 0) gl.drawArrays(gl.POINTS, 0, visor.puntos);
    visor.raf = requestAnimationFrame(dibujar);
  }

  /* Carga progresiva: un bloque por paso, la barra refleja el avance.
     La nube completa se mantiene también en CPU y se resube entera por
     bloque (≤3 MB): WebGL 1 no ofrece bufferSubData de lectura y así el
     visor funciona igual en móviles antiguos. */
  function cargarNube(id) {
    const nube = NUBES[id];
    const gl = visor.gl;
    visor.puntos = 0;

    const movil = window.matchMedia('(max-width: 860px)').matches
      || (navigator.hardwareConcurrency || 8) <= 4;
    const dens = movil ? 0.55 : 1;
    const rnd = mulberry32(20261020);
    const iter = nube.gen(rnd, dens);
    const cargando = document.getElementById('visorCargando');
    const barra = document.getElementById('visorProgreso');
    const estado = document.getElementById('visorEstado');
    cargando.style.opacity = '1';
    cargando.style.display = 'flex';

    function paso() {
      const { value, done } = iter.next();
      if (done) {
        barra.style.width = '100%';
        estado.textContent = 'Nube lista · ' + visor.puntos.toLocaleString('es-CO') + ' puntos';
        setTimeout(() => {
          cargando.style.opacity = '0';
          setTimeout(() => { cargando.style.display = 'none'; }, 420);
        }, 380);
        return;
      }
      if (value && value.length) {
        const antes = visor.acumulado;
        const nuevo = new Float32Array(antes.length + value.length);
        nuevo.set(antes);
        nuevo.set(value, antes.length);
        visor.acumulado = nuevo;
        visor.puntos = nuevo.length / 6;
        gl.bindBuffer(gl.ARRAY_BUFFER, visor.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, nuevo, gl.DYNAMIC_DRAW);
      }
      const avance = Math.min(0.99, visor.puntos / nube.total);
      barra.style.width = (avance * 100).toFixed(1) + '%';
      estado.textContent = 'Cargando nube de puntos… ' + Math.round(avance * 100) + '%';
      setTimeout(paso, 24);
    }
    visor.acumulado = new Float32Array(0);
    paso();
  }

  /* ------------------------------------------------------------ interfaz */

  function abrir(id) {
    const nube = NUBES[id];
    if (!nube) return;
    visor.nubeActual = id;

    document.getElementById('visorTitulo').textContent = nube.nombre;
    document.getElementById('visorSub').textContent = nube.tecnologia + ' · ' + nube.specs;
    document.getElementById('visorFallo').style.display = 'none';

    const el = document.getElementById('visor');
    el.classList.add('visor--abierto');
    el.removeAttribute('hidden');
    visor.abierto = true;
    document.body.style.overflow = 'hidden';

    if (!visor.gl) {
      visor.canvas = document.getElementById('visorCanvas');
      if (!iniciarGl(visor.canvas)) {
        const fallo = document.getElementById('visorFallo');
        document.getElementById('visorFalloImg').src = nube.imgFallback || '';
        fallo.style.display = 'flex';
        document.getElementById('visorCargando').style.display = 'none';
        return;
      }
      enlazarControles();
      visor.canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        cerrar();
      });
    }

    encuadrar(id);
    cargarNube(id);
    cancelAnimationFrame(visor.raf);
    dibujar();
    if (window.haztekTrack) window.haztekTrack('nube_abierta', { proyecto: id });
  }

  function cerrar() {
    visor.abierto = false;
    cancelAnimationFrame(visor.raf);
    const el = document.getElementById('visor');
    el.classList.remove('visor--abierto');
    el.setAttribute('hidden', '');
    document.body.style.overflow = '';
  }

  function enlazarControles() {
    const canvas = visor.canvas;
    const punteros = new Map();
    let previo = null;
    let ultimaDistancia = 0;

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      punteros.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (punteros.size === 1) previo = { x: e.clientX, y: e.clientY };
      visor.autoGirar = false;
      actualizarBotonGirar();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!punteros.has(e.pointerId)) return;
      punteros.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (punteros.size === 1 && previo) {
        const dx = e.clientX - previo.x;
        const dy = e.clientY - previo.y;
        previo = { x: e.clientX, y: e.clientY };
        visor.cam.yaw -= dx * 0.0052;
        visor.cam.pitch = Math.min(1.45, Math.max(-0.5, visor.cam.pitch + dy * 0.0052));
      } else if (punteros.size === 2) {
        const [p1, p2] = [...punteros.values()];
        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        if (ultimaDistancia) {
          const factor = ultimaDistancia / dist;
          visor.cam.dist = Math.min(visor.radio * 5, Math.max(visor.radio * 0.35, visor.cam.dist * factor));
        }
        ultimaDistancia = dist;
      }
    });

    const soltar = (e) => {
      punteros.delete(e.pointerId);
      if (punteros.size < 2) ultimaDistancia = 0;
      if (punteros.size === 1) {
        const [p] = [...punteros.values()];
        previo = p;
      }
    };
    canvas.addEventListener('pointerup', soltar);
    canvas.addEventListener('pointercancel', soltar);

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      visor.autoGirar = false;
      const factor = 1 + Math.sign(e.deltaY) * 0.09;
      visor.cam.dist = Math.min(visor.radio * 5, Math.max(visor.radio * 0.35, visor.cam.dist * factor));
    }, { passive: false });

    canvas.addEventListener('dblclick', () => {
      encuadrar(visor.nubeActual);
    });
  }

  function actualizarBotonGirar() {
    const btn = document.getElementById('visorGirar');
    if (btn) btn.setAttribute('aria-pressed', String(visor.autoGirar));
  }

  document.getElementById('visorCerrar').addEventListener('click', cerrar);
  document.getElementById('visorReiniciar').addEventListener('click', () => encuadrar(visor.nubeActual));
  document.getElementById('visorGirar').addEventListener('click', () => {
    visor.autoGirar = !visor.autoGirar;
    actualizarBotonGirar();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && visor.abierto) cerrar();
  });

  document.querySelectorAll('[data-nube]').forEach((elem) => {
    elem.addEventListener('click', () => abrir(elem.getAttribute('data-nube')));
  });

  window.HaztekVisor = { abrir, cerrar };
})();
