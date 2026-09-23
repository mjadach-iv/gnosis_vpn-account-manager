// Detect the service manager (systemd / launchd), stop/start the Gnosis VPN
// client, perform the file swap (with a backup of the current files), and reset
// the machine to a freshly-installed state.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LAUNCHD_PLIST, guiSettingsFile } from './paths.js';
import { resetClientState } from './reset.js';
import { applyNetwork } from './network.js';

const execFileAsync = promisify(execFile);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_SYSTEMD_UNIT = 'gnosisvpn';
const DEFAULT_LAUNCHD_LABEL = 'com.gnosisvpn.gnosisvpnclient';

// The GUI client app. macOS uses a bundle id; Linux uses the executable name
// (`gnosis_vpn-app`, per the `Gnosis VPN.desktop` entry) and the desktop-file id
// used to relaunch via `gtk-launch`. Override via env if the install differs.
const APP_BUNDLE = process.env.GNOSISVPN_APP_BUNDLE || 'com.gnosisvpn.gnosisvpnclient';
const APP_NAME =
  process.env.GNOSISVPN_APP_NAME ||
  (process.platform === 'darwin' ? 'GnosisVPN' : 'gnosis_vpn-app');
const APP_DESKTOP_ID = process.env.GNOSISVPN_DESKTOP_ID || 'Gnosis VPN';

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
      // Skip phantom "not-found" rows (a referenced-but-uninstalled unit still
      // appears under `--all`) and pick the first real unit.
      const line = res.stdout
        .split('\n')
        .find((l) => /\.service/.test(l) && !/not-found/.test(l));
      const m = line && line.match(/([\w@.-]+\.service)/);
      if (m) return { manager: 'systemd', name: m[1] };
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
  if (process.platform === 'darwin') {
    const res = await tryExec('stat', ['-f', '%Su', '/dev/console']); // macOS console owner
    const user = res.ok ? res.stdout.trim() : '';
    return user && user !== 'root' ? user : null;
  }
  // Linux: the user owning an active graphical session (SESSION UID USER SEAT …).
  const res = await tryExec('loginctl', ['list-sessions', '--no-legend']);
  if (res.ok) {
    for (const line of res.stdout.split('\n')) {
      const user = line.trim().split(/\s+/)[2];
      if (user && user !== 'root') return user;
    }
  }
  return null;
}

// GUI session env vars needed to launch a windowed app into a user's session.
function guiSessionEnv(uid) {
  const runtimeDir = `/run/user/${uid}`;
  return [
    `DISPLAY=${process.env.DISPLAY || ':0'}`,
    `XDG_RUNTIME_DIR=${runtimeDir}`,
    `DBUS_SESSION_BUS_ADDRESS=unix:path=${runtimeDir}/bus`,
  ];
}

// Relaunch the GUI client on Linux into the desktop user's graphical session.
// Prefers `gtk-launch <desktop-id>` (resolves the executable via the .desktop
// entry the way the desktop does); falls back to `gio launch` then the binary.
// Returns true if a launch was issued. When self-elevated via sudo we're root,
// so we drop to the login user AND hand the app the session env, or no window
// would appear. spawnDetached swallows spawn errors, so we probe with `which`.
async function launchGuiLinux(user) {
  const amRoot = typeof process.getuid !== 'function' || process.getuid() === 0;

  let prefix = [];
  if (amRoot && user) {
    const idRes = await tryExec('id', ['-u', user]);
    const uid = idRes.ok ? idRes.stdout.trim() : null;
    if (uid) prefix = ['sudo', '-u', user, 'env', ...guiSessionEnv(uid)];
  }

  const attempts = [
    ['gtk-launch', APP_DESKTOP_ID],
    ['gio', 'launch', `/usr/share/applications/${APP_DESKTOP_ID}.desktop`],
    [APP_NAME],
  ];
  for (const cmd of attempts) {
    // The launcher binary must exist; under sudo, gtk-launch/gio are system bins
    // and resolve the app within the user session even if APP_NAME isn't on
    // root's PATH.
    if (!(await tryExec('which', [cmd[0]])).ok) continue;
    const argv = [...prefix, ...cmd];
    spawnDetached(argv[0], argv.slice(1));
    return true;
  }
  return false;
}

// Quit the GUI client app (best effort). It must be down before the daemon is
// stopped, or it keeps re-triggering connections.
async function quitGuiApp(platform = process.platform) {
  if (platform === 'darwin') {
    await tryExec('osascript', ['-e', `tell application id "${APP_BUNDLE}" to quit`]);
    await tryExec('pkill', ['-x', APP_NAME]);
  } else if (platform === 'linux') {
    await tryExec('pkill', ['-f', APP_NAME]);
  }
}

