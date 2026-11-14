// Per-OS defaults, on-disk filenames, and the env-var names that override them.

import fs from 'node:fs';
import path from 'node:path';

// Installer 0.97.0 (client 0.98.0) moved the account from one identity shared by
// a `gnosisvpn` service user to per-user, per-network slots in the user's home.
const PER_USER_SINCE = [0, 97, 0];

// Legacy layout: the three account files under $GNOSISVPN_HOME/.config/.
export const FILES = {
  id: 'gnosisvpn-hopr.id', // encrypted HOPR identity
  pass: 'gnosisvpn-hopr.pass', // 48-char identity password (plaintext)
  safe: 'gnosisvpn-hopr.safe', // YAML: safe_address + module_address
};

// Per-user layout: the same three files, in the network's slot of the user's
// data dir (id, pass) and cache dir (safe).
export const USER_FILES = { id: 'hopr.id', pass: 'hopr.pass', safe: 'hopr.safe' };

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

// The installed package version, written by the installer on both platforms.
export const VERSION_FILE = `${SERVICE_CONFIG_DIR}/version.txt`;

// linux: the env file the installer generates to carry the Blokli endpoint.
// (gnosisvpn.env next to it is a dpkg conffile whose value is kept empty — the
// installer re-empties it on every run, so we must never write to it.)
export const DYNAMIC_ENV_FILE = `${SERVICE_CONFIG_DIR}/gnosisvpn-dynamic.env`;

// macOS: the launchd daemon.
export const LAUNCHD_PLIST =
  process.env.GNOSISVPN_LAUNCHD_PLIST ||
  '/Library/LaunchDaemons/com.gnosisvpn.gnosisvpnclient.plist';

// The bundle/app id the GUI client uses for its per-user directories.
export const APP_ID = 'com.gnosisvpn.gnosisvpnclient';

// 'per-user' or 'legacy', from the installed package version. A missing or
// unparseable version means a current install. GNOSISVPN_LAYOUT forces either.
export function detectLayout(versionFile = VERSION_FILE) {
  const forced = process.env.GNOSISVPN_LAYOUT;
  if (forced === 'per-user' || forced === 'legacy') return forced;
  // A legacy install always has its service user's home; without one, version.txt is stale.
  if (!fs.existsSync(resolveHome())) return 'per-user';
  let text;
  try {
    text = fs.readFileSync(versionFile, 'utf8');
  } catch {
    return 'per-user';
  }
  const m = text.match(/^\s*(\d+)\.(\d+)\.(\d+)/);
  if (!m) return 'per-user';
  for (let i = 0; i < 3; i++) {
    const part = Number(m[i + 1]);
    if (part !== PER_USER_SINCE[i]) return part > PER_USER_SINCE[i] ? 'per-user' : 'legacy';
  }
  return 'per-user';
}

// macOS: where the installer records the chosen network, so a later pkg run or
// in-app update doesn't flip it back to the default. Installer 0.97.0 moved it
// out of the log dir.
export function macNetworkChoiceFile(layout) {
  if (process.env.GNOSISVPN_NETWORK_CHOICE_FILE) return process.env.GNOSISVPN_NETWORK_CHOICE_FILE;
  return layout === 'legacy'
    ? '/Library/Logs/GnosisVPN/installer/network_choice'
    : '/Library/Application Support/GnosisVPN/installer/network_choice';
}

// Where the client writes its log (the installer creates the directory, the
// service creates the file).
export function logDir(platform = process.platform) {
  if (process.env.GNOSISVPN_LOG_DIR) return process.env.GNOSISVPN_LOG_DIR;
  return platform === 'darwin' ? '/Library/Logs/GnosisVPN' : '/var/log/gnosisvpn';
}

// The GUI app's per-user settings file, holding among other things the saved
// exit-node location — which can name a destination another network doesn't have.
// On linux the app moved it from XDG data to XDG config alongside installer 0.97.0.
export function guiSettingsFile(userHome, platform = process.platform, layout = 'per-user') {
  if (!userHome) return null;
  if (platform === 'darwin') {
    return path.join(userHome, 'Library', 'Application Support', APP_ID, 'settings.json');
  }
  const base = layout === 'legacy' ? path.join('.local', 'share') : '.config';
  return path.join(userHome, base, APP_ID, 'settings.json');
}

// Per-user layout: the roots the worker keeps its state in under `userHome`.
export function userDirs(userHome, platform = process.platform) {
  if (platform === 'darwin') {
    return {
      data: path.join(userHome, 'Library', 'Application Support', 'GnosisVPN'),
      cache: path.join(userHome, 'Library', 'Caches', 'GnosisVPN'),
      logs: path.join(userHome, 'Library', 'Logs', 'GnosisVPN'),
    };
  }
  return {
    data: path.join(userHome, '.local', 'share', 'gnosisvpn'),
    cache: path.join(userHome, '.cache', 'gnosisvpn'),
    logs: path.join(userHome, '.local', 'state', 'gnosisvpn'),
  };
}

// Per-user layout: the account files of one network's slot. The network is the
// name Blokli reports, which matches the installer's (jura-prod, piz-palu-dev, …).
export function networkFiles(dirs, network) {
  const data = path.join(dirs.data, 'networks', network);
  const cache = path.join(dirs.cache, 'networks', network);
  return {
    id: path.join(data, USER_FILES.id),
    pass: path.join(data, USER_FILES.pass),
    safe: path.join(cache, USER_FILES.safe),
  };
}

// Legacy layout: default $GNOSISVPN_HOME per platform.
export function defaultHome(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/GnosisVPN';
  return '/var/lib/gnosisvpn'; // linux + everything else
}

// Resolve $GNOSISVPN_HOME, honouring the env override.
export function resolveHome(env = process.env, platform = process.platform) {
  return env[ENV.home] || defaultHome(platform);
}

// The .config directory holding the legacy account files.
export function configDir(env = process.env, platform = process.platform) {
  return path.join(resolveHome(env, platform), '.config');
}

// Legacy layout: resolve the absolute paths of the three account files.
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
