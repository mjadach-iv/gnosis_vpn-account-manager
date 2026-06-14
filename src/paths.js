// Per-OS defaults, on-disk filenames, and the env-var names that override them.

import path from 'node:path';

// The three account files the Gnosis VPN client keeps under $GNOSISVPN_HOME/.config/.
export const FILES = {
  id: 'gnosisvpn-hopr.id', // encrypted HOPR identity
  pass: 'gnosisvpn-hopr.pass', // 48-char identity password (plaintext)
  safe: 'gnosisvpn-hopr.safe', // YAML: safe_address + module_address
};

// Env vars the client (and we) honour.
export const ENV = {
  home: 'GNOSISVPN_HOME',
  identityFile: 'GNOSISVPN_HOPR_IDENTITY_FILE',
  blokliUrl: 'GNOSISVPN_HOPR_BLOKLI_URL',
};

// Default $GNOSISVPN_HOME per platform.
export function defaultHome(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/GnosisVPN';
  return '/var/lib/gnosisvpn'; // linux + everything else
}

// Resolve $GNOSISVPN_HOME, honouring the env override.
export function resolveHome(env = process.env, platform = process.platform) {
  return env[ENV.home] || defaultHome(platform);
}

// The .config directory holding the account files.
export function configDir(env = process.env, platform = process.platform) {
  return path.join(resolveHome(env, platform), '.config');
}

// Resolve the absolute paths of the three account files.
// GNOSISVPN_HOPR_IDENTITY_FILE, if set, pins the .id location and the .pass/.safe
// siblings are derived from it.
export function resolveFiles(env = process.env, platform = process.platform) {
  const idOverride = env[ENV.identityFile];
  if (idOverride) {
    const dir = path.dirname(idOverride);
    const base = path.basename(idOverride);
    // Swap the .id suffix for .pass / .safe if it matches the known name,
    // otherwise fall back to the standard sibling filenames.
    const stem = base.endsWith('.id') ? base.slice(0, -3) : null;
    return {
      id: idOverride,
      pass: path.join(dir, stem ? `${stem}.pass` : FILES.pass),
      safe: path.join(dir, stem ? `${stem}.safe` : FILES.safe),
    };
  }
  const dir = configDir(env, platform);
  return {
    id: path.join(dir, FILES.id),
    pass: path.join(dir, FILES.pass),
    safe: path.join(dir, FILES.safe),
  };
}
