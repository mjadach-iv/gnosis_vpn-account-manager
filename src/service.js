// Detect the service manager (systemd / launchd), stop/start the Gnosis VPN
// client, and perform the file swap (with a backup of the current files).

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const DEFAULT_SYSTEMD_UNIT = 'gnosisvpn';
const DEFAULT_LAUNCHD_LABEL = 'com.gnosisvpn.gnosisvpnclient';

// The GUI client app: macOS bundle id and the process / executable name used to
// quit + relaunch it. Override via env if the install differs.
const APP_BUNDLE = process.env.GNOSISVPN_APP_BUNDLE || 'com.gnosisvpn.gnosisvpnclient';
const APP_NAME = process.env.GNOSISVPN_APP_NAME || 'GnosisVPN';

// True when running as root (or on a platform without getuid, e.g. Windows).
function isRoot() {
  return typeof process.getuid !== 'function' || process.getuid() === 0;
}

async function tryExec(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 15_000 });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// Determine which manager controls the client and the unit/label to use.
// Returns { manager: 'systemd'|'launchd'|null, name }.
export async function detectService({ serviceName, platform = process.platform } = {}) {
  if (platform === 'linux') {
    if (serviceName) return { manager: 'systemd', name: serviceName };
    const res = await tryExec('systemctl', ['list-units', '--all', '--type=service', '*gnosis*']);
    if (res.ok) {
      const m = res.stdout.match(/([\w@.-]+\.service)/);
      return { manager: 'systemd', name: m ? m[1] : DEFAULT_SYSTEMD_UNIT };
    }
    // systemctl present but nothing matched / not found.
    return { manager: null, name: serviceName || DEFAULT_SYSTEMD_UNIT };
  }

  if (platform === 'darwin') {
    if (serviceName) return { manager: 'launchd', name: serviceName };
    const res = await tryExec('launchctl', ['list']);
    if (res.ok) {
      const line = res.stdout.split('\n').find((l) => /gnosis/i.test(l));
      const label = line ? line.trim().split(/\s+/).pop() : DEFAULT_LAUNCHD_LABEL;
      return { manager: 'launchd', name: label };
    }
    return { manager: null, name: serviceName || DEFAULT_LAUNCHD_LABEL };
  }

  return { manager: null, name: serviceName || null };
}

async function controlService(action, svc) {
  if (svc.manager === 'systemd') {
    const res = await tryExec('systemctl', [action, svc.name]);
    if (!res.ok) throw new Error(`systemctl ${action} ${svc.name} failed: ${res.error.message}`);
  } else if (svc.manager === 'launchd') {
    // launchctl uses load/unload (or bootstrap/bootout) rather than start/stop.
    if (action === 'stop') {
      await tryExec('launchctl', ['stop', svc.name]);
    } else if (action === 'start') {
      await tryExec('launchctl', ['start', svc.name]);
    }
  }
}

export const stopService = (svc) => controlService('stop', svc);
export const startService = (svc) => controlService('start', svc);

// Reliably (re)start the service. systemd uses `restart`; launchd uses the
// modern `kickstart -k` (kill + restart) against the likely domain, falling
// back to legacy stop/start if the domain target isn't found.
async function restartLaunchd(name) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  for (const target of [`system/${name}`, `gui/${uid}/${name}`]) {
    const res = await tryExec('launchctl', ['kickstart', '-k', target]);
    if (res.ok) return;
  }
  await tryExec('launchctl', ['stop', name]);
  await tryExec('launchctl', ['start', name]);
}

// Best-effort detached launch (don't wait for a long-running GUI process).
function spawnDetached(cmd, args) {
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Binary missing / not launchable — ignore.
  }
}

// The logged-in (GUI) user. When self-elevated via sudo we're root, so GUI apps
// must be launched into the original user's session, not root's.
async function loginUser() {
  if (process.env.SUDO_USER && process.env.SUDO_USER !== 'root') return process.env.SUDO_USER;
  const res = await tryExec('stat', ['-f', '%Su', '/dev/console']); // macOS console owner
  const user = res.ok ? res.stdout.trim() : '';
  return user && user !== 'root' ? user : null;
}

