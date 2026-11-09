/**
 * log.test.ts — the logger keeps only the fields a facilitator may publish.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/log.ts";

function capture(): { lines: string[]; stream: { write(chunk: string): unknown } } {
  const lines: string[] = [];
  return { lines, stream: { write: (chunk: string) => lines.push(chunk) } };
}

test("allowed fields are emitted as JSON lines", () => {
  const { lines, stream } = capture();
  const log = createLogger(stream);
  log.info({ msg: "verify", network: "eip155:84532", outcome: "valid", reason: "ok" });
  const parsed = JSON.parse(lines[0] ?? "{}");
  assert.equal(parsed.msg, "verify");
  assert.equal(parsed.network, "eip155:84532");
  assert.equal(parsed.level, "info");
  assert.ok(typeof parsed.ts === "string");
});

test("anything not on the allowlist is dropped", () => {
  const { lines, stream } = capture();
  const log = createLogger(stream);
  log.info({
    msg: "verify",
    // Things that must never reach a log:
    paymentPayload: { payload: { signature: "0xdeadbeef" } },
    signature: "0xdeadbeef",
    headers: { authorization: "L402 ..." },
    payer: "0xabc",
  } as Record<string, unknown>);
  const raw = lines[0] ?? "";
  assert.ok(!raw.includes("0xdeadbeef"));
  assert.ok(!raw.includes("L402"));
  assert.ok(!raw.includes("0xabc"));
  assert.ok(!raw.includes("paymentPayload"));
});

test("levels are tagged", () => {
  const { lines, stream } = capture();
  const log = createLogger(stream);
  log.warn({ msg: "a" });
  log.error({ msg: "b" });
  assert.equal(JSON.parse(lines[0] ?? "{}").level, "warn");
  assert.equal(JSON.parse(lines[1] ?? "{}").level, "error");
});
