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

// The client's system config directory (same path on linux and macOS). The
// installer symlinks config.toml to the selected network's config:
// config-<network>.toml on linux, <network>.toml on macOS.
// The GNOSISVPN_ETC override exists for testing and non-standard installs.
export const SERVICE_CONFIG_DIR = process.env.GNOSISVPN_ETC || '/etc/gnosisvpn';
export const SERVICE_CONFIG_LINK = `${SERVICE_CONFIG_DIR}/config.toml`;

// linux: the env file the installer generates to carry the Blokli endpoint.
// (gnosisvpn.env next to it is a dpkg conffile whose value is kept empty — the
// installer re-empties it on every run, so we must never write to it.)
export const DYNAMIC_ENV_FILE = `${SERVICE_CONFIG_DIR}/gnosisvpn-dynamic.env`;

// macOS: the launchd daemon, and where the installer records the chosen network
// so a later pkg run or in-app update doesn't flip it back to the default.
export const LAUNCHD_PLIST =
  process.env.GNOSISVPN_LAUNCHD_PLIST ||
  '/Library/LaunchDaemons/com.gnosisvpn.gnosisvpnclient.plist';
export const MAC_NETWORK_CHOICE =
  process.env.GNOSISVPN_NETWORK_CHOICE_FILE ||
  '/Library/Logs/GnosisVPN/installer/network_choice';

// The bundle/app id the GUI client uses for its per-user data directory.
export const APP_ID = 'com.gnosisvpn.gnosisvpnclient';

// Where the client writes its log (the installer creates the directory, the
// service creates the file).
export function logDir(platform = process.platform) {
  if (process.env.GNOSISVPN_LOG_DIR) return process.env.GNOSISVPN_LOG_DIR;
  return platform === 'darwin' ? '/Library/Logs/GnosisVPN' : '/var/log/gnosisvpn';
}

// The GUI app's per-user settings file, holding among other things the saved
// exit-node location — which can name a destination another network doesn't have.
export function guiSettingsFile(userHome, platform = process.platform) {
  if (!userHome) return null;
  return platform === 'darwin'
    ? path.join(userHome, 'Library', 'Application Support', APP_ID, 'settings.json')
    : path.join(userHome, '.local', 'share', APP_ID, 'settings.json');
}

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
