/**
 * keyfile.test.ts — every refusal the deployment depends on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyFileError, loadSignerKey } from "../src/keyfile.ts";

const KEY = "0x" + "a1".repeat(32);

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "mdfkey-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a missing key file is refused", () => {
  withDir((dir) => {
    assert.throws(() => loadSignerKey(join(dir, "nope")), (e: Error) => {
      assert.ok(e instanceof KeyFileError);
      assert.match(e.message, /missing/);
      return true;
    });
  });
});

test("a key file that is not mode 600 is refused", () => {
  withDir((dir) => {
    const path = join(dir, "key");
    writeFileSync(path, KEY + "\n", { mode: 0o644 });
    chmodSync(path, 0o644);
    assert.throws(() => loadSignerKey(path), /must be mode 600, found 644/);
  });
});

test("a key file owned by another user is refused", () => {
  withDir((dir) => {
    const path = join(dir, "key");
    writeFileSync(path, KEY + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
    // Pretend the process runs as a different uid.
    assert.throws(() => loadSignerKey(path, 999_999), /owned by the container user/);
  });
});

test("a malformed key file is refused", () => {
  withDir((dir) => {
    const path = join(dir, "key");
    writeFileSync(path, "not-a-key\n", { mode: 0o600 });
    chmodSync(path, 0o600);
    assert.throws(() => loadSignerKey(path), /0x-prefixed 32-byte hex key/);
  });
});

test("a key that is too short is refused", () => {
  withDir((dir) => {
    const path = join(dir, "key");
    writeFileSync(path, "0xdeadbeef\n", { mode: 0o600 });
    chmodSync(path, 0o600);
    assert.throws(() => loadSignerKey(path), /32-byte hex key/);
  });
});

test("an implausibly large key file is refused", () => {
  withDir((dir) => {
    const path = join(dir, "key");
    writeFileSync(path, "0x" + "a".repeat(5000), { mode: 0o600 });
    chmodSync(path, 0o600);
    assert.throws(() => loadSignerKey(path), /implausibly large/);
  });
});

test("a 600 file with a valid key loads, trimmed", () => {
  withDir((dir) => {
    const path = join(dir, "key");
    writeFileSync(path, `${KEY}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    assert.equal(loadSignerKey(path), KEY);
  });
});
