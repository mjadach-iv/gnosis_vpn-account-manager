// The desktop user: whose session the GUI app runs in and, from installer 0.97.0
// on, whose home holds the account — the client runs its worker as that user.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function tryExec(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 15_000 });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// The logged-in (GUI) user. When self-elevated via sudo we're root, so GUI apps
// must be launched into the original user's session, not root's.
export async function loginUser() {
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

// Resolve a user's home directory. We're root after self-elevation, so
// process.env.HOME is root's, not the desktop user's.
export async function userHome(user, platform = process.platform) {
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

// `name` (default: the login user) as { name, uid, gid, home }, or null when
// there is no desktop user to default to.
export async function resolveUser(name, platform = process.platform) {
  const user = name || (await loginUser());
  if (!user) return null;
  const [uid, gid] = await Promise.all([tryExec('id', ['-u', user]), tryExec('id', ['-g', user])]);
  if (!uid.ok || !gid.ok) throw new Error(`Unknown user "${user}".`);
  // The client never runs a worker as uid 0, so root has no account of its own.
  if (Number(uid.stdout) === 0) {
    throw new Error(`"${user}" is root, which never owns a Gnosis VPN account — pass --user <name>.`);
  }
  return { name: user, uid: Number(uid.stdout), gid: Number(gid.stdout), home: await userHome(user, platform) };
}
