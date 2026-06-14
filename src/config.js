// Load the .env file and expose resolved configuration (MySQL creds, encryption
// key, and the per-OS account file paths).

import path from 'node:path';
import dotenv from 'dotenv';
import { resolveFiles, resolveHome, configDir } from './paths.js';
import { unpackEmbedded } from './embed.js';

const REQUIRED = ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE', 'ENCRYPTION_KEY'];

// Config baked into the binary at build time. esbuild's `--define` replaces the
// `__EMBEDDED_CONFIG__` token with a base64 string literal when building a
// binary; when running from source the token is undeclared, so `typeof` yields
// 'undefined' and we fall back to reading a .env file.
// eslint-disable-next-line no-undef
const EMBEDDED = typeof __EMBEDDED_CONFIG__ !== 'undefined' ? __EMBEDDED_CONFIG__ : null;

function paths() {
  return { home: resolveHome(), configDir: configDir(), files: resolveFiles() };
}

// Load config. If config was baked into the binary, it is used exclusively and
// any .env is ignored. Otherwise the given .env path (default: ./.env) is read.
export function loadConfig({ envPath } = {}) {
  if (EMBEDDED) {
    const { mysql, encryptionKey } = unpackEmbedded(EMBEDDED);
    return Object.freeze({ envPath: '(embedded)', mysql, encryptionKey, ...paths() });
  }
  return loadFromEnvFile(envPath);
}

function loadFromEnvFile(envPath) {
  const resolved = path.resolve(envPath || '.env');
  const result = dotenv.config({ path: resolved });
  if (result.error && envPath) {
    // Only hard-fail when the user explicitly pointed us at a missing file.
    throw new Error(`Could not read --env file: ${resolved}`);
  }

  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing required env var(s): ${missing.join(', ')}. ` +
        `Set them in ${resolved} (see .env.example).`,
    );
  }

  return Object.freeze({
    envPath: resolved,
    mysql: {
      host: process.env.MYSQL_HOST,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
    },
    encryptionKey: process.env.ENCRYPTION_KEY,
    ...paths(),
  });
}
