'use strict';
// Migración única: agrega las columnas de auditoría (createdby, createdon,
// modifiedby, modifiedon) a las tres tablas del CRM.
// - creadoEl/actualizadoEl pasan a llamarse createdon/modifiedon
// - createdby/modifiedby: 'importacion' si la fila trae archivoOrigen/origen, '' si no
// Uso: node migrar-auditoria.js <dir_crm>
const fs = require('node:fs');
const path = require('node:path');

const dir = process.argv[2];
if (!dir) {
  console.error('falta el directorio del CRM');
  process.exit(1);
}

const respaldo = path.join(dir, 'respaldo-auditoria-20261017');
fs.mkdirSync(respaldo, { recursive: true });

for (const nombre of ['clientes.json', 'contactos.json', 'notas.json']) {
  const ruta = path.join(dir, nombre);
  if (!fs.existsSync(ruta)) {
    console.log(`${nombre}: no existe, se salta`);
    continue;
  }
  fs.copyFileSync(ruta, path.join(respaldo, nombre));
  const filas = JSON.parse(fs.readFileSync(ruta, 'utf8'));
  let renombradas = 0;
  for (const f of filas) {
    const viejoCreado = f.creadoEl;
    const viejoAct = f.actualizadoEl;
    if (!f.createdon) f.createdon = viejoCreado || '';
    if (!f.modifiedon) f.modifiedon = viejoAct || f.createdon || '';
    if (f.createdby === undefined) {
      f.createdby = (f.archivoOrigen || f.origen) ? 'importacion' : '';
    }
    if (f.modifiedby === undefined) f.modifiedby = f.createdby;
    delete f.creadoEl;
    delete f.actualizadoEl;
    if (viejoCreado || viejoAct) renombradas += 1;
  }
  const tmp = ruta + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(filas, null, 1), 'utf8');
  fs.renameSync(tmp, ruta);
  console.log(`${nombre}: ${filas.length} filas, ${renombradas} renombradas`);
}
console.log(`respaldo en ${respaldo}`);
