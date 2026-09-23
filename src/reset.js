// Remove everything the running client generated, so the machine is left in the
// state a fresh install of the Gnosis VPN client leaves behind.
//
// After an install the state directory is empty on linux, and on macOS holds
// only the installer's own `uninstall.sh` + `process-control.sh`. The client
// then creates `.config/` (identity, password, safe, node database) and
// `.cache/` — both 0700 — on every start, so removing them is safe: the next
// start recreates them and the node bootstraps a fresh identity.
//
// This works from an explicit list of runtime entries rather than emptying the
// directory, which on macOS would delete the installer-shipped scripts.
//
// Deliberately preserved:
//   - the macOS updater's state (`updates/`, `last_update_attempt.json`,
//     `updates.log`) — it manages the installation, not the account, and
//     removing it makes the updater re-download or re-attempt
//   - `/Library/Logs/GnosisVPN/installer/` — holds `network_choice`, which
//     selects the network on the next pkg run
//
// The client must be stopped before this runs; the caller guarantees that.

import fs from 'node:fs/promises';
import path from 'node:path';
import { logDir } from './paths.js';

// Remove one path, recursively. Absent is success-and-silent; anything else is
// reported so the caller can warn without aborting the reset.
async function remove(target, removed, skipped) {
  try {
    // force:false so a missing path throws ENOENT and we can tell "wasn't
    // there" apart from "couldn't remove it".
    await fs.rm(target, { recursive: true, force: false });
    removed.push(target);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    skipped.push({ path: target, reason: err.code || err.message });
  }
}

// Runtime files the daemon keeps outside its state directory. The socket and
// lock are recreated on start; teardown-state.json would otherwise let the next
// start replay routing/DNS recovery from the old session.
function runtimePaths(platform) {
  const paths = [
    '/var/run/gnosisvpn.sock',
    '/var/run/gnosisvpn', // daemon.lock + teardown-state.json
    '/run/gnosisvpn', // systemd RuntimeDirectory (same as /var/run on linux)
  ];
  if (platform === 'darwin') paths.push('/var/run/gnosisvpn.pid');
  return paths;
}

// The client's own log and its rotations — never the installer logs and never
// the updater's audit log, neither of which start with "gnosisvpn.log".
async function removeLogs(platform, removed, skipped) {
  const dir = logDir(platform);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return; // no log directory on this machine
  }
  for (const name of entries) {
    if (!name.startsWith('gnosisvpn.log')) continue;
    await remove(path.join(dir, name), removed, skipped);
  }
}

// Wipe all client-generated state under `home` (= $GNOSISVPN_HOME) and the
// runtime/log files outside it. `guiSettingsFile`, when given, is the desktop
// user's GUI settings file, removed because its saved exit-node location may
// not exist on another network.
//
// Returns { removed: [path], skipped: [{ path, reason }] }.
export async function resetClientState({
  home,
  files,
  platform = process.platform,
  guiSettingsFile,
} = {}) {
  const removed = [];
  const skipped = [];

  // The account files, which GNOSISVPN_HOPR_IDENTITY_FILE can move out of
  // <home>/.config. Normally they're inside it and this is a no-op.
  for (const file of Object.values(files || {})) {
    await remove(file, removed, skipped);
  }

  if (home) {
    for (const entry of [
      '.config', // identity, password, safe, node db
      '.cache',
      'wg0_gnosisvpn.conf', // legacy: pre-userspace-WireGuard builds wrote this
    ]) {
      await remove(path.join(home, entry), removed, skipped);
    }
  }

  for (const p of runtimePaths(platform)) {
    await remove(p, removed, skipped);
  }

  await removeLogs(platform, removed, skipped);

  if (guiSettingsFile) await remove(guiSettingsFile, removed, skipped);

  return { removed, skipped };
}