// Launch the GUI client app into the login user's session (best effort).
// Returns true if a launch was issued.
async function launchGuiApp(platform = process.platform) {
  const user = await loginUser();

  if (platform === 'darwin') {
    if (user) {
      const idRes = await tryExec('id', ['-u', user]);
      const uid = idRes.ok ? idRes.stdout.trim() : '';
      if (uid) {
        // `launchctl asuser` targets the user's GUI session for the relaunch.
        await tryExec('launchctl', ['asuser', uid, 'sudo', '-u', user, 'open', '-b', APP_BUNDLE]);
        return true;
      }
    }
    await tryExec('open', ['-b', APP_BUNDLE]);
    return true;
  }

  if (platform === 'linux') return launchGuiLinux(user);

  return false;
}

// Quit and relaunch the GUI client app (best effort), in the login user's
// session. Returns true if a relaunch was issued.
async function restartGuiApp(platform = process.platform) {
  await quitGuiApp(platform);
  return launchGuiApp(platform);
}

// Restart the background service (if one is managed) AND the GUI client app.
// Returns { serviceRestarted, guiLaunched } so callers can report what happened.
export async function restartService(svc) {
  let serviceRestarted = false;
  if (svc.manager === 'systemd') {
    const res = await tryExec('systemctl', ['restart', svc.name]);
    if (!res.ok) throw new Error(`systemctl restart ${svc.name} failed: ${res.error.message}`);
    serviceRestarted = true;
  } else if (svc.manager === 'launchd') {
    await restartLaunchd(svc.name);
    serviceRestarted = true;
  }
  const guiLaunched = await restartGuiApp();
  return { serviceRestarted, guiLaunched };
}

// --- Full stop / start -----------------------------------------------------
//
// `restartService` above is the cheap path: systemd restart, or launchd
// `kickstart -k`. kickstart re-execs the job launchd has already loaded, so it
// will NOT pick up a rewritten plist — anything that changes the plist (i.e.
// switching networks) must go through stopClient/startClient, which bootout and
// bootstrap the job so the new definition is read.

// Stop the GUI app and the daemon, and wait for them to actually be gone.
export async function stopClient(svc, platform = process.platform) {
  await quitGuiApp(platform);

  if (svc.manager === 'systemd') {
    await tryExec('systemctl', ['stop', svc.name]);
  } else if (svc.manager === 'launchd') {
    // Prefer the plist-path form, fall back to the label.
    const res = await tryExec('launchctl', ['bootout', 'system', LAUNCHD_PLIST]);
    if (!res.ok) await tryExec('launchctl', ['bootout', `system/${svc.name}`]);
    await sleep(2000);
    await tryExec('pkill', ['-TERM', '-x', 'gnosis_vpn-root']);
    await sleep(2000);
    await tryExec('pkill', ['-KILL', '-x', 'gnosis_vpn-root']);
  }
}

// Start the daemon and relaunch the GUI app.
// Returns { started, guiLaunched }.
export async function startClient(svc, platform = process.platform) {
  let started = false;

  if (svc.manager === 'systemd') {
    // A crash-looping unit trips StartLimitBurst and `start` is refused until
    // the failure counter is cleared — the installer does this too.
    await tryExec('systemctl', ['reset-failed', svc.name]);
    const res = await tryExec('systemctl', ['start', svc.name]);
    if (!res.ok) throw new Error(`systemctl start ${svc.name} failed: ${res.error.message}`);
    started = true;
  } else if (svc.manager === 'launchd') {
    let res = await tryExec('launchctl', ['bootstrap', 'system', LAUNCHD_PLIST]);
    if (!res.ok) {
      // Usually "service already loaded": boot it out and bootstrap again, so a
      // rewritten plist is still read. Falling straight through to kickstart
      // here would re-exec the job with its OLD definition.
      await tryExec('launchctl', ['bootout', 'system', LAUNCHD_PLIST]);
      await sleep(2000);
      res = await tryExec('launchctl', ['bootstrap', 'system', LAUNCHD_PLIST]);
    }
    await tryExec('launchctl', ['enable', `system/${svc.name}`]);
    started = res.ok;
    if (!started) {
      // Couldn't load the definition at all — at least get the client running.
      await restartLaunchd(svc.name);
      started = true;
    }
  }

  const guiLaunched = await launchGuiApp(platform);
  return { started, guiLaunched };
}

// --- Reset / network switch ------------------------------------------------

// Resolve a user's home directory. We're root after self-elevation, so
// process.env.HOME is root's, not the desktop user's.
async function userHome(user, platform = process.platform) {
  if (!user) return null;
  if (platform === 'darwin') {
    const res = await tryExec('dscl', ['.', '-read', `/Users/${user}`, 'NFSHomeDirectory']);
    const m = res.ok && res.stdout.match(/NFSHomeDirectory:\s*(.+)/);
    return m ? m[1].trim() : `/Users/${user}`;
  }
  const res = await tryExec('getent', ['passwd', user]);
  const fields = res.ok ? res.stdout.trim().split(':') : [];
  return fields[5] || `/home/${user}`;
}

