/**
 * http.test.ts — routes, limits, and a log that never carries the payload.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../src/http.ts";
import type { AppDeps, FacilitatorLike } from "../src/http.ts";
import { createServer } from "node:http";
import type { Server } from "node:http";

const SIGNATURE = "0xfeedface".repeat(8);

function fakeFacilitator(overrides: Partial<FacilitatorLike> = {}): FacilitatorLike {
  return {
    verify: async () => ({ isValid: true, payer: "0xpayer" }),
    settle: async () => ({ success: true, transaction: "0xtx", network: "eip155:84532" }),
    getSupported: () => ({
      kinds: [
        { x402Version: 2, scheme: "exact", network: "eip155:8453" },
        { x402Version: 2, scheme: "exact", network: "eip155:84532" },
      ],
      extensions: [],
      signers: { "eip155:*": ["0x5d14FC4C786f5d257d9eeD846c4C82B0f603ec3F"] },
    }),
    ...overrides,
  };
}

function logs(): { lines: string[]; log: AppDeps["log"] } {
  const lines: string[] = [];
  const write = (level: string) => (fields: Record<string, unknown>) =>
    lines.push(JSON.stringify({ level, ...fields }));
  return { lines, log: { info: write("info"), warn: write("warn"), error: write("error") } };
}

async function serve(deps: Partial<AppDeps> = {}): Promise<{ base: string; server: Server; lines: string[] }> {
  const captured = logs();
  const handler = createHandler({
    facilitator: fakeFacilitator(),
    health: () => ({
      status: "ok",
      version: "0.1.0",
      uptimeSeconds: 1,
      balancesUpdatedAt: "2026-11-09T00:00:00.000Z",
      stale: false,
      signers: [
        {
          network: "eip155:8453",
          address: "0x5d14FC4C786f5d257d9eeD846c4C82B0f603ec3F",
          balanceWei: "1000",
          thresholdWei: "500",
          ok: true,
          updatedAt: "2026-11-09T00:00:00.000Z",
        },
      ],
    }),
    version: "0.1.0",
    maxBodyBytes: 1024,
    rateLimitPerMinute: 100,
    log: captured.log,
    ...deps,
  });

  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { base: `http://127.0.0.1:${port}`, server, lines: captured.lines };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("GET /supported returns the v2 shape", async () => {
  const { base, server } = await serve();
  const res = await fetch(`${base}/supported`);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 200);
  assert.deepEqual((body.kinds as unknown[]).length, 2);
  assert.deepEqual(body.extensions, []);
  await close(server);
});

test("GET /health serves the cached snapshot", async () => {
  const { base, server } = await serve();
  const res = await fetch(`${base}/health`);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 200);
  assert.equal(body.status, "ok");
  assert.equal((body.signers as unknown[]).length, 1);
  await close(server);
});

test("POST /verify accepts a well-formed request and logs no payload", async () => {
  const { base, server, lines } = await serve();
  const res = await fetch(`${base}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      paymentPayload: { x402Version: 2, payload: { signature: SIGNATURE, authorization: { from: "0xabc" } } },
      paymentRequirements: { scheme: "exact", network: "eip155:84532", amount: "1000" },
    }),
  });
  assert.equal(res.status, 200);
  const joined = lines.join("\n");
  assert.ok(joined.includes('"msg":"verify"'), "the verify outcome is logged");
  assert.ok(joined.includes("eip155:84532"));
  assert.ok(!joined.includes(SIGNATURE), "the signature must not be logged");
  assert.ok(!joined.includes("0xabc"), "the payer address from the payload must not be logged");
  await close(server);
});

test("POST /verify without the required objects is a 400", async () => {
  const { base, server } = await serve();
  const res = await fetch(`${base}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paymentPayload: {} }),
  });
  assert.equal(res.status, 400);
  await close(server);
});

test("a non-JSON body is a 400", async () => {
  const { base, server } = await serve();
  const res = await fetch(`${base}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
  assert.equal(res.status, 400);
  await close(server);
});

test("an oversized body is a 413", async () => {
  const { base, server } = await serve({ maxBodyBytes: 64 });
  const res = await fetch(`${base}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paymentPayload: { a: "x".repeat(500) }, paymentRequirements: {} }),
  });
  assert.equal(res.status, 413);
  await close(server);
});

test("a thrown facilitator error is a 500 with no internal detail", async () => {
  const { base, server } = await serve({
    facilitator: fakeFacilitator({
      settle: async () => {
        throw new Error("rpc exploded: secret-hint");
      },
    }),
  });
  const res = await fetch(`${base}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paymentPayload: {}, paymentRequirements: {} }),
  });
  assert.equal(res.status, 500);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(body, { error: "internal error" });
  await close(server);
});

test("GET /verify is a 405 with an Allow header", async () => {
  const { base, server } = await serve();
  const res = await fetch(`${base}/verify`);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
  await close(server);
});

test("an unknown path is a 404", async () => {
  const { base, server } = await serve();
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
  await close(server);
});

test("the rate limit answers 429", async () => {
  const { base, server } = await serve({ rateLimitPerMinute: 2 });
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await fetch(`${base}/supported`)).status);
  assert.deepEqual(statuses, [200, 200, 429, 429]);
  await close(server);
});

test("responses are no-store and nosniff", async () => {
  const { base, server } = await serve();
  const res = await fetch(`${base}/supported`);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  await close(server);
});
