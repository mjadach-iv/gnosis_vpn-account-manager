#!/usr/bin/env node
// Gnosis VPN Account Manager — CLI entry point.

import { Command } from 'commander';
import { input, select, confirm } from '@inquirer/prompts';
import { loadConfig } from './config.js';
import { encrypt, decrypt } from './crypto.js';
import * as db from './db.js';
import { readCurrentAccount } from './account.js';
import { detectNetwork, networkFromUrl } from './network.js';
import { detectService, swapFiles, clearFiles, restartService } from './service.js';
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

// Resolve a network value, prompting/mapping as needed.
async function resolveNetwork(acc, optNetwork) {
  if (optNetwork) return optNetwork;
  if (acc.network) return acc.network;
  if (acc.blokliUrl) {
    const mapped = networkFromUrl(acc.blokliUrl);
    if (mapped) return mapped;
  }
  return select({
    message: 'Network could not be detected. Which network is this account for?',
    choices: [
      { name: 'rotsee', value: 'rotsee' },
      { name: 'jura', value: 'jura' },
    ],
  });
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
  if (!svc.manager) {
    console.log(
      '\n⚠  No service manager detected — writing account files only. ' +
        'Restart the Gnosis VPN client manually for the change to take effect.',
    );
  }

  // No account on disk => we're inserting one, not swapping from an existing one.
  const inserting = !current;

  const { backupDir, manager } = await swapFiles({
    files: config.files,
    decrypted,
    svc,
    timestamp: nowStamp(),
  });

  console.log(`\n✔ ${inserting ? 'Inserted' : 'Swapped to'} account ${target.id} (${target.name}).`);
  if (!inserting) console.log(`  Previous files backed up to: ${backupDir}`);
  if (manager) console.log(`  Service (${manager}) restarted: ${svc.name}`);

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
const RESTART_ACTION = '__restart__';
const REFRESH_ACTION = '__refresh__';

// Restart the Gnosis VPN service / app.
async function restartApp({ serviceName } = {}) {
  const svc = await detectService({ serviceName });
  if (!svc.manager) {
    console.log('\n⚠  No service manager detected — cannot restart automatically.');
    return;
  }
  await restartService(svc);
  console.log(`\n✔ Restarted the Gnosis VPN service (${svc.manager}): ${svc.name}.`);
}

// Remove the current on-disk account from this machine (with confirmation).
async function clearMachine(config, { serviceName } = {}) {
  const acc = await readCurrentAccount(config, { serviceName });
  if (!acc) {
    console.log('No account on disk to clear.');
    return;
  }
  const ok = await confirm({
    message: `Remove the current account (${acc.address || 'unknown EOA'}) from this machine? ` +
      'Files are backed up first.',
    default: false,
  });
  if (!ok) return;

  const svc = await detectService({ serviceName });
  const { backupDir, manager } = await clearFiles({
    files: config.files,
    svc,
    timestamp: nowStamp(),
  });
  console.log('\n✔ Cleared the account from this machine.');
  console.log(`  Files backed up to: ${backupDir}`);
  if (manager) {
    console.log(`  Service (${manager}) restarted: ${svc.name} — the client will regenerate a fresh identity.`);
  }
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
    }
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
    choices.push({ name: '🔄  Restart the Gnosis VPN service', value: RESTART_ACTION, deletable: false });
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
      await clearMachine(config, { serviceName });
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
  .option('--network <network>', 'network (jura|rotsee)')
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
