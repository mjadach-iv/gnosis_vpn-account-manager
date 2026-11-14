// Cash out a node: close its outgoing channels so their wxHOPR returns to the
// safe, then sweep the safe's and the node's wxHOPR and xDAI to one address.

import {
  concat,
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  encodeFunctionData,
  encodePacked,
  formatEther,
  getAddress,
  http,
  keccak256,
  pad,
  parseAbi,
  toEventSelector,
  zeroAddress,
  zeroHash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { GNOSIS_RPC } from './ctl.js';

// HOPR's own limit. The module returns false instead of reverting, so estimateGas
// could settle on a limit at which the inner call runs out of gas.
const MODULE_TX_GAS = 400_000n;
// Upper bound for the sweeps: two Safe executions, one token transfer, one plain transfer.
const SWEEP_GAS = 2n * 200_000n + 100_000n + 21_000n;
const POLL_MS = 15_000;
const TX_URL = 'https://gnosisscan.io/tx/';

const CHANNELS_ABI = parseAbi([
  'function channels(bytes32 id) view returns (uint96 balance, uint48 ticketIndex, uint32 closureTime, uint24 epoch, uint8 status)',
  'function initiateOutgoingChannelClosureSafe(address selfAddress, address destination)',
  'function finalizeOutgoingChannelClosureSafe(address selfAddress, address destination)',
]);
const STATUS = ['CLOSED', 'OPEN', 'PENDINGTOCLOSE'];
const MODULE_ABI = parseAbi([
  'function execTransactionFromModule(address to, uint256 value, bytes data, uint8 operation) returns (bool)',
]);
const SAFE_ABI = parseAbi([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
]);
const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);
const MODULE_SUCCESS = toEventSelector('ExecutionFromModuleSuccess(address)');

const publicClient = () => createPublicClient({ chain: gnosis, transport: http(GNOSIS_RPC) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export const fmtToken = (wei) => Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 6 });

async function gql(blokliUrl, query) {
  const res = await fetch(`${blokliUrl.replace(/\/+$/, '')}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Blokli ${blokliUrl} answered HTTP ${res.status}.`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`Blokli query failed: ${json.errors[0].message}`);
  return json.data;
}

// Blokli answers each query with a union; any other member is an error.
function unwrap(result, typename, what) {
  if (result?.__typename === typename) return result;
  throw new Error(`Blokli ${what} failed: ${result?.message || result?.__typename || 'no result'}`);
}

const ERRORS = '... on QueryFailedError { message } ... on InvalidAddressError { message }';

// Read from the contract, as Blokli lags behind the closures this tool just sent.
async function channelState(pc, channels, source, destination) {
  const id = keccak256(encodePacked(['address', 'address'], [source, destination]));
  const [balance, , closureTime, , status] = await pc.readContract({
    address: channels,
    abi: CHANNELS_ABI,
    functionName: 'channels',
    args: [id],
  });
  return { balance, closureTime, status: STATUS[status] ?? `unknown (${status})` };
}

async function querySafe(blokliUrl, selector, address) {
  const data = await gql(
    blokliUrl,
    `{ safeBy(selector: ${selector}, address: "${address}") { __typename ... on SafesList { safes { address moduleAddress } } ${ERRORS} } }`,
  );
  return data.safeBy ? unwrap(data.safeBy, 'SafesList', 'safe lookup').safes : [];
}