// The desktop user's GUI settings file, or null if there's no desktop user.
async function guiSettingsPath(platform = process.platform) {
  const home = await userHome(await loginUser(), platform);
  return guiSettingsFile(home, platform);
}

// applyNetwork writes several files; a failure partway leaves the config
// half-switched. It is idempotent, so re-running is the fix.
function switchError(err) {
  return new Error(
    `${err.message}\nThe client's network configuration may be half-written — ` +
      're-run the switch once the cause is fixed.',
  );
}

function requireRoot(what) {
  if (!isRoot()) {
    throw new Error(
      `${what} requires root: the client's files live under system directories and the ` +
        'service must be restarted. Re-run with sudo.',
    );
  }
}

// Reset the machine to the state a fresh client install leaves behind, and
// optionally point it at a different network on the way back up.
// Nothing is backed up on disk — the account's encrypted copy in the database is
// the backup, so callers must confirm before calling this.
// Returns { removed, skipped, applied, manager, started, guiLaunched }.
export async function resetMachine({ config, svc, network, platform = process.platform }) {
  requireRoot('Clearing');

  await stopClient(svc, platform);

  const { removed, skipped } = await resetClientState({
    home: config.home,
    files: config.files,
    platform,
    guiSettingsFile: await guiSettingsPath(platform),
  });

  let applied = null;
  try {
    if (network) applied = await applyNetwork(network, { platform });
  } catch (err) {
    // Don't leave the machine with the client down because the switch failed.
    await startClient(svc, platform).catch(() => {});
    throw switchError(err);
  }

  const { started, guiLaunched } = await startClient(svc, platform);
  return { removed, skipped, applied, manager: svc.manager, started, guiLaunched };
}

// Switch the installed client to another network, keeping the account on disk.
// The GUI's saved exit-node location is cleared: it may name a destination the
// new network doesn't have.
// Returns { applied, removed, manager, started, guiLaunched }.
export async function switchMachineNetwork({ svc, network, platform = process.platform }) {
  requireRoot('Switching networks');

  await stopClient(svc, platform);

  let applied;
  try {
    applied = await applyNetwork(network, { platform });
  } catch (err) {
    await startClient(svc, platform).catch(() => {});
    throw switchError(err);
  }

  const removed = [];
  const settings = await guiSettingsPath(platform);
  if (settings) {
    try {
      await fs.rm(settings, { force: false });
      removed.push(settings);
    } catch {
      // Absent or unreadable — the user can re-pick the location in the app.
    }
  }

  const { started, guiLaunched } = await startClient(svc, platform);
  return { applied, removed, manager: svc.manager, started, guiLaunched };
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

// Write a decrypted blob to disk, or remove any existing file when the account
// doesn't carry that blob. This keeps a swap from leaving a stale file behind:
// e.g. an account saved before its safe existed has no safe_blob, so swapping to
// it must delete the previous account's .safe — otherwise the new EOA is paired
// with the old safe instead of mimicking a freshly installed client.
async function writeOrRemove(file, buf) {
  if (buf != null) {
    await fs.writeFile(file, buf, { mode: 0o600 });
  } else {
    try {
      await fs.unlink(file);
    } catch {
      // Already absent — nothing to remove.
    }
  }
}

// Write the three decrypted blobs to their on-disk locations with tight perms.
// The id always exists; pass/safe are written when present and otherwise cleared
// so the on-disk state exactly matches the target account.
async function writeAccountFiles(files, decrypted) {
  const dir = path.dirname(files.id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(files.id, decrypted.id, { mode: 0o600 });
  await writeOrRemove(files.pass, decrypted.pass);
  await writeOrRemove(files.safe, decrypted.safe);
}

// Perform a full swap: backup -> write new files -> restart.
// `decrypted` = { id, pass, safe } Buffers. Returns { backupDir, manager, guiLaunched }.
//
// We deliberately do NOT pre-stop the service. `restartService` uses
// `launchctl kickstart -k` (and `systemctl restart`), which kills the running
// instance and restarts it — picking up the files we just wrote. An explicit
// `launchctl stop` *before* the kickstart leaves the launchd job in a state it
// doesn't reliably come back from, which is why the standalone restart (kickstart
// only) works but a stop-then-restart left the service down.
export async function swapFiles({ files, decrypted, svc, timestamp }) {
  if (!isRoot()) {
    throw new Error(
      'Swapping requires root: the account files live under a system directory and the ' +
        'service must be restarted. Re-run with sudo.',
    );
  }

  const backupDir = await backupCurrent(files, timestamp);
  await writeAccountFiles(files, decrypted);

  // Always restart: restartService no-ops the service when none is managed but
  // still relaunches the GUI client so it picks up the new on-disk files.
  const { guiLaunched } = await restartService(svc);

  return { backupDir, manager: svc.manager, guiLaunched };
}
