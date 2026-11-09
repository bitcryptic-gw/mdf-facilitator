# Deployment — staging legs on the tailnet (blue/green, no cutover)

Two v2 legs run **alongside** the v1 pool. Neither is in the Caddy pool, and
`x402.bitcryptic.com` keeps serving from the v1 containers throughout.

| leg | host | container | tailnet node | reachable at |
|---|---|---|---|---|
| syd | `unraid-syd` | `mdf-facilitator-syd` | `mdf-facilitator-syd` | `http://mdf-facilitator-syd:8080` |
| public | `unraid-public` | `mdf-facilitator-public` | `mdf-facilitator-public` | `http://mdf-facilitator-public:8080` |

**No host port is published.** Each container is its own tailnet node via
Unraid's Tailscale integration, exactly as the v1 legs are. That keeps the
unauthenticated `/settle` off the LAN: an attacker who is not on the tailnet
cannot make the signer spend gas settling a validly signed authorization.

Image, pinned by digest:

```
bitcryptic/mdf-facilitator@sha256:b7df3f7244fd0a2352dbe982d5702d2f2e79845943d661266b83dd7893fa2980   (0.1.1)
```

## Why the containers are created in the Unraid UI

A container created with `docker run` is invisible to Unraid's `my-*.xml`
regeneration, is labelled as a third-party container, and on a future recreate
from a stale template silently loses settings that only ever existed live. Every
MDF container is created through the Docker UI so the template stays the source
of truth. That is a standing rule, not a preference.

## 1. Key file (per host, before the container exists)

The service runs as **uid 1000 / gid 1000** (`APP_UID`/`APP_GID`, the image's
`node` user). The key is read after the process drops from root, so the file
must be owned by 1000:1000 and mode 600. Create it with a restrictive umask so
it is never briefly world-readable:

```bash
umask 077
BASE=/mnt/cache/appdata/mdf-facilitator-syd
install -d -m 700 -o 1000 -g 1000 "$BASE/secrets"
install -d -m 755 -o 1000 -g 1000 "$BASE/data"

test ! -e "$BASE/secrets/facilitator_signer_key" || { echo "key already exists"; exit 1; }

node -e 'const c=require("crypto"),f=require("fs");const e=c.createECDH("secp256k1");
e.generateKeys();
f.writeFileSync(process.argv[1],"0x"+e.getPrivateKey("hex").padStart(64,"0"),{mode:0o600,flag:"wx"});
console.log("0x"+e.getPublicKey("hex"))' "$BASE/secrets/facilitator_signer_key"

chown 1000:1000 "$BASE/secrets/facilitator_signer_key"
chmod 600 "$BASE/secrets/facilitator_signer_key"
ls -ln "$BASE/secrets/facilitator_signer_key"
```

That prints the **public key** only (65 bytes, not a secret); the address is
derived from it offline. The check afterwards must read exactly:

```
-rw------- 1 1000 1000 66 <date> /mnt/cache/appdata/mdf-facilitator-syd/secrets/facilitator_signer_key
```

(`66` bytes: `0x` plus 64 hex characters. Anything wider than `-rw-------` and
the container will refuse to start.)

Each leg gets its own key. Nothing is shared with the v1 legs or between the two
v2 legs.

## 2. Tailscale integration

The template ships the fields Unraid's hook reads, modelled on the running v1
`x402-facilitator-public` / `-syd` containers:

| field | value | why |
|---|---|---|
| entrypoint | `/opt/unraid/tailscale` (ExtraParams) | the hook re-execs the real command |
| `ORG_ENTRYPOINT` / `ORG_CMD` | `node` / `/app/src/index.ts` | what the hook execs after the tailnet is up |
| `TAILSCALE_HOSTNAME` | `mdf-facilitator-syd` / `-public` | the node name proposed for the leg |
| `TAILSCALE_STATE_DIR` | `/app/data/.tailscale_state` | state survives restarts, on the appdata mount |
| `TAILSCALE_USERSPACE_NETWORKING` | `false` | kernel/TUN mode, so inbound `:8080` works |
| `--device=/dev/net/tun`, `--cap-add=NET_ADMIN` | ExtraParams | required by TUN mode |
| `TAILSCALE_ALLOW_LAN_ACCESS`, `TAILSCALE_USE_SSH` | `false` | no LAN reach, no SSH |
| `TAILSCALE_PARAMS` | empty | the single-use auth key goes here on first start only |
| `--user 0:0` | ExtraParams | the hook requires root; the service drops to 1000 itself |

### First start

1. **Mint the single-use auth key with `tag:misc-services`** — the same tag the
   existing v1 facilitator containers use. Tags come from the auth key, not from
   the container config, which is why they do not appear in the template or in
   `docker inspect`. Tagged nodes have **key expiry disabled by default**, so
   there is nothing to disable in the admin console.
