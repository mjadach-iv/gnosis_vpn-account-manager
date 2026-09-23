// Detect which network the client is configured for, from the config.toml
// symlink and/or GNOSISVPN_HOPR_BLOKLI_URL in the service definition/environment.
//
// Network names follow the client's <prefix>-<env> scheme (jura-prod, jura-dev,
// piz-palu-dev, …) and the Blokli endpoint mirrors that split:
//   https://blokli-<prefix>.<env>.hoprnet.link
//
// Returns { network: string|null, blokliUrl: string|null }.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ENV,
  SERVICE_CONFIG_DIR,
  SERVICE_CONFIG_LINK,
  DYNAMIC_ENV_FILE,
  LAUNCHD_PLIST,
  MAC_NETWORK_CHOICE,
} from './paths.js';

const execFileAsync = promisify(execFile);

// Ownership can only be set as root. The callers that write client config
// (resetMachine / switchMachineNetwork in service.js) require root, so this is
// only ever false when exercising applyNetwork against a test fixture.
function isRoot() {
  return typeof process.getuid !== 'function' || process.getuid() === 0;
}

// Networks offered when detection fails. Not a closed set — networkFromUrl()
// derives any <prefix>-<env> pair and the prompt also accepts free text.
export const KNOWN_NETWORKS = ['jura-prod', 'jura-staging', 'jura-dev', 'piz-palu-dev'];

// https://blokli-<prefix>.<env>.hoprnet.link -> "<prefix>-<env>"
const BLOKLI_RE = /^https?:\/\/blokli-([a-z0-9-]+)\.([a-z0-9-]+)\.hoprnet\.link/i;

// Map a blokli URL to a network name.
export function networkFromUrl(url) {
  if (!url) return null;
  const m = url.match(BLOKLI_RE);
  if (m) return `${m[1]}-${m[2]}`.toLowerCase();
  // Legacy endpoints that predate the <prefix>-<env> scheme.
  const u = url.toLowerCase();
  if (u.includes('rotsee')) return 'rotsee';
  if (u.includes('jura')) return 'jura';
  return null;
}

// The inverse: derive the default blokli endpoint from a network name, the same
// way the client's installer does. Returns null for names without an env suffix.
export function urlForNetwork(network) {
  const i = network ? network.lastIndexOf('-') : -1;
  if (i <= 0 || i === network.length - 1) return null;
  return `https://blokli-${network.slice(0, i)}.${network.slice(i + 1)}.hoprnet.link`;
}

// Map a config file name to a network: config-jura-dev.toml / jura-dev.toml
// -> "jura-dev". Plain config.toml (an unresolved symlink) yields null.
export function networkFromConfigFile(file) {
  if (!file) return null;
  const base = path.basename(file);
  if (!base.endsWith('.toml')) return null;
  let name = base.slice(0, -'.toml'.length);
  if (name.startsWith('config-')) name = name.slice('config-'.length);
  if (!name || name === 'config') return null;
  return name.toLowerCase();
}

