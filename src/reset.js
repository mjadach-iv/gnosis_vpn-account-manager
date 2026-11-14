// Remove everything the running client generated, so the machine is left in the
// state a fresh install of the Gnosis VPN client leaves behind.
//
// Per-user layout (installer 0.97.0+): the account is the desktop user's slot for
// the current network — `networks/<network>/` in their data dir (identity) and
// cache dir (safe). The worker recreates both 0700 on its next start and
// bootstraps a fresh identity. Other networks' slots are separate accounts and
// stay, as do the legacy state dir (updater state, legacy identity backups) and
// the installer's choice files.
//
// Legacy layout: after an install the state directory is empty on linux, and on
// macOS holds only the installer's own `uninstall.sh` + `process-control.sh`.
// The client then creates `.config/` (identity, password, safe, node database)
// and `.cache/` — both 0700 — on every start, so removing them is safe. This
// works from an explicit list of runtime entries rather than emptying the
// directory, which on macOS would delete the installer-shipped scripts. The
// macOS updater's state and `/Library/Logs/GnosisVPN/installer/` (which holds
// `network_choice`) are deliberately preserved.
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

// Log files in `dir` named `prefix…` (the live log and its rotations) — never
// the installer logs or the updater's audit log, which share the directory.
async function removeLogs(dir, prefix, removed, skipped) {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return; // no log directory on this machine
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    await remove(path.join(dir, name), removed, skipped);
  }
}

// Wipe the account slot `location` (from locateAccount()) and the client-generated
// runtime/log files. `guiSettingsFile`, when given, is the desktop user's GUI
// settings file, removed because its saved exit-node location may not exist on
// another network.
//
// Returns { removed: [path], skipped: [{ path, reason }] }.
export async function resetClientState({ location, platform = process.platform, guiSettingsFile } = {}) {
  const removed = [];
  const skipped = [];

  if (location.layout === 'per-user') {
    await remove(path.dirname(location.files.id), removed, skipped);
    await remove(path.dirname(location.files.safe), removed, skipped);
    await removeLogs(location.dirs.logs, 'worker.log', removed, skipped);
  } else {
    // The account files, which GNOSISVPN_HOPR_IDENTITY_FILE can move out of
    // <home>/.config. Normally they're inside it and this is a no-op.
    for (const file of Object.values(location.files)) {
      await remove(file, removed, skipped);
    }
    for (const entry of [
      '.config', // identity, password, safe, node db
      '.cache',
      'wg0_gnosisvpn.conf', // legacy: pre-userspace-WireGuard builds wrote this
    ]) {
      await remove(path.join(location.home, entry), removed, skipped);
    }
  }

  for (const p of runtimePaths(platform)) {
    await remove(p, removed, skipped);
  }

  await removeLogs(logDir(platform), 'gnosisvpn.log', removed, skipped);

  if (guiSettingsFile) await remove(guiSettingsFile, removed, skipped);

  return { removed, skipped };
}
