/**
 * signer.test.ts — the /supported self-check, including the step-0 gotcha.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSupportedSigners, SignerSelfCheckError } from "../src/facilitator.ts";
import type { SupportedResponse } from "../src/facilitator.ts";

const ADDRESS = "0x5d14FC4C786f5d257d9eeD846c4C82B0f603ec3F";
const NETWORKS = ["eip155:8453", "eip155:84532"];

function supported(overrides: Partial<SupportedResponse> = {}): SupportedResponse {
  return {
    kinds: [
      { x402Version: 2, scheme: "exact", network: "eip155:8453" },
      { x402Version: 2, scheme: "exact", network: "eip155:84532" },
    ],
    extensions: [],
    signers: { "eip155:*": [ADDRESS.toLowerCase()] },
    ...overrides,
  };
}

test("a correct /supported passes", () => {
  assert.doesNotThrow(() => assertSupportedSigners(supported(), { networks: NETWORKS, address: ADDRESS }));
});

test("a null signer (bare viem client) is refused — the step-0 gotcha", () => {
  const broken = supported({ signers: { "eip155:*": [null as unknown as string] } });
  assert.throws(
    () => assertSupportedSigners(broken, { networks: NETWORKS, address: ADDRESS }),
    (e: Error) => {
      assert.ok(e instanceof SignerSelfCheckError);
      assert.match(e.message, /empty signer/);
      return true;
    }
  );
});

test("an empty signer list is refused", () => {
  assert.throws(
    () => assertSupportedSigners(supported({ signers: { "eip155:*": [] } }), { networks: NETWORKS, address: ADDRESS }),
    /no eip155:\* signer/
  );
});

test("a different address is refused", () => {
  assert.throws(
    () => assertSupportedSigners(supported(), { networks: NETWORKS, address: "0x1111111111111111111111111111111111111111" }),
    /does not name the configured signer/
  );
});

test("a missing network kind is refused", () => {
  const onlyOne = supported({
    kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }],
  });
  assert.throws(
    () => assertSupportedSigners(onlyOne, { networks: NETWORKS, address: ADDRESS }),
    /does not list exact\/eip155:84532/
  );
});

test("a v1-only kind does not satisfy the check", () => {
  const v1 = supported({
    kinds: [{ x402Version: 1, scheme: "exact", network: "eip155:8453" }],
  });
  assert.throws(() => assertSupportedSigners(v1, { networks: ["eip155:8453"], address: ADDRESS }), /does not list/);
});
