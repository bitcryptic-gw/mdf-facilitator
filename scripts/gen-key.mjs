#!/usr/bin/env node
/**
 * gen-key.mjs — create a signer key in a file, mode 600, and print only the
 * address.
 *
 * Deliberately writes with O_EXCL so an existing key is never overwritten, and
 * never prints, echoes or returns the secret. Run it on the host that will use
 * the key; the secret should not travel.
 *
 *   node scripts/gen-key.mjs /path/to/facilitator_signer_key
 */

import { writeFileSync, chmodSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

const path = process.argv[2];
if (!path) {
  console.error("usage: gen-key.mjs <path>");
  process.exit(1);
}
if (existsSync(path)) {
  console.error(`refusing to overwrite existing file: ${path}`);
  process.exit(1);
}

const key = `0x${randomBytes(32).toString("hex")}`;
writeFileSync(path, key, { mode: 0o600, flag: "wx" });
chmodSync(path, 0o600);

const account = privateKeyToAccount(key);
// Only the address leaves this process.
console.log(account.address);
