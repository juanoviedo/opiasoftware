'use strict';

/**
 * Define la contraseña del panel /opadmin.
 * Uso: node server/scripts/set-password.js [--user nombre]
 */

const readline = require('node:readline');
const auth = require('../lib/auth');
const config = require('../lib/config');

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(question);

    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
      return;
    }

    let value = '';
    stdin.setRawMode(true);
    stdin.resume();

    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      resolve(value);
    };

    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (ch.charCodeAt(0) < 32) continue;
        value += ch;
      }
    };

    stdin.on('data', onData);
    stdin.once('error', reject);
  });
}

function readArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const user = readArg('user') || process.env.OPIA_ADMIN_USER || config.adminUser;
  let password = readArg('password') || process.env.OPIA_ADMIN_PASSWORD || '';

  if (!password) {
    password = await promptHidden(`Contraseña para "${user}" (mínimo 10 caracteres): `);
    const again = await promptHidden('Repítela: ');
    if (password !== again) {
      console.error('Las contraseñas no coinciden.');
      process.exit(1);
    }
  }

  if (String(password).length < 10) {
    console.error('La contraseña debe tener al menos 10 caracteres.');
    process.exit(1);
  }

  auth.saveAdmin(user, auth.hashPassword(password));
  console.log(`\nListo. Panel: /opadmin  Usuario: ${user}`);
  console.log(`Archivo: ${config.adminFile}`);
  console.log('Ese directorio está fuera de git: no hay copia en el repositorio.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
