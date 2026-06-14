# Gnosis VPN Account Manager

A standalone Node.js CLI for managing multiple Gnosis VPN **accounts** (HOPR identities) on a single
machine and swapping the active one on demand. Encrypted account files are stored in MySQL so they
can be restored later.

This tool does **not** modify the Gnosis VPN client. It interacts with the *installed* client through
three external interfaces only:

1. **On-disk account files** under `$GNOSISVPN_HOME/.config/`:
   - `gnosisvpn-hopr.id` — encrypted HOPR identity
   - `gnosisvpn-hopr.pass` — identity password
   - `gnosisvpn-hopr.safe` — YAML with `safe_address` + `module_address`
2. **The `gnosis_vpn-ctl` CLI** — `gnosis_vpn-ctl --output json balance` for the node EOA + safe.
3. **The service manager** — systemd (Linux) / launchd (macOS) to stop/start the client.

`$GNOSISVPN_HOME` defaults: Linux `/var/lib/gnosisvpn`, macOS `/Library/Application Support/GnosisVPN`.

## Install

```sh
npm install
```

## Configure

Copy `.env.example` to `.env` and fill in your MySQL credentials and an encryption key:

```sh
cp .env.example .env
# edit .env
```

Or point at an existing `.env` with `--env <path>`.

## Build standalone binaries

The CLI can be packaged into a single self-contained executable (no Node.js
required on the target machine). The build bundles the source + dependencies
with esbuild, then packages them with [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg).

```sh
npm install          # installs build tooling (esbuild, pkg)

npm run build        # all targets: linux x64/arm64, macOS arm64
scripts/build.sh host                       # just the current platform
scripts/build.sh node22-linux-x64           # one or more explicit targets
```

Output binaries land in `dist/bin/`, e.g. `gvpn-accounts-linux-x64`,
`gvpn-accounts-macos-arm64`.

```sh
sudo ./gvpn-accounts-linux-x64 swap 3
```

### Baked-in config

At build time the `.env` is **baked into each binary**: the MySQL credentials
are encrypted with `ENCRYPTION_KEY`, and the key itself is XOR-obfuscated. A
built binary is therefore self-contained — it reads its embedded config and
**ignores any `.env`** at runtime. Build against a different `.env` with:

```sh
GVPN_ENV_FILE=/path/to/.env npm run build
```

> ⚠️ **This is obfuscation, not security.** Because the binary must decrypt its
> own config, both the encrypted creds and the (obfuscated) `ENCRYPTION_KEY`
> ship inside it. Anyone with the binary and some effort can recover the key —
> and therefore the DB credentials and every saved account identity. It only
> prevents trivial `strings`-grepping. Treat the binaries as secrets and
> distribute them accordingly.

When running from source (`node src/index.js`) there is no embedded config, so
the `.env` in the working directory (or `--env <path>`) is used as normal.

## Usage

```sh
# Interactive: print the current account, save it if new, then offer to swap
node src/index.js

# Print the active on-disk account
node src/index.js current

# List saved accounts
node src/index.js list

# Save the current on-disk account to the DB
node src/index.js save --name "my-account" --network rotsee

# Swap to a saved account by id
node src/index.js swap 3
```

Global options:

- `--env <path>` — path to the `.env` file (default: `.env` in the cwd).
- `--service <name>` — override the service unit/label to control.

## A note on privileges (sudo)

Account files live under `/var/lib` (Linux) or `/Library` (macOS) and controlling the service needs
root. Run swaps with `sudo` when not already root:

```sh
sudo node src/index.js swap 3
```

The tool will warn and exit with a clear message if it lacks the privileges it needs.
