'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const RUTA = path.join(config.dataDir, 'agent-config.json');
// WhatsApp corta los títulos de una lista en 24 caracteres: el mismo límite
// aplica al nombre editable del botón
const MAX_ETIQUETA = 24;

// menú fijo del agente: el dueño decide en /crm/agentconfig cuáles se muestran,
// en qué orden y con qué texto en el botón. La etiqueta es lo único editable;
// el id mantiene la funcionalidad aunque el nombre cambie.
const FUNCIONES = [
  {
    id: 'conocer',
    nombre: 'Conocer más sobre OPIA',
    etiqueta: 'Conocer OPIA',
    descripcion: 'Presenta a OPIA Software y lo que hace.',
  },
  {
    id: 'software',
    nombre: 'Levantamiento de necesidades de Software',
    etiqueta: 'Necesito software',
    descripcion: 'Tres preguntas para dar dirección inicial a un proyecto de software.',
  },
  {
    id: 'marketing',
    nombre: 'Levantamiento de necesidades de Marketing',
    etiqueta: 'Necesito marketing',
    descripcion: 'Tres preguntas para dar dirección inicial a una estrategia de marketing.',
  },
  {
    id: 'datos',
    nombre: 'Registrar mis datos',
    etiqueta: 'Registrar mis datos',
    descripcion: 'Nombre, empresa, correo o celular y cantidad de empleados.',
  },
  {
    id: 'humano',
    nombre: 'Hablar con un humano por WhatsApp',
    etiqueta: 'Hablar con un humano',
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
    });
  }
  const lista = FUNCIONES.map((f, i) => {
    const g = guardadas.get(f.id);
    return g || { id: f.id, activa: true, orden: 1000 + i, etiqueta: f.etiqueta };
  });
  lista.sort((a, b) => a.orden - b.orden);
  return lista.map((f, i) => ({
    id: f.id,
    activa: f.activa !== false,
    orden: i + 1,
    etiqueta: etiquetaSegura(f.etiqueta, definicion(f.id).etiqueta),
  }));
}

/** Lo que ve el CRM: definición completa + estado, orden y texto del botón. */
function listar() {
  return leer().map((fila) => {
    const def = definicion(fila.id);
    return { ...def, etiqueta: fila.etiqueta, activa: fila.activa, orden: fila.orden };
  });
}

function activas() {
  return listar().filter((f) => f.activa);
}

/** Etiquetas de los botones, en el orden configurado. */
function menuOpciones() {
  return activas().map((f) => f.etiqueta);
}

/** Guarda orden, interruptores y nombres de botón. Devuelve { funciones } o { error }. */
function guardar(filas) {
  if (!Array.isArray(filas)) return { error: 'Formato de configuración inválido.' };
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
    limpias.push({ id, activa: fila.activa !== false, orden: limpias.length + 1, etiqueta });
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

module.exports = { FUNCIONES, MAX_ETIQUETA, listar, activas, menuOpciones, guardar, expandirMenu };
