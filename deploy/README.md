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
bitcryptic/mdf-facilitator@sha256:626252669440b04a1787370eb98ce4733d8a86c55a114d7d6b586b72ac3c5758   (0.1.2)
```

## Why the containers are created in the Unraid UI

A container created with `docker run` is invisible to Unraid's `my-*.xml`
regeneration, is labelled as a third-party container, and on a future recreate
from a stale template silently loses settings that only ever existed live. Every
MDF container is created through the Docker UI so the template stays the source
of truth. That is a standing rule, not a preference.

## Template notes: `<Config>` entries are attributes, not child elements

Every mount and every variable in these templates is a single `<Config>` element
whose fields are **attributes**, with the value as the element's text:

```xml
<Config Name="Data" Target="/app/data" Default="/mnt/cache/appdata/mdf-facilitator-syd/data"
        Mode="rw" Description="…" Type="Path" Display="always" Required="true" Mask="false">/mnt/cache/appdata/mdf-facilitator-syd/data</Config>
```

Unraid's `xmlToVar()` (`dynamix.docker.manager/include/Helpers.php`) reads a
`<Config>` with `$config->attributes()` and takes the value from the element
text, falling back to `Default`. The child-element form below is **valid XML and
completely invisible to it** — every entry is skipped, so the container starts
with no mounts and no variables:

```xml
<!-- WRONG: dockerMan reads attributes only -->
<Config><Name>Data</Name><Target>/app/data</Target><Type>Path</Type></Config>
```

That is the fault that produced MDF #63's "signer key file is missing" and the
missing Tailscale state: nine of nine entries were skipped while the template
parsed cleanly. Two other silent traps, for the same reason:

- **No `--` inside an XML comment.** It is illegal XML; simplexml returns false
  and the Unraid UI shows a **blank template** with no error message. Header
  comments must not contain flags like `--authkey`.
- **No legacy `<Data>`, `<Networking>` or `<Environment>` blocks.** `-v` comes
  only from `<Config Type="Path">`, `-e` from `<Config Type="Variable">`, and
  the network from `<Network>`.

The repo tests this against Unraid's own logic rather than a reimplementation:
`tests/unraid/xmlconfig.php` is a faithful copy of `xmlToVar()`'s `<Config>`
loop and `xmlToCommand()`'s `-v`/`-e` selection (cited to a webgui commit in its
header), `tests/template.test.ts` reads attributes only, compares the structure
with the `v1-*.xml` reference templates, and parses every template with PHP's
simplexml. `npm test` therefore needs `php` installed.

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

The template ships the fields Unraid's Tailscale integration reads. They are
**first-class template elements** (`<TailscaleStateDir>` et al.), not environment
variables: Unraid's `dynamix.docker.manager` turns those elements into the
`TAILSCALE_*` environment itself at container-creation time, and it also adds
the hook mount, `--entrypoint=/opt/unraid/tailscale`, `/dev/net/tun` and
`NET_ADMIN`. Putting the values in an `<Environment>` block does not reach the
hook — that is what caused the first launch to fail.

| element | value | why |
|---|---|---|
| `TailscaleEnabled` | `true` | turns the integration on |
| `TailscaleHostname` | `mdf-facilitator-syd` / `-public` | the node name |
| **`TailscaleStateDir`** | **`/app/data/.tailscale_state`** | **the fix:** without it the hook cannot find a persistent directory and aborts |
| `TailscaleUserspaceNetworking` | `false` | kernel/TUN mode, so inbound `:8080` works |
| `TailscaleLANAccess` | `false` | no LAN reach |
| `TailscaleSSH` | `false` | no SSH |
| `TailscaleParams` | empty | the single-use auth key goes here on first start only |
| `--user 0:0` (ExtraParams) | — | the hook requires root; the service drops to 1000 itself |

The image's `ENTRYPOINT` is `node /app/src/index.ts`; the integration copies that
into `ORG_ENTRYPOINT`, which is what the hook re-execs once the tailnet is up.

### State directory and ownership

`TailscaleStateDir` points **inside the existing `/app/data` rw mount** — no
extra volume. `tailscaled` runs as root under the hook and creates
`/app/data/.tailscale_state` (mode 0700, root-owned); `/app/data` itself is
`1000:1000` mode 755, so root can create the directory there. The facilitator
process never reads it: it drops to uid 1000 before doing anything and only
touches `/run/secrets` and its own socket. The signer key stays `1000:1000 600`
under `/run/secrets`, unaffected.

### Recreating a container (do this after any template change)

`dockerMan` keeps whatever the container was created with. Editing a container in
the UI re-uses that stale config, so a template fix only takes effect after the
container is removed and re-added.

1. **Stop the container and stop it restarting** (Docker → the container →
   Stop; if it is loop-restarting, toggle autostart off first).
2. **Re-place the template** (the `scp` in this README).
3. **Remove the container** in the UI, then **Add Container** from the template.
   Do not edit the existing one.
4. **Check the mounts before going further** — this is the step that was missed
   and cost a day:

   ```bash
   docker inspect mdf-facilitator-syd -f '{{json .Mounts}}' | jq -r '.[] | "\(.Source) -> \(.Destination) (\(.RW))"'
   ```

   Must show `/mnt/cache/appdata/mdf-facilitator-syd/secrets -> /run/secrets (false)`
   and `/mnt/cache/appdata/mdf-facilitator-syd/data -> /app/data (true)`, plus the
   Tailscale hook. If they are absent, the template's `<Config>` entries are not
   being read — a legacy `<Data>` block, or the child-element form instead of
   attributes (see "Template notes").

5. **Mint a fresh single-use auth key with `tag:misc-services`** — the same tag
   the v1 facilitator containers use. Tags come from the auth key, not from the
   container config. Tagged nodes have **key expiry disabled by default**, so
   there is nothing to disable in the admin console.
6. Paste it into the template's **`TailscaleParams`** element as
   `--authkey=tskey-auth-…` and start the container.
7. Confirm the node joined and the state was written to the host:

   ```bash
   tailscale status | grep mdf-facilitator-syd
   ls -lan /mnt/cache/appdata/mdf-facilitator-syd/data/.tailscale_state
   curl -s http://mdf-facilitator-syd:8080/supported | jq .signers
   ```

8. **Clear `TailscaleParams`** in the template, then remove/re-add the container
   (or apply the template change through the UI's recreate path) and restart.
9. Confirm it rejoins from saved state: the log shows `Starting tailscale` and
   the node name is unchanged, and `/supported` still answers.

### Post-create checks

```bash
docker inspect mdf-facilitator-syd -f '{{json .Mounts}}'         # both paths, ro/rw as above
docker inspect mdf-facilitator-syd -f '{{json .Config.Env}}'     # TAILSCALE_STATE_DIR=/app/data/.tailscale_state
docker inspect mdf-facilitator-syd -f '{{json .HostConfig.PortBindings}}'   # {}
ls -lan /mnt/cache/appdata/mdf-facilitator-syd/data/.tailscale_state
```

`npm test` in this repo fails if a template reintroduces a `<Data>`,
`<Networking>` or `<Environment>` block, writes a `<Config>` without a `Target`
attribute or in the child-element form, drops either mount, removes a v1
Tailscale or top-level element, leaves `TailscaleParams` non-empty, publishes a
port, or stops being well-formed XML. The same checks run through
`tests/unraid/xmlconfig.php`, which is Unraid's own parsing logic.

### Proving the key is gone

After the restart, the running container must not carry the key:

```bash
docker inspect mdf-facilitator-syd --format '{{json .Config.Env}}' | grep -i authkey || echo "no auth key in the container config"
```

The template's `TAILSCALE_PARAMS` must be empty too.

### Troubleshooting

**`signer key file is missing: /run/secrets/facilitator_signer_key`** — the
`/run/secrets` mount is absent, not a problem with the key file. Prove it:

```bash
docker inspect mdf-facilitator-syd -f '{{json .Mounts}}' | jq -r '.[] | "\(.Source) -> \(.Destination)"'
```

An **empty list, or a list with only the Tailscale hook and no `/run/secrets` /
`/app/data`**, means the template's `<Config>` entries were skipped — either the
template still has a `<Data>` block, or its `<Config>` entries use the
child-element form (`<Config><Target>…</Target></Config>`) instead of attributes.
The file on the host is usually correct (`-rw------- 1000 1000 66`); check it only
after `.Mounts` shows the bind. Fix the template, remove and re-add the container
(an edit keeps the stale config), then re-check `.Mounts` **before** minting a
new auth key.

**`backend error: invalid key`** on start or restart — the single-use key has
already been spent (a restart replays `tailscale up` with it). Mint a new key.
Before rejoining, check the admin console for a stale offline
`mdf-facilitator-syd` node and remove it; otherwise the new join appears as
`mdf-facilitator-syd-1`.

**`Option disabled as Network type is not bridge or custom`** — the template has
a legacy `<Networking>` block. Remove it; `<Network>bridge</Network>` is enough.

**The template shows up blank in the UI, or not at all** — it is not well-formed
XML and Unraid reports nothing. Almost always a `--` inside a comment (a CLI flag
pasted into the header, e.g. `--authkey`). Check it directly:

```bash
php -r 'libxml_use_internal_errors(true); var_dump(simplexml_load_file($argv[1]) !== false);' my-mdf-facilitator-syd.xml
```

`bool(false)` is the blank template; `php tests/unraid/xmlconfig.php <file>`
prints the libxml reason.

**`ERROR: Couldn't detect persistent Docker directory for .tailscale_state!`** —
the `TailscaleStateDir` element is empty. It must be
`/app/data/.tailscale_state`.

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
