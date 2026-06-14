// Wrapper around the installed `gnosis_vpn-ctl` CLI.
//
// `gnosis_vpn-ctl --output json balance` returns (among other things):
//   { "info": { "node_address": "0x..", "safe_address": "0x.." } }
// The service must be running for this to succeed.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CTL_BIN = process.env.GNOSISVPN_CTL_BIN || 'gnosis_vpn-ctl';

// Returns { nodeAddress, safeAddress } or null if ctl is unavailable/unreachable.
export async function balance() {
  try {
    const { stdout } = await execFileAsync(CTL_BIN, ['--output', 'json', 'balance'], {
      timeout: 15_000,
    });
    const parsed = JSON.parse(stdout);
    const info = parsed?.info || {};
    if (!info.node_address) return null;
    return {
      nodeAddress: info.node_address,
      safeAddress: info.safe_address || null,
    };
  } catch {
    // Binary missing, service down, or unparseable output — caller falls back.
    return null;
  }
}

// --- On-chain balances (Gnosis chain) --------------------------------------
//
// The EOA's native xDAI and the safe's wxHOPR aren't in the ctl output, so we
// read them straight from a Gnosis RPC endpoint. Override the endpoint with
// GNOSIS_RPC_URL.

const GNOSIS_RPC = process.env.GNOSIS_RPC_URL || 'https://rpc.gnosischain.com';
export const WXHOPR_TOKEN = '0xD4fdec44DB9D44B8f2b6d529620f9C0C7066A2c1';
const ERC20_DECIMALS = 18; // wxHOPR (and xDAI) both use 18 decimals

async function rpc(method, params) {
  const res = await fetch(GNOSIS_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'RPC error');
  return json.result;
}

// Format a base-unit bigint as a decimal string with `decimals` places, trimmed.
function formatUnits(raw, decimals) {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// ABI-encode balanceOf(address): selector + 32-byte left-padded address.
function encodeBalanceOf(addr) {
  return '0x70a08231' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

// Returns { xdai, wxhopr } as decimal strings (or null per field on failure).
//   xdai   = native balance of `eoa`
//   wxhopr = wxHOPR (WXHOPR_TOKEN) balance of `safe`
export async function chainBalances({ eoa, safe } = {}) {
  const out = { xdai: null, wxhopr: null };
  try {
    if (eoa) out.xdai = formatUnits(BigInt(await rpc('eth_getBalance', [eoa, 'latest'])), 18);
  } catch {
    // leave xdai null on RPC/parse failure
  }
  try {
    if (safe) {
      const hex = await rpc('eth_call', [{ to: WXHOPR_TOKEN, data: encodeBalanceOf(safe) }, 'latest']);
      out.wxhopr = formatUnits(BigInt(hex), ERC20_DECIMALS);
    }
  } catch {
    // leave wxhopr null on RPC/parse failure
  }
  return out;
}
