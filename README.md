# mdf-facilitator

Self-hosted **x402 v2 facilitator** for [MDF](https://github.com/bitcryptic-gw/mdf).
This is MDF infrastructure, not a community application: it exists to verify and
settle MDF's own payments on Base, and it is deliberately not listed in the CA
templates repo.

Runs `exact` on `eip155:8453` (Base mainnet) and `eip155:84532` (Base Sepolia)
using the official x402 v2 libraries.

```
GET  /supported   x402 v2 supported kinds and signer addresses
GET  /health      cached per-signer balance, threshold state, uptime
POST /verify      x402 verify
POST /settle      x402 settle
```

## Image

`bitcryptic/mdf-facilitator`, pinned **by digest** everywhere it is deployed:

```
bitcryptic/mdf-facilitator@sha256:626252669440b04a1787370eb98ce4733d8a86c55a114d7d6b586b72ac3c5758
```

The image contains no secrets. The signer key is a bind-mounted file.

## Signer key

Read from `/run/secrets/facilitator_signer_key` (override with `KEY_PATH`). The
process **refuses to start** unless the file is:

- a regular file, at most 4 KiB;
- **mode 600** (anything else is refused: a 644 key is readable by every process
  on the host);
- owned by the uid the process runs as (the image runs as `node`, uid 1000), or
  by root;
- a `0x`-prefixed 32-byte hex string.

The key is never read from the environment, a CLI argument, or an image layer,
so it cannot appear in `docker inspect`. Only the resulting address is logged.

Generate one on the host that will use it, so the secret never travels:

```bash
node -e 'const c=require("crypto"),f=require("fs");const e=c.createECDH("secp256k1");e.generateKeys();
f.writeFileSync(process.argv[1],"0x"+e.getPrivateKey("hex").padStart(64,"0"),{mode:0o600,flag:"wx"});
console.log("0x"+e.getPublicKey("hex"))' /path/to/facilitator_signer_key
```

That prints the **public key** only (65 bytes). The address is derived from it
offline. `scripts/gen-key.mjs` does the same thing when `viem` is available and
prints the address directly.

## Startup self-check

`/supported` must list the configured signer for every network, and must contain
no empty signer. This exists because of a real gotcha: the x402 EVM adapter takes
the address from a top-level `address` property, so handing it a bare viem client
produces `"signers": {"eip155:*": [null]}` — a facilitator that reports healthy
and can never settle. The process exits rather than serve that.

## Configuration

All non-secret; secrets are files.

| variable | default | meaning |
|---|---|---|
| `PORT` | `8080` | listen port |
| `KEY_PATH` | `/run/secrets/facilitator_signer_key` | signer key file |
| `BASE_RPC_URL` | `https://mainnet.base.org` | Base mainnet RPC |
| `BASE_SEPOLIA_RPC_URL` | `https://sepolia.base.org` | Base Sepolia RPC |
| `BALANCE_POLL_MS` | `300000` | background balance poll (5 min) |
| `GAS_THRESHOLD_WEI` | `500000000000000` | low-gas floor (0.0005 ETH) |
| `MAX_BODY_BYTES` | `65536` | request body cap for `/verify` and `/settle` |
| `RATE_LIMIT_PER_MINUTE` | `240` | per-IP request cap |
| `CONFIRMATION_TIMEOUT_MS` | `25000` | receipt wait bound; above it, `settlement_pending` |

## `/health`

Always HTTP 200 — a low balance or a stale reading must not pull a leg out of a
load-balanced pool or flap a monitor. The body says what is wrong:

```json
{
  "status": "ok" | "degraded",
  "version": "0.1.2",
  "uptimeSeconds": 1234,
  "balancesUpdatedAt": "2026-11-09T10:47:22.344Z",
  "stale": false,
  "signers": [
    { "network": "eip155:8453", "address": "0x…", "balanceWei": "…",
      "thresholdWei": "500000000000000", "ok": true, "updatedAt": "…" }
  ]
}
```

Balances are polled in the background and served from memory. `/health` never
makes an RPC call, so a monitor cannot turn into load on the RPC provider. A
reading older than three poll intervals is reported `stale` and the overall
status is `degraded`.

## Security baseline

- Runs as `node` (uid 1000) by default; under the Unraid Tailscale hook it starts
  as root (the hook needs it) and **drops to uid 1000 before reading the key or
  opening the socket** (`APP_UID`/`APP_GID`, default 1000).
- `node:24-alpine`, no build toolchain in the image.
- Request bodies capped before parsing; oversized requests get `413`.
- Per-IP rate limit on every route.
- Errors return `{"error":"internal error"}`; detail goes to the log only.
- Logs are allowlisted JSON: method, path, status, duration, network, scheme,
  outcome and reason code. **No payment payloads, signatures, authorizations,
  headers or keys** — the same redaction rule as the #56 interop run.
- No telemetry, no hosted dependency, no outbound calls except the configured
  RPC endpoints.
- `/supported` and `/health` are safe to expose; they carry public addresses and
  balances.

## Development

```bash
npm ci
npm test          # 35 tests: key-file refusals, signer self-check, privileges, health, http, logging
npm run typecheck
```

Node 24 runs the TypeScript directly (type stripping); there is no build step
and therefore no build output to drift from the source.

## Deployment

`deploy/` holds the Unraid templates and the apply instructions. The container is
created through the Unraid Docker UI so the `my-*.xml` template stays the source
of truth (see the MDF deployment rules).

Each container is its own **tailnet node** via Unraid's Tailscale integration and
publishes **no host port**: `/settle` is unauthenticated, and a host-port binding
would let anyone on the LAN make the signer spend gas. The hook joins with a
single-use auth key on first start; the key is then removed from the template and
the node rejoins from state kept in `/app/data/.tailscale_state`.
