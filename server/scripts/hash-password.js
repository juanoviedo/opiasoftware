'use strict';

/**
 * Genera las variables de entorno del panel /opadmin para Vercel.
 *
 *   node server/scripts/hash-password.js
 *
 * Pide la contraseña dos veces y devuelve:
 *   OPIA_ADMIN_HASH       (hash scrypt para verificar el login)
 *   OPIA_SESSION_SECRET   (secreto que firma la cookie de sesión)
 *
 * Ambas se pegan en Vercel > Project Settings > Environment Variables.
 * La contraseña en claro no se guarda en ningún lado.
 */

const crypto = require('node:crypto');
const readline = require('node:readline');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

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

async function main() {
  const a = await promptHidden('Contraseña del panel: ');
  const b = await promptHidden('Repite la contraseña:      ');
  if (!a || a.length < 8) {
    console.error('\n✖ Mínimo 8 caracteres.');
    process.exit(1);
  }
  if (a !== b) {
    console.error('\n✖ No coinciden.');
    process.exit(1);
  }

  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(a, salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  });
  const hash = `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${derived.toString('hex')}`;
  const secret = crypto.randomBytes(32).toString('hex');

  console.log('\nPega estos dos valores en Vercel > Project Settings > Environment Variables:\n');
  console.log(`OPIA_ADMIN_HASH=${hash}`);
  console.log(`OPIA_SESSION_SECRET=${secret}`);
  console.log('\n(Y opcionalmente OPIA_ADMIN_USER si no quieres el usuario por defecto "opia".)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
