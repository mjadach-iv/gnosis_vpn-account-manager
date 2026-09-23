#!/usr/bin/env node
// Gnosis VPN Account Manager — CLI entry point.

import { Command } from 'commander';
import { input, select, confirm } from '@inquirer/prompts';
import { loadConfig } from './config.js';
import { encrypt, decrypt } from './crypto.js';
import * as db from './db.js';
import { readCurrentAccount } from './account.js';
import {
  detectNetwork,
  networkFromUrl,
  installedNetworks,
  KNOWN_NETWORKS,
} from './network.js';
import {
  detectService,
  swapFiles,
  resetMachine,
  switchMachineNetwork,
  restartService,
} from './service.js';
import { SERVICE_CONFIG_DIR } from './paths.js';
import { chainBalances } from './ctl.js';
import { accountMenu } from './menu.js';
import { ensureRoot } from './elevate.js';

// --- helpers ---------------------------------------------------------------

function fmtAddr(a) {
  return a || '(unknown)';
}

function printAccount(label, acc) {
  console.log(`\n${label}`);
  console.log(`  EOA address : ${fmtAddr(acc.address)}`);
  console.log(`  Safe address: ${fmtAddr(acc.safe)}`);
  console.log(`  Network     : ${acc.network || '(undetected)'}`);
  if (acc.blokliUrl) console.log(`  Blokli URL  : ${acc.blokliUrl}`);
  if (acc.balances) {
    console.log(`  xDAI  (EOA) : ${acc.balances.xdai ?? '(unknown)'}`);
    console.log(`  wxHOPR(Safe): ${acc.balances.wxhopr ?? '(unknown)'}`);
  }
  if (acc.eoaSource === 'override') console.log('  (EOA supplied manually — service was unreachable)');
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Compact balance string for inline display (trims to 4 decimals).
function fmtBal(s) {
  if (s == null) return '?';
  const n = Number(s);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : s;
}

const OTHER_NETWORK = '__other__';

// Resolve a network value, prompting/mapping as needed.
async function resolveNetwork(acc, optNetwork) {
  if (optNetwork) return optNetwork;
  if (acc.network) return acc.network;
  if (acc.blokliUrl) {
    const mapped = networkFromUrl(acc.blokliUrl);
    if (mapped) return mapped;
  }
  const picked = await select({
    message: 'Network could not be detected. Which network is this account for?',
    choices: [
      ...KNOWN_NETWORKS.map((n) => ({ name: n, value: n })),
      { name: 'other (type a name)…', value: OTHER_NETWORK },
    ],
  });
  if (picked !== OTHER_NETWORK) return picked;
  const typed = await input({ message: 'Network name:' });
  return typed.trim().toLowerCase() || null;
}

// Prompt for a network to configure the client with. Offers the networks
// actually installed on this machine (the only ones the client can load),
// falling back to the known names when the config dir can't be read.
async function pickNetwork({ current, message } = {}) {
  const installed = await installedNetworks();
  if (!installed.length) {
    console.log(
      `\n⚠  Could not read ${SERVICE_CONFIG_DIR} — offering the known networks rather than the ` +
        'ones installed here. Picking one that is not installed will fail.',
    );
  }
  const names = installed.length ? installed : KNOWN_NETWORKS;

  const picked = await select({
    message: message || 'Which network should the client use?',
    choices: [
      ...names.map((n) => ({ name: n === current ? `${n}  (current)` : n, value: n })),
      { name: 'other (type a name)…', value: OTHER_NETWORK },
    ],
  });
  if (picked !== OTHER_NETWORK) return picked;
  const typed = await input({ message: 'Network name:' });
  return typed.trim().toLowerCase() || null;
}

// Report what a reset / switch did.
function printMachineResult({ removed, skipped, applied, manager, started, guiLaunched }, svc) {
  if (removed?.length) {
    console.log(`  Removed ${removed.length} item(s):`);
    for (const p of removed) console.log(`    - ${p}`);
  }
  if (applied) {
    console.log(`  Network     : ${applied.network}`);
    console.log(`  Blokli URL  : ${applied.blokliUrl}`);
    for (const p of applied.changed) console.log(`    wrote ${p}`);
  }
  if (started) console.log(`  Service (${manager}) started: ${svc.name}`);
  if (guiLaunched) console.log('  GUI client app relaunched.');
  if (!manager && !guiLaunched) {
    console.log(
      '\n⚠  Neither a service nor the GUI app could be started automatically. ' +
        'Start the Gnosis VPN client manually.',
    );
  }
  if (skipped?.length) {
    console.log('\n⚠  Could not remove:');
    for (const s of skipped) console.log(`    - ${s.path} (${s.reason})`);
  }
}

// Save the given on-disk account to the DB. Returns { id, created }.
async function saveAccount(pool, config, acc, { name, network } = {}) {
  if (!acc.address) {
    throw new Error(
      'Cannot save: the EOA address is unknown (the service was unreachable and no --eoa given).',
    );
  }

  const existing = await db.findByAddress(pool, acc.address);
  if (existing) {
    // The account may have been saved before its safe was created. If the
    // on-disk account now carries a safe the stored row lacks (or differs),
    // sync it so the DB matches the current account info — otherwise it keeps
    // displaying a stale/empty safe and a wrong wxHOPR balance.
    if (acc.safe && acc.safe !== existing.safe) {
      const updates = { safe: acc.safe };
      if (acc.files.safe) updates.safe_blob = encrypt(acc.files.safe, config.encryptionKey);
      await db.updateAccount(pool, existing.id, updates);
      return { id: existing.id, created: false, updated: true };
    }
    return { id: existing.id, created: false };
  }

  const defaultName = `Account #${(await db.countAccounts(pool)) + 1}`;
  const accName = name || (await input({ message: 'Name for this account:', default: defaultName }));
  const net = await resolveNetwork(acc, network);

  const id = await db.insertAccount(pool, {
    name: accName,
    address: acc.address,
    safe: acc.safe,
    network: net,
    blokli_url: acc.blokliUrl,
    id_blob: encrypt(acc.files.id, config.encryptionKey),
    pass_blob: acc.files.pass ? encrypt(acc.files.pass, config.encryptionKey) : null,
    safe_blob: acc.files.safe ? encrypt(acc.files.safe, config.encryptionKey) : null,
  });
  return { id, created: true };
}

// Perform a swap to the saved account row `target`.
async function doSwap(pool, config, target, { serviceName } = {}) {
  // Refuse if it's already the active account.
  const current = await readCurrentAccount(config, { serviceName });
  if (current && current.address && target.address && current.address === target.address) {
    console.log(`Account ${target.id} (${target.name}) is already active. Nothing to do.`);
    return;
  }

  const decrypted = {
    id: decrypt(target.id_blob, config.encryptionKey),
    pass: target.pass_blob ? decrypt(target.pass_blob, config.encryptionKey) : null,
    safe: target.safe_blob ? decrypt(target.safe_blob, config.encryptionKey) : null,
  };

  const svc = await detectService({ serviceName });

  // No account on disk => we're inserting one, not swapping from an existing one.
  const inserting = !current;

  const { backupDir, manager, guiLaunched } = await swapFiles({
    files: config.files,
    decrypted,
    svc,
    timestamp: nowStamp(),
  });

  console.log(`\n✔ ${inserting ? 'Inserted' : 'Swapped to'} account ${target.id} (${target.name}).`);
  if (!inserting) console.log(`  Previous files backed up to: ${backupDir}`);
  if (manager) console.log(`  Service (${manager}) restarted: ${svc.name}`);
  if (guiLaunched) console.log('  GUI client app relaunched.');
  if (!manager && !guiLaunched) {
    console.log(
      '\n⚠  Neither a service nor the GUI app could be restarted automatically. ' +
        'Restart the Gnosis VPN client manually for the change to take effect.',
    );
  }

  // Warn if stored network differs from the service's detected network.
  const { network: detected } = await detectNetwork({ serviceName });
  if (detected && target.network && detected !== target.network) {
    console.log(
      `\n⚠  Network mismatch: account is for "${target.network}" but the service is ` +
        `configured for "${detected}". You may need to reconfigure the client.`,
    );
  }
}

function accountsTable(rows) {
  if (!rows.length) return '(no saved accounts)';
  const header = ['id', 'name', 'eoa', 'safe', 'network', 'time_added'];
  const lines = rows.map((r) => [
    String(r.id),
    r.name || '',
    r.address || '',
    r.safe || '',
    r.network || '',
    r.time_added ? new Date(r.time_added).toISOString() : '',
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...lines.map((l) => l[i].length)),
  );
  const fmtRow = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [fmtRow(header), fmtRow(widths.map((w) => '-'.repeat(w))), ...lines.map(fmtRow)].join('\n');
}

// Wrap a command body with config + pool lifecycle.
async function withPool(opts, fn) {
  const config = loadConfig({ envPath: opts.env });
  const pool = await db.connect(config.mysql);
  try {
    return await fn(config, pool);
  } finally {
    await pool.end();
  }
}

// --- interactive default flow ---------------------------------------------

const CLEAR_ACTION = '__clear__';
const CLEAR_SWITCH_ACTION = '__clear_switch__';
const SWITCH_ACTION = '__switch__';
const RESTART_ACTION = '__restart__';
const REFRESH_ACTION = '__refresh__';

// Restart the Gnosis VPN service / app.
async function restartApp({ serviceName } = {}) {
  const svc = await detectService({ serviceName });
  const { serviceRestarted, guiLaunched } = await restartService(svc);
  if (!serviceRestarted && !guiLaunched) {
    console.log('\n⚠  Could not restart Gnosis VPN — no service unit or GUI app found.');
    return;
  }
  const parts = [];
  if (serviceRestarted) parts.push(`service (${svc.manager}: ${svc.name})`);
  if (guiLaunched) parts.push('GUI app');
  console.log(`\n✔ Restarted Gnosis VPN: ${parts.join(' + ')}.`);
}

// Reset this machine to a freshly-installed client state, optionally switching
// the network on the way back up. `switchNetwork` is either a network name or
// `true` to prompt for one.
async function clearMachine(config, pool, { serviceName, switchNetwork } = {}) {
  const acc = await readCurrentAccount(config, { serviceName });
  if (!acc && !switchNetwork) {
    console.log('No account on disk to clear.');
    return;
  }

  let target = null;
  if (switchNetwork) {
    target =
      typeof switchNetwork === 'string'
        ? switchNetwork
        : await pickNetwork({ current: acc?.network, message: 'Switch the client to which network?' });
    if (!target) {
      console.log('No network chosen — nothing done.');
      return;
    }
  }

  const who = acc ? acc.address || 'unknown EOA' : 'no account on disk';
  const ok = await confirm({
    message:
      `Reset this machine to a freshly-installed client state (${who})` +
      `${target ? ` and switch to "${target}"` : ''}? ` +
      'The identity, node database, caches and logs are deleted, not backed up.',
    default: false,
  });
  if (!ok) return;

  // Nothing is kept on disk, so the encrypted copy in the database is the only
  // way back. Make an unsaved account an explicit, typed decision.
  if (acc?.address) {
    const saved = await db.findByAddress(pool, acc.address);
    if (!saved) {
      const answer = await input({
        message:
          `⚠  ${acc.address} is NOT saved in the database and cannot be recovered afterwards. ` +
          'Type "Yes" to delete it anyway:',
      });
      if (answer.trim().toLowerCase() !== 'yes') {
        console.log('Cancelled — nothing was removed.');
        return;
      }
    }
  }

  const svc = await detectService({ serviceName });
  const result = await resetMachine({ config, svc, network: target });

  console.log(
    `\n✔ Reset this machine to a freshly-installed client state${target ? ` on "${target}"` : ''}.`,
  );
  printMachineResult(result, svc);
  console.log('  The client will generate a fresh identity on start-up.');
}

// Point the installed client at another network, keeping the account on disk.
async function switchNetworkOnMachine({ serviceName, network } = {}) {
  const { network: current } = await detectNetwork({ serviceName });
  const target =
    network ||
    (await pickNetwork({ current, message: 'Switch the client to which network?' }));
  if (!target) {
    console.log('No network chosen — nothing done.');
    return;
  }
  if (target === current) {
    console.log(`The client is already configured for "${target}". Nothing to do.`);
    return;
  }

  const ok = await confirm({
    message:
      `Switch the client from "${current || 'unknown'}" to "${target}"? ` +
      'The account on disk is kept — its safe and node database belong to the old network, ' +
      'so clearing the account as well is usually the right move.',
    default: false,
  });
  if (!ok) return;

  const svc = await detectService({ serviceName });
  const result = await switchMachineNetwork({ svc, network: target });

  console.log(`\n✔ Switched the client to "${target}".`);
  printMachineResult(result, svc);
}

// Wait for Enter, then redraw the screen for the next menu iteration.
async function pause() {
  await input({ message: 'Press Enter to return to the menu…' });
}

async function interactive(config, pool, { serviceName } = {}) {
  // EOA addresses the user chose not to save this session — so we don't
  // re-prompt for the same account on every screen redraw.
  const skipped = new Set();

  // Each iteration redraws the original screen (current account + menu).
  for (;;) {
    console.clear();

    const acc = await readCurrentAccount(config, { serviceName, withBalances: true });
    if (!acc) {
      console.log('No account currently in use (no identity file on disk).');
    } else {
      printAccount('Current account:', acc);
      if (acc.address) {
        const existing = await db.findByAddress(pool, acc.address);
        if (!existing && skipped.has(acc.address)) {
          console.log('Not saved — skipped this session.');
        } else if (!existing) {
          const wantSave = await confirm({
            message: 'Save this account to the database?',
            default: true,
          });
          if (wantSave) {
            const { id, created } = await saveAccount(pool, config, acc, {});
            console.log(created ? `Saved as account #${id}.` : `Already saved as account #${id}.`);
          } else {
            skipped.add(acc.address);
            console.log('Not saved — skipped this session.');
          }
        } else {
          // Already stored: let saveAccount sync the safe address if it changed.
          const { id, updated } = await saveAccount(pool, config, acc, {});
          console.log(
            updated
              ? `Updated account #${id} (safe address synced).`
              : `Already saved as account #${id}.`,
          );
        }
      } else {
        console.log('Skipping save — EOA unknown (start the service or use `save --eoa`).');
      }
    }

    const rows = await db.listAccounts(pool);

    // Fetch on-chain balances for every saved account in parallel, to show inline.
    const balances = await Promise.all(
      rows.map((r) => chainBalances({ eoa: r.address, safe: r.safe })),
    );

    const choices = [];
    if (acc) {
      choices.push({
        name: '🗑  Clear current account from this machine',
        value: CLEAR_ACTION,
        deletable: false,
      });
      choices.push({
        name: '🔀  Clear account and switch network',
        value: CLEAR_SWITCH_ACTION,
        deletable: false,
      });
    }
    choices.push({
      name: '🌐  Switch network (keep the account)',
      value: SWITCH_ACTION,
      deletable: false,
    });
    choices.push(
      ...rows.map((r, i) => ({
        name:
          `#${r.id}  ${r.name}  ${r.address}  [${r.network || '?'}]  ` +
          `xDAI ${fmtBal(balances[i].xdai)} | wxHOPR ${fmtBal(balances[i].wxhopr)}`,
        value: r.id,
        accountName: r.name,
        deletable: true,
      })),
    );
    choices.push({ name: '🔄  Restart the Gnosis VPN', value: RESTART_ACTION, deletable: false });
    choices.push({ name: '♻️  Refresh accounts (refetch from DB and disk)', value: REFRESH_ACTION, deletable: false });
    choices.push({ name: '🚪  Exit', value: null, deletable: false });

    const res = await accountMenu({ message: 'Choose an action:', choices });

    if (res.value == null) return; // exit

    // Refresh: skip the pause and loop, re-reading disk + DB on the next pass.
    if (res.value === REFRESH_ACTION) continue;

    if (res.value === RESTART_ACTION) {
      await restartApp({ serviceName });
    } else if (res.action === 'delete') {
      // Del/Backspace on a saved account: confirm by typing "Yes", then delete.
      const answer = await input({
        message: `Type "Yes" to permanently delete account #${res.value} from the database:`,
      });
      if (answer.trim().toLowerCase() === 'yes') {
        await db.deleteAccount(pool, res.value);
        console.log(`✔ Deleted account #${res.value} from the database.`);
      } else {
        console.log('Deletion cancelled.');
      }
    } else if (res.action === 'rename') {
      // `r` on a saved account: prompt for a new name and update the DB.
      const newName = await input({
        message: `New name for account #${res.value}:`,
        default: res.accountName,
      });
      const trimmed = newName.trim();
      if (trimmed && trimmed !== res.accountName) {
        await db.updateAccount(pool, res.value, { name: trimmed });
        console.log(`✔ Renamed account #${res.value} to "${trimmed}".`);
      } else {
        console.log('Rename cancelled.');
      }
    } else if (res.value === CLEAR_ACTION) {
      await clearMachine(config, pool, { serviceName });
    } else if (res.value === CLEAR_SWITCH_ACTION) {
      await clearMachine(config, pool, { serviceName, switchNetwork: true });
    } else if (res.value === SWITCH_ACTION) {
      await switchNetworkOnMachine({ serviceName });
    } else {
      const target = await db.getAccountById(pool, res.value);
      const verb = acc ? 'Swap to' : 'Insert';
      const ok = await confirm({ message: `${verb} "${target.name}" (${target.address})?` });
      if (ok) await doSwap(pool, config, target, { serviceName });
    }

    await pause(); // show the action's output, then redraw on the next loop
  }
}

// --- CLI -------------------------------------------------------------------

const program = new Command();
program
  .name('gvpn-accounts')
  .description('Manage and swap Gnosis VPN accounts (HOPR identities), backed by MySQL.')
  .option('--env <path>', 'path to the .env file', '.env')
  .option('--service <name>', 'service unit/label to control');

program
  .command('current')
  .description('print the active on-disk account')
  .action(async () => {
    ensureRoot();
    const opts = program.opts();
    const config = loadConfig({ envPath: opts.env });
    const acc = await readCurrentAccount(config, { serviceName: opts.service, withBalances: true });
    if (!acc) {
      console.log('No account currently in use (no identity file on disk).');
      return;
    }
    printAccount('Current account:', acc);
  });

program
  .command('list')
  .description('list saved accounts')
  .action(async () => {
    const opts = program.opts();
    await withPool(opts, async (config, pool) => {
      const rows = await db.listAccounts(pool);
      console.log(accountsTable(rows));
    });
  });

program
  .command('save')
  .description('save the current on-disk account to the DB')
  .option('--name <name>', 'account name')
  .option('--network <network>', `network (${KNOWN_NETWORKS.join('|')})`)
  .option('--eoa <address>', 'EOA address (used if the service is unreachable)')
  .action(async (cmdOpts) => {
    ensureRoot();
    const opts = program.opts();
    await withPool(opts, async (config, pool) => {
      const acc = await readCurrentAccount(config, {
        serviceName: opts.service,
        eoaOverride: cmdOpts.eoa,
        withBalances: true,
      });
      if (!acc) {
        console.log('No account currently in use (no identity file on disk).');
        return;
      }
      printAccount('Current account:', acc);
      const { id, created, updated } = await saveAccount(pool, config, acc, {
        name: cmdOpts.name,
        network: cmdOpts.network,
      });
      console.log(
        created
          ? `\n✔ Saved as account #${id}.`
          : updated
            ? `\n✔ Updated account #${id} (safe address synced).`
            : `\nAlready saved as account #${id}.`,
      );
    });
  });

program
  .command('swap')
  .description('swap to a saved account by id')
  .argument('<id>', 'account id')
  .action(async (id) => {
    ensureRoot();
    const opts = program.opts();
    await withPool(opts, async (config, pool) => {
      const target = await db.getAccountById(pool, Number(id));
      if (!target) {
        console.error(`No account with id ${id}.`);
        process.exitCode = 1;
        return;
      }
      await doSwap(pool, config, target, { serviceName: opts.service });
    });
  });

program
  .command('clear')
  .description('reset this machine to a freshly-installed client state')
  .option('--switch-network <network>', 'also point the client at this network')
  .action(async (cmdOpts) => {
    ensureRoot();
    const opts = program.opts();
    await withPool(opts, (config, pool) =>
      clearMachine(config, pool, {
        serviceName: opts.service,
        switchNetwork: cmdOpts.switchNetwork,
      }),
    );
  });

program
  .command('switch-network')
  .description('point the installed client at another network (keeps the account)')
  .argument('[network]', 'network name; prompts when omitted')
  .action(async (network) => {
    ensureRoot();
    const opts = program.opts();
    await switchNetworkOnMachine({ serviceName: opts.service, network });
  });

// Default action (no subcommand) = interactive flow.
program.action(async () => {
  ensureRoot();
  const opts = program.opts();
  await withPool(opts, (config, pool) => interactive(config, pool, { serviceName: opts.service }));
});

program.parseAsync(process.argv).catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exitCode = 1;
});
