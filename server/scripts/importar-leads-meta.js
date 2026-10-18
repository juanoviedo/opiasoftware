'use strict';

// Importa de inmediato los leads de Meta al CRM (backfill o disparo manual).
// Uso local:            node server/scripts/importar-leads-meta.js
// En el servidor:       docker exec opiasoftware-home-app-1 node server/scripts/importar-leads-meta.js

const metaleads = require('../lib/metaleads');

if (!metaleads.configurado()) {
  console.error('No hay server/data/meta-config.json (o server/meta-config.json) con app_id, app_secret y access_token.');
  process.exit(1);
}

metaleads
  .importarCiclo()
  .then((r) => {
    if (!r.ok) {
      console.error('No se importaron leads:', r.razon);
      process.exit(1);
    }
    for (const o of r.omitidos || []) console.error(`  omitido ${o.lead}: ${o.razon}`);
    console.log(`Listo: ${r.nuevos} lead(s) nuevo(s) en el CRM (${r.formularios} formulario(s) revisados).`);
  })
  .catch((e) => {
    console.error('Error:', e.message);
    process.exit(1);
  });
