/**
 * privileges.test.ts — the uid/gid the service drops to under the Unraid hook.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dropTarget } from "../src/privileges.ts";

test("defaults to 1000:1000, matching the image's node user", () => {
  assert.deepEqual(dropTarget({}), { uid: 1000, gid: 1000 });
});

test("honours APP_UID and APP_GID", () => {
  assert.deepEqual(dropTarget({ APP_UID: "1001", APP_GID: "1002" }), { uid: 1001, gid: 1002 });
});

test("rejects a non-numeric or root uid", () => {
  assert.throws(() => dropTarget({ APP_UID: "abc" }), /positive integers/);
  assert.throws(() => dropTarget({ APP_UID: "0" }), /positive integers/);
  assert.throws(() => dropTarget({ APP_UID: "1000.5" }), /positive integers/);
});
