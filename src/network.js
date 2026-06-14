// Detect which network the client is configured for by finding
// GNOSISVPN_HOPR_BLOKLI_URL in the service definition or environment.
//
// Returns { network: 'jura'|'rotsee'|null, blokliUrl: string|null }.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { ENV } from './paths.js';

const execFileAsync = promisify(execFile);

// Map a blokli URL to a known network by substring.
export function networkFromUrl(url) {
  if (!url) return null;
  const u = url.toLowerCase();
  if (u.includes('rotsee')) return 'rotsee';
  if (u.includes('jura')) return 'jura';
  return null;
}

// Pull the URL out of a `KEY=value` blob (systemd unit, env file, plist).
function extractUrl(text) {
  if (!text) return null;
  // KEY=value or KEY="value" (env files / systemd Environment= lines)
  const kv = text.match(new RegExp(`${ENV.blokliUrl}\\s*=\\s*"?([^"\\s]+)"?`));
  if (kv) return kv[1];
  // plist: <key>GNOSISVPN_HOPR_BLOKLI_URL</key><string>...</string>
  const plist = text.match(
    new RegExp(`<key>${ENV.blokliUrl}</key>\\s*<string>([^<]+)</string>`, 'i'),
  );
  if (plist) return plist[1];
  return null;
}

async function tryRead(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function tryExec(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 10_000 });
    return stdout;
  } catch {
    return null;
  }
}

// Detect the blokli URL + network for the given service name.
export async function detectNetwork({ serviceName, platform = process.platform } = {}) {
  // 0. Our own process env (useful in dev / when launched by the service).
  let url = process.env[ENV.blokliUrl] || null;

  if (!url && platform === 'linux') {
    // 1. systemd unit definition.
    const unit = serviceName || 'gnosisvpn';
    url = extractUrl(await tryExec('systemctl', ['cat', unit]));
    // 2. Common env-file drop-ins.
    if (!url) {
      for (const f of ['/etc/gnosisvpn/gnosisvpn.env', '/etc/default/gnosisvpn']) {
        url = extractUrl(await tryRead(f));
        if (url) break;
      }
    }
  }

  if (!url && platform === 'darwin') {
    // launchd plist.
    for (const f of [
      '/Library/LaunchDaemons/com.gnosisvpn.gnosisvpnclient.plist',
      '/Library/LaunchDaemons/com.gnosisvpn.plist',
    ]) {
      url = extractUrl(await tryRead(f));
      if (url) break;
    }
  }

  return { network: networkFromUrl(url), blokliUrl: url };
}
