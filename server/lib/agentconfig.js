'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const RUTA = path.join(config.dataDir, 'agent-config.json');
// Límites de la lista interactiva de WhatsApp: título ≤24 y descripción ≤72.
// El nombre editable del botón usa el título; la especificación, la descripción.
const MAX_ETIQUETA = 24;
const MAX_ESPECIFICACION = 72;

// menú fijo del agente: el dueño decide en /crm/agentconfig cuáles se muestran,
// en qué orden y con qué texto y especificación en el botón. Lo editable son
// la etiqueta y la especificación; el id mantiene la funcionalidad aunque cambie
// el nombre.
const FUNCIONES = [
  {
    id: 'conocer',
    nombre: 'Conocer más sobre OPIA',
    etiqueta: '🏢 Conocer OPIA',
    descripcion: 'Presenta a OPIA Software y lo que hace.',
  },
  {
    id: 'software',
    nombre: 'Levantamiento de necesidades de Software',
    etiqueta: '💻 Necesito software',
    descripcion: 'Tres preguntas para dar dirección inicial a un proyecto de software.',
  },
  {
    id: 'marketing',
    nombre: 'Levantamiento de necesidades de Marketing',
    etiqueta: '📣 Necesito marketing',
    descripcion: 'Tres preguntas para dar dirección inicial a una estrategia de marketing.',
  },
  {
    id: 'datos',
    nombre: 'Registrar mis datos',
    etiqueta: '📝 Registrar mis datos',
    descripcion: 'Nombre, empresa, correo o celular y cantidad de empleados.',
  },
  {
    id: 'humano',
    nombre: 'Hablar con un humano por WhatsApp',
    etiqueta: '💬 Hablar con un humano',
    descripcion: 'Comparte el WhatsApp del equipo para atención humana.',
  },
];

function definicion(id) {
  return FUNCIONES.find((f) => f.id === id);
}

function limpiar(valor) {
  return String(valor == null ? '' : valor).replace(/\s+/g, ' ').trim();
}

/** Etiqueta válida para el canal, o la de fábrica si la guardada no sirve. */
function etiquetaSegura(valor, porDefecto) {
  const t = limpiar(valor);
  if (t.length < 2 || t.length > MAX_ETIQUETA || t.includes('|')) return porDefecto;
  return t;
}

/** Texto que WhatsApp muestra bajo el nombre en la lista ('' = sin texto). */
function especificacionSegura(valor, porDefecto) {
  if (valor == null) return porDefecto;
  return limpiar(valor).slice(0, MAX_ESPECIFICACION);
}

/** Config guardada, normalizada: ids conocidos, sin repetidos y orden 1..n. */
function leer() {
  let crudo = null;
  try {
    crudo = JSON.parse(fs.readFileSync(RUTA, 'utf8'));
  } catch {
    // sin archivo todavía: todo activo en el orden por defecto
  }
  const filas = crudo && Array.isArray(crudo.funciones) ? crudo.funciones : [];
  const guardadas = new Map();
  for (const fila of filas) {
    if (!fila || !definicion(fila.id)) continue;
    const orden = Number(fila.orden);
    guardadas.set(fila.id, {
      id: fila.id,
      activa: fila.activa !== false,
      orden: Number.isFinite(orden) ? orden : Number.MAX_SAFE_INTEGER,
      etiqueta: etiquetaSegura(fila.etiqueta, definicion(fila.id).etiqueta),
      especificacion: especificacionSegura(fila.especificacion, definicion(fila.id).descripcion),
    });
  }
  const lista = FUNCIONES.map((f, i) => {
    const g = guardadas.get(f.id);
    return g || {
      id: f.id,
      activa: true,
      orden: 1000 + i,
      etiqueta: f.etiqueta,
      especificacion: f.descripcion,
    };
  });
  lista.sort((a, b) => a.orden - b.orden);
  return lista.map((f, i) => ({
    id: f.id,
    activa: f.activa !== false,
    orden: i + 1,
    etiqueta: etiquetaSegura(f.etiqueta, definicion(f.id).etiqueta),
    especificacion: especificacionSegura(f.especificacion, definicion(f.id).descripcion),
  }));
}

/** Lo que ve el CRM: definición completa + estado, orden, botón y especificación. */
function listar() {
  return leer().map((fila) => {
    const def = definicion(fila.id);
    return {
      ...def,
      etiqueta: fila.etiqueta,
      especificacion: fila.especificacion,
      activa: fila.activa,
      orden: fila.orden,
    };
  });
}

function activas() {
  return listar().filter((f) => f.activa);
}

/** Etiquetas de los botones, en el orden configurado. */
function menuOpciones() {
  return activas().map((f) => f.etiqueta);
}

/** Guarda orden, interruptores, nombres y especificaciones. Devuelve { funciones } o { error }. */
function guardar(filas) {
  if (!Array.isArray(filas)) return { error: 'Formato de configuración inválido.' };
  const actuales = new Map(leer().map((f) => [f.id, f]));
  const vistos = new Set();
  const usadas = new Set();
  const limpias = [];
  for (const fila of filas) {
    const id = String((fila && fila.id) || '');
    const def = definicion(id);
    if (!def) return { error: `Función desconocida: ${id || '(sin id)'}.` };
    if (vistos.has(id)) return { error: `Función repetida: ${id}.` };
    vistos.add(id);
    const etiqueta = limpiar(fila.etiqueta == null ? def.etiqueta : fila.etiqueta);
    if (etiqueta.length < 2) return { error: `El nombre del botón de «${def.nombre}» está vacío.` };
    if (etiqueta.length > MAX_ETIQUETA) {
      return { error: `El nombre del botón de «${def.nombre}» supera los ${MAX_ETIQUETA} caracteres.` };
    }
    if (etiqueta.includes('|')) return { error: 'El nombre del botón no puede llevar «|».' };
    const llave = etiqueta.toLowerCase();
    if (usadas.has(llave)) return { error: 'Dos funciones no pueden tener el mismo nombre de botón.' };
    usadas.add(llave);
    const previa = actuales.get(id);
    const especificacion = limpiar(
      fila.especificacion == null
        ? (previa ? previa.especificacion : def.descripcion)
        : fila.especificacion
    );
    if (especificacion.length > MAX_ESPECIFICACION) {
      return {
        error: `La especificación de «${def.nombre}» supera los ${MAX_ESPECIFICACION} caracteres.`,
      };
    }
    limpias.push({ id, activa: fila.activa !== false, orden: limpias.length + 1, etiqueta, especificacion });
  }
  if (limpias.length !== FUNCIONES.length) return { error: 'Faltan funciones en la configuración.' };
  fs.mkdirSync(path.dirname(RUTA), { recursive: true });
  const tmp = RUTA + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ funciones: limpias }, null, 2));
  fs.renameSync(tmp, RUTA);
  return { funciones: listar() };
}

/**
 * El modelo cierra sus mensajes con [MENU] y el sistema pone las etiquetas
 * vigentes: así el orden, los apagados y los nombres editados se respetan
 * sin depender del modelo.
 */
function expandirMenu(texto) {
  const crudo = String(texto || '');
  if (!/\[MENU\]/i.test(crudo)) return crudo;
  const opciones = menuOpciones();
  const limpio = crudo.replace(/\[MENU\]/gi, '').trim();
  return opciones.length >= 2 ? `${limpio}\n[OPCIONES] ${opciones.join(' | ')}` : limpio;
}

module.exports = {
  FUNCIONES,
  MAX_ETIQUETA,
  MAX_ESPECIFICACION,
  listar,
  activas,
  menuOpciones,
  guardar,
  expandirMenu,
};