2. Paste the key into `TAILSCALE_PARAMS` as `--authkey=tskey-auth-…` (the hook
   passes that string straight to `tailscale up`; there is no separate auth-key
   variable in this hook version).
3. Start the container from the UI.
4. Confirm the node exists: `tailscale status | grep mdf-facilitator-syd`,
   or look for it in the admin console. Confirm the state was written:
   `ls /mnt/cache/appdata/mdf-facilitator-syd/data/.tailscale_state`.
5. Confirm the service: `curl -s http://mdf-facilitator-syd:8080/supported`
   from any tailnet node.
6. **Clear `TAILSCALE_PARAMS`** in the template and apply/restart.
7. Confirm it rejoins from saved state (the container log shows
   `Starting tailscale` / `Connected`, and the node name is unchanged).

### Proving the key is gone

After the restart, the running container must not carry the key:

```bash
docker inspect mdf-facilitator-syd --format '{{json .Config.Env}}' | grep -i authkey || echo "no auth key in the container config"
```

The template's `TAILSCALE_PARAMS` must be empty too. Do the same check on the
`my-mdf-facilitator-*.xml` file if the key was ever saved there.

## 3. Verify (read-only)

```bash
curl -s http://mdf-facilitator-syd:8080/supported | jq .
curl -s http://mdf-facilitator-syd:8080/health    | jq .
```

Expected: `kinds` lists `exact` for `eip155:8453` and `eip155:84532`;
`signers["eip155:*"]` contains the address derived from the key file (never
`null`); `health.signers[]` carries a balance and an `updatedAt` within the poll
interval. If `/supported` shows `[null]`, stop — do not put the leg in front of
traffic.

## 4. Sepolia acceptance

The resource server is still v1 until #64, so the round trip is driven by a
throwaway v2 client (as in #56), against the tailnet node name:

1. Create a throwaway payer key in a scratch dir (700, key 600, never printed).
2. Print the payer address and ask for Sepolia USDC. Also print the leg's signer
   address and ask for Sepolia ETH for gas, and ask for a sweep address — all in
   one message.
3. After `FUNDED`: POST `/verify` then `/settle` for the smallest amount the
   facilitator supports. Confirm the tx on-chain: receipt success, a `Transfer`
   log to the merchant address, and `from` = the leg's signer (the facilitator
   pays gas).
4. Sweep the payer's remaining USDC and ETH to the address Gary supplied, then
   delete the payer key.

**Staging is Sepolia only.** No mainnet settlement is run; mainnet is not funded
at this stage (see below).

## 5. Mainnet gas — funded at cutover, not before

Staging needs no mainnet ETH: nothing can settle on mainnet before #64. At
cutover, fund **0.002 ETH per signer** on Base mainnet (≈147k gas per
settlement, ≈0.000003 ETH at 0.02 gwei → 400–650 settlements; alert below
0.0005 ETH, which is `GAS_THRESHOLD_WEI` in the template). Re-derive the figure
from the first real receipt before adding more.

## 6. Monitors (Uptime Kuma)

Per leg, tagged `mdf-v2-staging` so nothing pages as production before cutover.
Targets are the **tailnet node names**, not host:port:

| monitor | check |
|---|---|
| `<leg> supported` | keyword: `http://<node>:8080/supported` contains `eip155:8453`, `eip155:84532` and the signer address |
| `<leg> health` | keyword: `http://<node>:8080/health` contains `"status":"ok"` |
| `<leg> gas base` | keyword: `/health` `eip155:8453` balance ≥ `thresholdWei` |
| `<leg> gas sepolia` | keyword: `/health` `eip155:84532` balance ≥ `thresholdWei` |

`/health` is always HTTP 200, so the keyword is what fails, not the status code.

## 7. Cutover checklist (step 5, not yet executed)

- [x] Per-container Tailscale at staging — no host port, state on appdata,
      auth key cleared after first join.
- [x] Both legs healthy in `/supported` and `/health` for a soak period.
- [ ] **Fund mainnet gas at cutover** (0.002 ETH per signer); `/health` reports
      `ok` on `eip155:8453`.
- [ ] Caddy: change **only** the two upstream addresses for
      `x402.bitcryptic.com`, to `mdf-facilitator-syd:8080` and
      `mdf-facilitator-public:8080`; keep `lb_policy round_robin`,
      `health_uri /health`; add `health_interval 30s`, `fail_duration 30s`.
- [ ] Verify through the pool: `/supported` alternates the two v2 signers 10/10.
- [ ] Confirm `x402.bitcryptic.com` still serves 402s and settles on Sepolia.
- [ ] Kuma: retag the v2 monitors as production, add them to the notification set.
- [ ] Soak; then stop the v1 containers (keep images for rollback).
- [ ] Retire v1: remove templates and images; sweep residual gas from both old
      signers to the treasury; remove the old keys from 1Password.
- [ ] Rollback is reverting the two Caddy upstream lines — the facilitator holds
      no state to migrate.
