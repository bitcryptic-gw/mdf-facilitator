# Deployment — staging legs (blue/green, no cutover)

Two v2 legs run **alongside** the v1 pool. Neither is in the Caddy pool, and
`x402.bitcryptic.com` keeps serving from the v1 containers throughout.

| leg | host | container | host port | tailnet URL |
|---|---|---|---|---|
| syd | `unraid-syd` | `mdf-facilitator-v2-syd` | 18080 | `http://unraid-syd:18080` |
| public | `unraid-public` | `mdf-facilitator-v2-public` | 18080 | `http://unraid-public:18080` |

Image, pinned by digest:

```
bitcryptic/mdf-facilitator@sha256:e80f13616b9d20cd247abc0126d99508d187c57dde1e56988708123381c6ffe0
```

## Why the containers are created in the Unraid UI

A container created with `docker run` is invisible to Unraid's `my-*.xml`
regeneration, is labelled as a third-party container, and on a future recreate
from a stale template silently loses settings that only ever existed live. Every
MDF container is created through the Docker UI so the template stays the source
of truth. That is a standing rule, not a preference.

## 1. Key file (per host, before the container exists)

On the host that will own the leg:

```bash
mkdir -p /mnt/cache/appdata/mdf-facilitator-v2-syd/{secrets,data}
# Generate the key in place; only the public key is printed.
node -e 'const c=require("crypto"),f=require("fs");const e=c.createECDH("secp256k1");e.generateKeys();
f.writeFileSync(process.argv[1],"0x"+e.getPrivateKey("hex").padStart(64,"0"),{mode:0o600,flag:"wx"});
console.log("0x"+e.getPublicKey("hex"))' \
  /mnt/cache/appdata/mdf-facilitator-v2-syd/secrets/facilitator_signer_key
chown 1000:1000 /mnt/cache/appdata/mdf-facilitator-v2-syd/secrets/facilitator_signer_key
chmod 600 /mnt/cache/appdata/mdf-facilitator-v2-syd/secrets/facilitator_signer_key
```

The file must be mode 600 and owned by uid 1000, or the container refuses to
start. Each leg gets its own key; nothing is shared with the v1 legs or between
the v2 legs.

## 2. Apply the template

Docker tab → Add Container → paste the template XML from this directory (or
`dockerMan` → Templates → import). Check before applying:

- Repository is the digest above, not a tag.
- Port 18080 → 8080/tcp.
- `/run/secrets` → `/mnt/cache/appdata/mdf-facilitator-v2-<leg>/secrets` (ro).
- `/app/data` → `/mnt/cache/appdata/mdf-facilitator-v2-<leg>/data` (rw).
- No `TAILSCALE_*` variables for staging: the leg is reached by host port on the
  tailnet, not by its own tailnet identity. **Before cutover** it needs either
  the tailscale container hook (as the v1 legs have) or a Caddy upstream aimed
  at the host's tailnet address on 18080.

## 3. Verify (read-only)

```bash
curl -s http://unraid-syd:18080/supported | jq .
curl -s http://unraid-syd:18080/health    | jq .
```

Expected: `kinds` lists `exact` for `eip155:8453` and `eip155:84532`;
`signers["eip155:*"]` contains the address derived from the key file (never
`null`); `health.signers[]` carries a balance and an `updatedAt` within the poll
interval. If `/supported` shows `[null]`, the account object lost its top-level
`address` — do not put the leg in front of traffic.

## 4. Sepolia acceptance

The resource server is still v1 until #64, so the round trip is driven by a
throwaway v2 client (as in #56):

1. Create a throwaway payer key in a scratch dir (700, key 600, never printed).
2. Print the payer address and ask for Sepolia USDC. Also print the leg's signer
   address and ask for Sepolia ETH for gas, and ask for a sweep address — all in
   one message.
3. After `FUNDED`: POST `/verify` then `/settle` for the smallest amount the
   facilitator supports. Confirm the tx on-chain: receipt success, `Transfer`
   log to the merchant address, and `from` = the leg's signer (the facilitator
   pays gas).
4. Sweep the payer's remaining USDC and ETH to the address Gary supplied, then
   delete the payer key.

Run no mainnet settlement. Mainnet is pre-funded for gas only; nothing can
settle there before #64.

## 5. Monitors (Uptime Kuma)

Per leg, tagged `mdf-v2-staging` so nothing pages as production before cutover:

| monitor | type | target |
|---|---|---|
| `<leg> supported` | HTTP keyword | `/supported` contains `eip155:8453` and `eip155:84532` and the signer address |
| `<leg> health` | HTTP keyword | `/health` contains `"status":"ok"` |
| `<leg> gas base` | HTTP keyword | `/health` `eip155:8453` balance above `thresholdWei` |
| `<leg> gas sepolia` | HTTP keyword | `/health` `eip155:84532` balance above `thresholdWei` |

`/health` is always HTTP 200, so the keyword is what fails, not the status code.

## 6. Cutover checklist (step 5, not yet executed)

- [ ] Both legs healthy in `/supported` and `/health` for a soak period.
- [ ] Mainnet gas funded on both signers; `/health` reports `ok` on `eip155:8453`.
- [ ] Tailscale reachability for the v2 containers (hook, or Caddy upstream to the
      host tailnet address on 18080).
- [ ] Caddy: change only the two upstream addresses for `x402.bitcryptic.com`;
      keep `lb_policy round_robin`, `health_uri /health`; add
      `health_interval 30s`, `fail_duration 30s`.
- [ ] Verify through the pool: `/supported` alternates the two v2 signers 10/10.
- [ ] Confirm `x402.bitcryptic.com` still serves 402s and settles on Sepolia.
- [ ] Kuma: retag the v2 monitors as production, add them to the notification set.
- [ ] Soak; then stop the v1 containers (keep images for rollback).
- [ ] Retire v1: remove templates and images; sweep residual gas from both old
      signers to the treasury; remove the old keys from 1Password.
- [ ] Rollback is reverting the two Caddy upstream lines — the facilitator holds
      no state to migrate.