// Quit and relaunch the GUI client app (best effort), in the login user's session.
async function restartGuiApp(platform = process.platform) {
  const user = await loginUser();

  if (platform === 'darwin') {
    await tryExec('osascript', ['-e', `tell application id "${APP_BUNDLE}" to quit`]);
    await tryExec('pkill', ['-x', APP_NAME]);
    if (user) {
      const idRes = await tryExec('id', ['-u', user]);
      const uid = idRes.ok ? idRes.stdout.trim() : '';
      if (uid) {
        // `launchctl asuser` targets the user's GUI session for the relaunch.
        await tryExec('launchctl', ['asuser', uid, 'sudo', '-u', user, 'open', '-b', APP_BUNDLE]);
        return;
      }
    }
    await tryExec('open', ['-b', APP_BUNDLE]);
    return;
  }

  if (platform === 'linux') {
    await tryExec('pkill', ['-f', APP_NAME]);
    // Relaunch detached in the user's session if we know who they are.
    if (user) {
      spawnDetached('sudo', ['-u', user, APP_NAME]);
    } else {
      spawnDetached(APP_NAME, []);
    }
  }
}

// Restart the background service AND the GUI client app.
export async function restartService(svc) {
  if (svc.manager === 'systemd') {
    const res = await tryExec('systemctl', ['restart', svc.name]);
    if (!res.ok) throw new Error(`systemctl restart ${svc.name} failed: ${res.error.message}`);
  } else if (svc.manager === 'launchd') {
    await restartLaunchd(svc.name);
  }
  await restartGuiApp();
}

// Back up the current on-disk account files into backup-<ts>/ next to .config.
async function backupCurrent(files, timestamp) {
  const backupDir = path.join(path.dirname(files.id), `backup-${timestamp}`);
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
  for (const [kind, file] of Object.entries(files)) {
    try {
      const buf = await fs.readFile(file);
      await fs.writeFile(path.join(backupDir, path.basename(file)), buf, { mode: 0o600 });
    } catch {
      // File may not exist yet (kind=${kind}); skip.
      void kind;
    }
  }
  return backupDir;
}

// Write the three decrypted blobs to their on-disk locations with tight perms.
async function writeAccountFiles(files, decrypted) {
  const dir = path.dirname(files.id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(files.id, decrypted.id, { mode: 0o600 });
  if (decrypted.pass != null) await fs.writeFile(files.pass, decrypted.pass, { mode: 0o600 });
  if (decrypted.safe != null) await fs.writeFile(files.safe, decrypted.safe, { mode: 0o600 });
}

// Remove the current account from the machine: stop -> backup -> delete files
// -> restart. Restarting lets the client regenerate a fresh identity. Returns
// { backupDir, manager }.
export async function clearFiles({ files, svc, timestamp }) {
  if (!isRoot()) {
    throw new Error(
      'Clearing requires root: the account files live under a system directory and the ' +
        'service must be restarted. Re-run with sudo.',
    );
  }

  if (svc.manager) await stopService(svc);

  const backupDir = await backupCurrent(files, timestamp);
  for (const file of Object.values(files)) {
    try {
      await fs.unlink(file);
    } catch {
      // Already absent — nothing to remove.
    }
  }

  if (svc.manager) await restartService(svc);

  return { backupDir, manager: svc.manager };
}

// Perform a full swap: stop -> backup -> write new files -> start.
// `decrypted` = { id, pass, safe } Buffers. Returns { backupDir, manager }.
export async function swapFiles({ files, decrypted, svc, timestamp }) {
  if (!isRoot()) {
    throw new Error(
      'Swapping requires root: the account files live under a system directory and the ' +
        'service must be restarted. Re-run with sudo.',
    );
  }

  if (svc.manager) await stopService(svc);

  const backupDir = await backupCurrent(files, timestamp);
  await writeAccountFiles(files, decrypted);

  if (svc.manager) await restartService(svc);

  return { backupDir, manager: svc.manager };
}