// Everything a cash-out of `address` on `network` would touch. Read-only.
export async function planCashOut({ address, network, blokliUrl }) {
  const node = getAddress(address);
  const head = await gql(
    blokliUrl,
    `{ chainInfo { __typename ... on ChainInfo { network channelClosureGracePeriod contractAddresses } ... on QueryFailedError { message } }
       accounts(chainKey: "${node.toLowerCase()}") { __typename ... on AccountsList { accounts { keyid safeAddress } } ... on QueryFailedError { message } ... on MissingFilterError { message } } }`,
  );
  const info = unwrap(head.chainInfo, 'ChainInfo', 'chain info');
  if (info.network !== network) {
    throw new Error(`${blokliUrl} serves "${info.network}", not "${network}".`);
  }
  const contracts = JSON.parse(info.contractAddresses);
  const account = unwrap(head.accounts, 'AccountsList', 'account lookup').accounts[0] ?? null;

  // Channels are funded from the safe the node is registered with; without one, the safe it owns.
  const safeRow = account?.safeAddress
    ? (await querySafe(blokliUrl, 'ADDRESS', account.safeAddress))[0]
    : (await querySafe(blokliUrl, 'OWNER', node.toLowerCase()))[0];

  const pc = publicClient();
  const channelsContract = getAddress(contracts.channels);

  // Blokli finds the peers; the contract says which channels are still live.
  let channels = [];
  if (account) {
    const data = await gql(
      blokliUrl,
      `{ channels(sourceKeyId: ${account.keyid}) { __typename ... on ChannelsList { channels { destination } } ${ERRORS} ... on MissingFilterError { message } } }`,
    );
    const keyids = [
      ...new Set(unwrap(data.channels, 'ChannelsList', 'channel lookup').channels.map((c) => c.destination)),
    ];
    if (keyids.length) {
      const peers = await gql(
        blokliUrl,
        `{ ${keyids.map((k) => `k${k}: accounts(keyid: ${k}) { __typename ... on AccountsList { accounts { chainKey } } }`).join(' ')} }`,
      );
      const states = await Promise.all(
        keyids.map(async (k) => {
          const destination = getAddress(unwrap(peers[`k${k}`], 'AccountsList', 'peer lookup').accounts[0].chainKey);
          return { destination, ...(await channelState(pc, channelsContract, node, destination)) };
        }),
      );
      channels = states.filter((c) => c.status !== 'CLOSED');
    }
  }

  const token = getAddress(contracts.token);
  const wxhoprOf = (owner) => pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });
  const [xdai, wxhopr] = await Promise.all([pc.getBalance({ address: node }), wxhoprOf(node)]);

  let safe = null;
  if (safeRow) {
    const addr = getAddress(safeRow.address);
    const [owners, threshold, safeXdai, safeWxhopr] = await Promise.all([
      pc.readContract({ address: addr, abi: SAFE_ABI, functionName: 'getOwners' }),
      pc.readContract({ address: addr, abi: SAFE_ABI, functionName: 'getThreshold' }),
      pc.getBalance({ address: addr }),
      wxhoprOf(addr),
    ]);
    safe = {
      address: addr,
      module: getAddress(safeRow.moduleAddress),
      xdai: safeXdai,
      wxhopr: safeWxhopr,
      sweepable: threshold === 1n && owners.some((o) => same(o, node)),
    };
  }

  // Every module tx at its full limit and max fee: what the node must hold so a
  // run can't strand channels half-closed for want of gas.
  const moduleTxs = channels.reduce((n, c) => n + (c.status === 'OPEN' ? 2n : 1n), 0n);
  const { maxFeePerGas } = await pc.estimateFeesPerGas();

  return {
    network,
    blokliUrl,
    address: node,
    gracePeriod: Number(info.channelClosureGracePeriod),
    contracts: { channels: channelsContract, token },
    safe,
    channels,
    balances: { xdai, wxhopr },
    gasNeeded: (moduleTxs * MODULE_TX_GAS + SWEEP_GAS) * maxFeePerGas,
  };
}

// Prints in place on a terminal, so the grace-period countdown doesn't scroll.
function reporter(out = process.stdout) {
  let inline = false;
  return {
    log(msg) {
      if (inline) out.write('\n');
      inline = false;
      console.log(msg);
    },
    progress(msg) {
      if (!out.isTTY) return this.log(msg);
      out.write(`\r\x1b[2K${msg}`);
      inline = true;
    },
  };
}

