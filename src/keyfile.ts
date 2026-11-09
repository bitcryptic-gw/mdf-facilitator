/**
 * keyfile.ts — read the signer key from a file, and refuse anything sloppy.
 *
 * The key must be a file (not a symlink to something unexpected), 600, owned by
 * the user the process runs as, small, and a 32-byte hex string. Anything else
 * is a startup failure: a key with a 644 mode is a key every other process on
 * the host can read.
 */

import { closeSync, openSync, fstatSync, readSync } from "node:fs";

const MAX_KEY_BYTES = 4096;
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export class KeyFileError extends Error {}

/**
 * @param path key file path
 * @param uid the uid the process runs as (injectable for tests)
 */
export function loadSignerKey(path: string, uid: number = process.getuid?.() ?? -1): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new KeyFileError(
      code === "ENOENT" ? `signer key file is missing: ${path}` : `cannot open signer key file ${path}: ${code}`
    );
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new KeyFileError(`signer key path is not a regular file: ${path}`);
    if (stat.size > MAX_KEY_BYTES) throw new KeyFileError(`signer key file is implausibly large (${stat.size} bytes)`);

    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      throw new KeyFileError(
        `signer key file must be mode 600, found ${mode.toString(8).padStart(3, "0")}: ${path}`
      );
    }
    if (uid >= 0 && stat.uid !== uid && stat.uid !== 0) {
      throw new KeyFileError(
        `signer key file must be owned by the container user (uid ${uid}) or root, found uid ${stat.uid}`
      );
    }

    const buffer = Buffer.alloc(MAX_KEY_BYTES);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const value = buffer.subarray(0, read).toString("utf8").trim();
    if (!KEY_RE.test(value)) {
      throw new KeyFileError("signer key file does not contain a 0x-prefixed 32-byte hex key");
    }
    return value;
  } finally {
    closeSync(fd);
  }
}

/** Address for logging/health. Deliberately co-located so callers never log the key by accident. */
export function redactKey(key: string): string {
  return `0x…${key.slice(-4)}`;
}