// Pull the URL out of a `KEY=value` blob (systemd unit, env file, plist).
export function extractUrl(text) {
  if (!text) return null;
  // KEY=value, KEY="value" or systemd's Environment="KEY=value", anchored per
  // line so an empty value doesn't swallow the following line. Requiring an
  // http(s) value matches the installer's own validation.
  const kv = text.match(
    new RegExp(`^[ \\t]*(?:Environment=)?"?${ENV.blokliUrl}=[ \\t]*"?(https?://[^"\\s]+)"?`, 'm'),
  );
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

// Resolve the client's config.toml to the network it points at. The installer
// links it to config-<network>.toml (linux, absolute) or <network>.toml
// (macOS, relative); a plain regular file tells us nothing and yields null.
export async function networkFromConfigLink(link = SERVICE_CONFIG_LINK) {
  // readlink first: it names the target even if the link dangles.
  try {
    return networkFromConfigFile(await fs.readlink(link));
  } catch {
    // Not a symlink (or unreadable) — a real path may still resolve.
  }
  try {
    const real = await fs.realpath(link);
    // Only trust it if it resolved to a *different* file in the same directory.
    if (real !== path.resolve(link) && path.dirname(real) === path.dirname(path.resolve(link))) {
      return networkFromConfigFile(real);
    }
  } catch {
    // No config installed.
  }
  return null;
}

// Look for the blokli URL in the service definition / env files / plist.
async function findUrl({ serviceName, platform }) {
  if (platform === 'linux') {
    // The installer writes the effective URL here; gnosisvpn.env is a dpkg
    // conffile it deliberately resets to an empty value.
    for (const f of [
      `${SERVICE_CONFIG_DIR}/gnosisvpn-dynamic.env`,
      `${SERVICE_CONFIG_DIR}/gnosisvpn.env`,
      '/etc/default/gnosisvpn',
    ]) {
      const url = extractUrl(await tryRead(f));
      if (url) return url;
    }
    // systemd unit definition (covers Environment= lines set by hand).
    const unit = serviceName || 'gnosisvpn';
    const url = extractUrl(await tryExec('systemctl', ['cat', unit]));
    if (url) return url;
  }

  if (platform === 'darwin') {
    for (const f of [LAUNCHD_PLIST, '/Library/LaunchDaemons/com.gnosisvpn.plist']) {
      const url = extractUrl(await tryRead(f));
      if (url) return url;
    }
  }

  return null;
}

// Detect the blokli URL + network for the given service name.
export async function detectNetwork({ serviceName, platform = process.platform } = {}) {
  // 0. Our own process env (useful in dev / when launched by the service).
  //    An explicit override wins outright.
  let url = process.env[ENV.blokliUrl] || null;
  let network = networkFromUrl(url);

  // 1. The config.toml symlink names the network directly.
  if (!network) network = await networkFromConfigLink();

  // 2. Service definition / env files / plist.
  if (!url) url = await findUrl({ serviceName, platform });

  // 3. Fall back to deriving the network from whatever URL turned up…
  if (!network) network = networkFromUrl(url);
  // …and the URL from the network, using the installer's own naming rule.
  if (!url && network) url = urlForNetwork(network);

  return { network, blokliUrl: url };
}

// --- Selecting a network ---------------------------------------------------
//
// Everything below WRITES the client's own configuration, reproducing what the
// installer's postinstall does. The client must be stopped first and restarted
// afterwards — see stopClient/startClient in service.js.

// The config file that selects a network: config-<net>.toml on linux,
// <net>.toml on macOS.
function configFileFor(network, platform) {
  const base = platform === 'darwin' ? `${network}.toml` : `config-${network}.toml`;
  return path.join(SERVICE_CONFIG_DIR, base);
}

// The networks actually installed on this machine — the authoritative list, and
// what the client will accept. Returns [] when the config dir can't be read.
export async function installedNetworks(platform = process.platform) {
  let entries;
  try {
    entries = await fs.readdir(SERVICE_CONFIG_DIR);
  } catch {
    return [];
  }
  const names = new Set();
  for (const name of entries) {
    if (name === 'config.toml' || !name.endsWith('.toml')) continue;
    // Ignore the other platform's naming, so a leftover file can't offer a
    // network the installed client wouldn't actually load.
    const prefixed = name.startsWith('config-');
    if (platform === 'darwin' ? prefixed : !prefixed) continue;
    const net = networkFromConfigFile(name);
    if (net) names.add(net);
  }
  return [...names].sort();
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

// Point config.toml at the network's config file. The installer uses an
// absolute target on linux and a relative one on macOS — match it exactly.
// A config.toml that is a *regular file* is hand-managed (the macOS installer
// preserves that case), so move it aside rather than destroy it.
async function linkConfig(configFile, platform, changed) {
  const target = platform === 'darwin' ? path.basename(configFile) : configFile;
  try {
    const st = await fs.lstat(SERVICE_CONFIG_LINK);
    if (st.isSymbolicLink()) {
      await fs.unlink(SERVICE_CONFIG_LINK);
    } else {
      const backup = `${SERVICE_CONFIG_LINK}.backup.${stamp()}`;
      await fs.rename(SERVICE_CONFIG_LINK, backup);
      changed.push(`${backup} (existing config.toml was a regular file, kept)`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await fs.symlink(target, SERVICE_CONFIG_LINK);
  changed.push(SERVICE_CONFIG_LINK);
}

// linux: the Blokli endpoint lives in the generated env file the systemd unit
// loads. Byte-for-byte what postinstall writes, including the em dash.
async function writeDynamicEnv(blokliUrl, changed) {
  const body =
    '# Generated by GnosisVPN postinstall — do not edit.\n' +
    '# Values here override /etc/gnosisvpn/gnosisvpn.env.\n' +
    `${ENV.blokliUrl}=${blokliUrl}\n`;
  await fs.writeFile(DYNAMIC_ENV_FILE, body);
  // Loaded by the root service, so it must not be writable by the worker user.
  await fs.chmod(DYNAMIC_ENV_FILE, 0o644);
  if (isRoot()) await fs.chown(DYNAMIC_ENV_FILE, 0, 0);
  changed.push(DYNAMIC_ENV_FILE);
}

// macOS: the Blokli endpoint lives in the launchd plist's EnvironmentVariables.
// Edited via PlistBuddy and validated with plutil; restored on a bad edit.
async function writePlistUrl(blokliUrl, changed) {
  const key = `:EnvironmentVariables:${ENV.blokliUrl}`;
  const original = await fs.readFile(LAUNCHD_PLIST);

  const set = await tryExec('/usr/libexec/PlistBuddy', [
    '-c',
    `Set ${key} ${blokliUrl}`,
    LAUNCHD_PLIST,
  ]);
  if (set === null) {
    // Key absent (a hand-written plist) — add it.
    const added = await tryExec('/usr/libexec/PlistBuddy', [
      '-c',
      `Add ${key} string ${blokliUrl}`,
      LAUNCHD_PLIST,
    ]);
    if (added === null) throw new Error(`could not set ${ENV.blokliUrl} in ${LAUNCHD_PLIST}`);
  }

  if ((await tryExec('plutil', ['-lint', LAUNCHD_PLIST])) === null) {
    await fs.writeFile(LAUNCHD_PLIST, original);
    throw new Error(`${LAUNCHD_PLIST} failed validation after the edit — restored the original`);
  }
  await fs.chmod(LAUNCHD_PLIST, 0o644);
  if (isRoot()) await fs.chown(LAUNCHD_PLIST, 0, 0); // root:wheel
  changed.push(LAUNCHD_PLIST);
}

// macOS: record the choice the way the installer's choice sub-package does, so
// a later pkg run or in-app update doesn't silently flip back to the default.
async function writeNetworkChoice(network, changed) {
  await fs.mkdir(path.dirname(MAC_NETWORK_CHOICE), { recursive: true });
  await fs.writeFile(MAC_NETWORK_CHOICE, `INSTALLER_CHOICE_NETWORK="${network}"\n`);
  changed.push(MAC_NETWORK_CHOICE);
}

// Point the installed client at `network`. Returns { network, blokliUrl, changed }.
export async function applyNetwork(network, { platform = process.platform } = {}) {
  const configFile = configFileFor(network, platform);
  try {
    await fs.access(configFile);
  } catch {
    // Same guard as the installer: an unknown network would otherwise leave a
    // dangling config.toml and a bogus endpoint.
    const available = await installedNetworks(platform);
    throw new Error(
      `Unknown network "${network}": ${configFile} not found. ` +
        `Installed on this machine: ${available.join(', ') || 'none'}.`,
    );
  }

  const blokliUrl = urlForNetwork(network);
  if (!blokliUrl) {
    throw new Error(`Cannot derive a Blokli URL for "${network}" — expected a <prefix>-<env> name.`);
  }

  const changed = [];
  await linkConfig(configFile, platform, changed);

  if (platform === 'darwin') {
    await writePlistUrl(blokliUrl, changed);
    await writeNetworkChoice(network, changed);
  } else {
    await writeDynamicEnv(blokliUrl, changed);
    // /etc/gnosisvpn/gnosisvpn.env is deliberately left alone: it's a dpkg
    // conffile whose Blokli value the installer keeps empty.
  }

  return { network, blokliUrl, changed };
}