// Close every channel in `plan`, wait out the grace period, finalize them, then
// send all wxHOPR and xDAI of the safe and the node to `recipient`.
export async function executeCashOut({ plan, privateKey, recipient }) {
  const account = privateKeyToAccount(privateKey);
  if (!same(account.address, plan.address)) {
    throw new Error(`The decrypted key belongs to ${account.address}, not ${plan.address}.`);
  }
  if (plan.channels.length && !plan.safe) {
    throw new Error('The node has channels but Blokli knows no safe for it — cannot close them.');
  }
  const out = reporter();
  const pc = publicClient();
  const wallet = createWalletClient({ account, chain: gnosis, transport: http(GNOSIS_RPC) });
  const to = getAddress(recipient);

  const send = async (label, tx) => {
    const hash = await wallet.sendTransaction(tx);
    out.log(`  ${label}: ${TX_URL}${hash}`);
    const receipt = await pc.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${label} reverted: ${TX_URL}${hash}`);
    return receipt;
  };
  const withGasBuffer = async (tx) => ({
    ...tx,
    gas: ((await pc.estimateGas({ account: account.address, ...tx })) * 6n) / 5n,
  });

  const viaModule = (fn, destination) => ({
    to: plan.safe.module,
    gas: MODULE_TX_GAS,
    data: encodeFunctionData({
      abi: MODULE_ABI,
      functionName: 'execTransactionFromModule',
      args: [
        plan.contracts.channels,
        0n,
        encodeFunctionData({ abi: CHANNELS_ABI, functionName: fn, args: [account.address, destination] }),
        0,
      ],
    }),
  });
  const moduleWouldSucceed = async (tx) => {
    try {
      const { data } = await pc.call({ account: account.address, ...tx });
      return decodeFunctionResult({ abi: MODULE_ABI, functionName: 'execTransactionFromModule', data });
    } catch {
      return false;
    }
  };
  const sendViaModule = async (label, tx) => {
    const receipt = await send(label, tx);
    const ok = receipt.logs.some(
      (l) => same(l.address, plan.safe.address) && l.topics[0] === MODULE_SUCCESS,
    );
    if (!ok) throw new Error(`${label} failed inside the safe: ${TX_URL}${receipt.transactionHash}`);
  };

  const pending = [];
  let readyAt = 0;
  for (const { destination } of plan.channels) {
    const state = await channelState(pc, plan.contracts.channels, account.address, destination);
    if (state.status === 'PENDINGTOCLOSE') {
      readyAt = Math.max(readyAt, state.closureTime);
    } else if (state.status === 'OPEN') {
      const tx = viaModule('initiateOutgoingChannelClosureSafe', destination);
      if (!(await moduleWouldSucceed(tx))) {
        throw new Error(`Closing the channel to ${destination} would fail — nothing sent for it.`);
      }
      await sendViaModule(`Closing channel to ${destination} (${fmtToken(state.balance)} wxHOPR)`, tx);
      // Not re-read: a lagging RPC backend could still report it open.
      readyAt = Math.max(readyAt, Number((await pc.getBlock()).timestamp) + plan.gracePeriod);
    } else {
      continue;
    }
    pending.push(destination);
  }

  const giveUpAt = readyAt + plan.gracePeriod + 120;
  let closed = 0;
  while (pending.length) {
    const now = Number((await pc.getBlock()).timestamp);
    if (now <= readyAt) {
      const left = readyAt - now + 1;
      out.progress(`  Waiting out the channel closure grace period: ${Math.floor(left / 60)}m ${left % 60}s left`);
      await sleep(Math.min(POLL_MS, left * 1000));
      continue;
    }
    for (const destination of [...pending]) {
      const tx = viaModule('finalizeOutgoingChannelClosureSafe', destination);
      if (!(await moduleWouldSucceed(tx))) continue;
      await sendViaModule(`Finalizing channel to ${destination}`, tx);
      pending.splice(pending.indexOf(destination), 1);
      closed += 1;
    }
    if (!pending.length) break;
    if (now > giveUpAt) {
      throw new Error(
        `Could not finalize the channels to ${pending.join(', ')} — run the cash-out again later to finish them.`,
      );
    }
    out.progress('  Waiting for the chain to accept the finalization…');
    await sleep(POLL_MS);
  }

  const sent = { wxhopr: 0n, xdai: 0n };
  const wxhoprOf = (owner) =>
    pc.readContract({ address: plan.contracts.token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });
  const transferData = (amount) =>
    encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, amount] });

  if (plan.safe?.sweepable) {
    // Pre-validated owner signature: valid because the safe's 1-of-1 owner sends the tx itself.
    const ownerSig = concat([pad(account.address, { size: 32 }), zeroHash, '0x01']);
    const viaSafe = (target, value, data) => ({
      to: plan.safe.address,
      data: encodeFunctionData({
        abi: SAFE_ABI,
        functionName: 'execTransaction',
        args: [target, value, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, ownerSig],
      }),
    });
    const safeWxhopr = await wxhoprOf(plan.safe.address);
    if (safeWxhopr > 0n) {
      await send(
        `Sending ${fmtToken(safeWxhopr)} wxHOPR from the safe`,
        await withGasBuffer(viaSafe(plan.contracts.token, 0n, transferData(safeWxhopr))),
      );
      sent.wxhopr += safeWxhopr;
    }
    const safeXdai = await pc.getBalance({ address: plan.safe.address });
    if (safeXdai > 0n) {
      await send(`Sending ${fmtToken(safeXdai)} xDAI from the safe`, await withGasBuffer(viaSafe(to, safeXdai, '0x')));
      sent.xdai += safeXdai;
    }
  } else if (plan.safe) {
    out.log(`  ⚠  Safe ${plan.safe.address} not swept: the node is not its only required signer.`);
  }

  const nodeWxhopr = await wxhoprOf(account.address);
  if (nodeWxhopr > 0n) {
    await send(
      `Sending ${fmtToken(nodeWxhopr)} wxHOPR from the node`,
      await withGasBuffer({ to: plan.contracts.token, data: transferData(nodeWxhopr) }),
    );
    sent.wxhopr += nodeWxhopr;
  }

  // Last, as every step above pays gas from it. Legacy pricing charges exactly
  // gas × gasPrice, so nothing is held back as EIP-1559 fee headroom; the price
  // is doubled so a base-fee rise can't leave the tx stuck.
  const gasPrice = (await pc.getGasPrice()) * 2n;
  const gas = await pc.estimateGas({ account: account.address, to, value: 1n });
  const value = (await pc.getBalance({ address: account.address })) - gas * gasPrice;
  if (value > 0n) {
    await send(`Sending ${fmtToken(value)} xDAI from the node`, { to, value, gas, gasPrice, type: 'legacy' });
    sent.xdai += value;
  } else {
    out.log('  Node xDAI does not cover the transfer fee — left in place.');
  }

  return { closed, sent };
}
