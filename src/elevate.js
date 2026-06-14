// Self-elevate to root on POSIX so the tool can read/write the root-owned
// Gnosis VPN account files under $GNOSISVPN_HOME/.config/.
//
// If we're not already root, re-exec the *same* process under `sudo`, inheriting
// the terminal so sudo can prompt for the password, then exit with sudo's status.

import { spawnSync } from 'node:child_process';

export function ensureRoot() {
  // No uid concept on Windows; nothing to elevate.
  if (process.platform === 'win32') return;
  if (typeof process.getuid !== 'function' || process.getuid() === 0) return;
  // Backstop against an elevation loop if sudo runs but doesn't grant root.
  if (process.env.GVPN_ELEVATED === '1') return;

  // Under pkg, the binary *is* process.execPath and argv = [bin, snapshot, ...args].
  // Under plain node, argv = [node, script, ...args] — re-exec node with the script.
  const isPkg = typeof process.pkg !== 'undefined';
  const targetArgs = isPkg ? process.argv.slice(2) : process.argv.slice(1);

  const res = spawnSync('sudo', [process.execPath, ...targetArgs], {
    stdio: 'inherit',
    env: { ...process.env, GVPN_ELEVATED: '1' },
  });
  if (res.error) {
    console.error(`Failed to elevate via sudo: ${res.error.message}`);
    process.exit(1);
  }
  process.exit(res.status ?? 0);
}
