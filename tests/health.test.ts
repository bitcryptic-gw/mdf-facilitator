/**
 * health.test.ts — cached balances, thresholds, staleness.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { BalanceMonitor } from "../src/health.ts";
import type { BalanceSource } from "../src/health.ts";

const THRESHOLD = 500_000_000_000_000n; // 0.0005 ETH, the plan's alert floor

function sources(balances: Record<string, bigint>): BalanceSource[] {
  return Object.entries(balances).map(([network, wei]) => ({
    network,
    address: "0x5d14FC4C786f5d257d9eeD846c4C82B0f603ec3F",
    getBalance: async () => wei,
  }));
}

test("never-polled balances report degraded, stale, zero", () => {
  const monitor = new BalanceMonitor({
    sources: sources({ "eip155:8453": 1n }),
    thresholdWei: THRESHOLD,
    pollMs: 60_000,
    version: "0.1.0",
  });
  const snap = monitor.snapshot();
  assert.equal(snap.status, "degraded");
  assert.equal(snap.stale, true);
  assert.equal(snap.signers[0]?.balanceWei, "0");
  assert.equal(snap.signers[0]?.updatedAt, null);
});

test("balances above the threshold report ok", async () => {
  let t = 1_000;
  const monitor = new BalanceMonitor({
    sources: sources({ "eip155:8453": THRESHOLD * 4n, "eip155:84532": THRESHOLD * 2n }),
    thresholdWei: THRESHOLD,
    pollMs: 60_000,
    version: "0.1.0",
    startedAt: 1_000,
    now: () => t,
  });
  await monitor.poll();
  t += 1_000;
  const snap = monitor.snapshot();
  assert.equal(snap.status, "ok");
  assert.equal(snap.stale, false);
  assert.equal(snap.signers.length, 2);
  assert.equal(snap.signers[0]?.balanceWei, (THRESHOLD * 4n).toString());
  assert.equal(snap.signers[0]?.thresholdWei, THRESHOLD.toString());
  assert.equal(snap.signers[0]?.ok, true);
});

test("a balance below the threshold reports degraded", async () => {
  const monitor = new BalanceMonitor({
    sources: sources({ "eip155:84532": THRESHOLD - 1n }),
    thresholdWei: THRESHOLD,
    pollMs: 60_000,
    version: "0.1.0",
    now: () => 1,
  });
  await monitor.poll();
  const snap = monitor.snapshot();
  assert.equal(snap.status, "degraded");
  assert.equal(snap.signers[0]?.ok, false);
});

test("a balance older than three poll intervals is stale", async () => {
  let t = 1_000;
  const monitor = new BalanceMonitor({
    sources: sources({ "eip155:8453": THRESHOLD * 10n }),
    thresholdWei: THRESHOLD,
    pollMs: 60_000,
    version: "0.1.0",
    now: () => t,
  });
  await monitor.poll();
  t += 60_000 * 3 + 1;
  assert.equal(monitor.snapshot().stale, true);
  assert.equal(monitor.snapshot().status, "degraded");
});

test("a failing balance source does not throw and stays stale", async () => {
  const monitor = new BalanceMonitor({
    sources: [
      {
        network: "eip155:8453",
        address: "0x5d14FC4C786f5d257d9eeD846c4C82B0f603ec3F",
        getBalance: async () => {
          throw new Error("rpc down");
        },
      },
    ],
    thresholdWei: THRESHOLD,
    pollMs: 60_000,
    version: "0.1.0",
    now: () => 1,
    log: () => {},
  });
  await monitor.poll();
  assert.equal(monitor.snapshot().stale, true);
});
