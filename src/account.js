// Locate and read the account currently installed on disk: the three files plus
// the EOA/safe (via ctl, falling back to the .safe YAML) and the network.

import fs from 'node:fs/promises';
import yaml from 'js-yaml';
import { balance, chainBalances } from './ctl.js';
import { deriveEoa } from './identity.js';
import { detectNetwork } from './network.js';
import { detectLayout, networkFiles, resolveFiles, resolveHome, userDirs } from './paths.js';
import { resolveUser } from './user.js';

// Read a file, treating only "not found" as null. Permission and other errors
// are surfaced so a protected/unreadable file isn't mistaken for an absent one.
async function readFileOrNull(file) {
  try {
    return await fs.readFile(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`cannot read ${file}: ${err.code || err.message} (try sudo / grant Full Disk Access on macOS)`);
  }
}

// Where the client keeps the account it uses for `network` (default: the one it is
// configured for). Per-user layout:
//   { layout:'per-user', user:{name,uid,gid,home}, network, dirs:{data,cache,logs}, files }
// Legacy layout, one identity for every network and user:
//   { layout:'legacy', home, files }
export async function locateAccount({ userName, serviceName, network } = {}) {
  const layout = detectLayout();
  if (layout === 'legacy') return { layout, home: resolveHome(), files: resolveFiles() };

  const user = await resolveUser(userName);
  if (!user) throw new Error('No desktop user found to manage the account of — pass --user <name>.');
  const net = network || (await detectNetwork({ serviceName })).network;
  if (!net) {
    throw new Error(
      "Could not detect the client's network, which keys where the account is stored. " +
        'Check that /etc/gnosisvpn/config.toml links to a network config.',
    );
  }
  const dirs = userDirs(user.home);
  return { layout, user, network: net, dirs, files: networkFiles(dirs, net) };
}

// Whether `location` already holds an identity.
export async function hasIdentity(location) {
  try {
    await fs.access(location.files.id);
    return true;
  } catch {
    return false;
  }
}

// Parse safe_address out of the .safe YAML buffer.
export function parseSafe(safeBuf) {
  if (!safeBuf) return null;
  try {
    // FAILSAFE_SCHEMA keeps every scalar a string — otherwise js-yaml parses an
    // unquoted 0x… address as a hexadecimal integer and corrupts it.
    const doc = yaml.load(safeBuf.toString('utf8'), { schema: yaml.FAILSAFE_SCHEMA });
    return doc?.safe_address || null;
  } catch {
    return null;
  }
}

// Read the current on-disk account.
//
// Returns null if no .id file is present ("no account currently in use").
// Otherwise returns:
//   { present, location, files:{id,pass,safe} (Buffers), address, safe, network, blokliUrl, eoaSource }
// `eoaOverride` lets the caller supply an EOA when ctl is unreachable.
export async function readCurrentAccount({ serviceName, userName, eoaOverride, withBalances } = {}) {
  const { network, blokliUrl } = await detectNetwork({ serviceName });
  const location = await locateAccount({ userName, serviceName, network });
  const { files } = location;

  const idBuf = await readFileOrNull(files.id);
  if (!idBuf) return null; // no account in use

  const [passBuf, safeBuf] = await Promise.all([
    readFileOrNull(files.pass),
    readFileOrNull(files.safe),
  ]);

  const safeFromYaml = parseSafe(safeBuf);

  let address = null;
  let safe = safeFromYaml;
  let eoaSource = null;

  // EOA: derive it from the on-disk identity (.id + .pass). This is authoritative
  // and works offline — no dependency on the running service.
  if (passBuf) {
    try {
      address = deriveEoa(idBuf, passBuf).address;
      eoaSource = 'identity';
    } catch {
      // Wrong password / not a keystore — fall back to ctl / override below.
    }
  }

  // Fall back to ctl (also the source of the safe address if the .safe YAML
  // lacked it), then to a caller-supplied override.
  if (!address || !safe) {
    const ctl = await balance();
    // The running worker may hold another user's or network's account than this slot.
    if (ctl && (!address || ctl.nodeAddress.toLowerCase() === address.toLowerCase())) {
      if (!address) {
        address = ctl.nodeAddress;
        eoaSource = 'ctl';
      }
      if (!safe) safe = ctl.safeAddress || null;
    }
  }
  if (!address && eoaOverride) {
    address = eoaOverride;
    eoaSource = 'override';
  }

  // On-chain balances: native xDAI of the EOA, wxHOPR of the safe.
  let balances = null;
  if (withBalances && (address || safe)) {
    balances = await chainBalances({ eoa: address, safe });
  }

  return {
    present: true,
    location,
    files: { id: idBuf, pass: passBuf, safe: safeBuf },
    address,
    safe,
    network,
    blokliUrl,
    eoaSource,
    balances,
  };
}
