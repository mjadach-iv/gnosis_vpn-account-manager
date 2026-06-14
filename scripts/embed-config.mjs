// Build-time helper: read a .env file and print the packed, base64 embedded
// config payload to stdout. build.sh injects this into the bundle via esbuild's
// --define. The MySQL creds are encrypted with ENCRYPTION_KEY; the key is
// XOR-obfuscated (see src/embed.js — this is obfuscation, not security).
//
// Usage: node scripts/embed-config.mjs [path-to-.env]   (default: ./.env)

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { packEmbedded } from '../src/embed.js';

const envPath = path.resolve(process.argv[2] || '.env');

if (!fs.existsSync(envPath)) {
  console.error(`embed-config: .env not found at ${envPath}`);
  process.exit(1);
}

const parsed = dotenv.parse(fs.readFileSync(envPath));

const REQUIRED = ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE', 'ENCRYPTION_KEY'];
const missing = REQUIRED.filter((k) => !parsed[k]);
if (missing.length) {
  console.error(`embed-config: missing required var(s) in ${envPath}: ${missing.join(', ')}`);
  process.exit(1);
}

const payload = packEmbedded({
  mysql: {
    host: parsed.MYSQL_HOST,
    user: parsed.MYSQL_USER,
    password: parsed.MYSQL_PASSWORD,
    database: parsed.MYSQL_DATABASE,
  },
  encryptionKey: parsed.ENCRYPTION_KEY,
});

process.stdout.write(payload);
