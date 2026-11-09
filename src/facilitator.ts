/**
 * facilitator.ts — build the x402 v2 facilitator for Base mainnet and Base
 * Sepolia, and refuse to serve unless `/supported` reports the real signer.
 *
 * The self-check exists because of the step-0 gotcha: `toFacilitatorEvmSigner`
 * takes the address from a top-level `address` property. Hand it a bare viem
 * client and `/supported` quietly answers `"signers": {"eip155:*": [null]}` —
 * a facilitator that looks healthy and cannot settle anything.
 */

import { createWalletClient, http, publicActions } from "viem";
import type { Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";

export interface ChainConfig {
  network: `${string}:${string}`;
  chain: Chain;
}

export const CHAINS: ChainConfig[] = [
  { network: "eip155:8453", chain: base },
  { network: "eip155:84532", chain: baseSepolia },
];

export interface SupportedResponse {
  kinds: Array<{ x402Version: number; scheme: string; network: string }>;
  extensions: string[];
  signers: Record<string, string[]>;
}

export class SignerSelfCheckError extends Error {}

/**
 * Assert `/supported` names the expected address for every network and lists no
 * empty signer. Pure, so the failure mode is testable without a chain.
 */
export function assertSupportedSigners(
  supported: SupportedResponse,
  expected: { networks: string[]; address: string }
): void {
  const wanted = expected.address.toLowerCase();

  for (const network of expected.networks) {
    const kind = supported.kinds.find(
      (k) => k.x402Version === 2 && k.scheme === "exact" && k.network === network
    );
    if (!kind) {
      throw new SignerSelfCheckError(`/supported does not list exact/${network}`);
    }
  }

  const signers = supported.signers?.["eip155:*"];
  if (!Array.isArray(signers) || signers.length === 0) {
    throw new SignerSelfCheckError("/supported lists no eip155:* signer");
  }
  if (signers.some((s) => typeof s !== "string" || s.length === 0)) {
    throw new SignerSelfCheckError(
      "/supported contains an empty signer (a bare viem client was passed instead of an account object with `address`)"
    );
  }
  if (!signers.map((s) => s.toLowerCase()).includes(wanted)) {
    throw new SignerSelfCheckError(`/supported does not name the configured signer ${expected.address}`);
  }
}

export interface BuiltFacilitator {
  facilitator: x402Facilitator;
  address: string;
  networks: string[];
}

export function buildFacilitator(
  privateKey: `0x${string}`,
  rpc: { base: string; baseSepolia: string },
  confirmationTimeoutMs: number
): BuiltFacilitator {
  const account = privateKeyToAccount(privateKey);
  const facilitator = new x402Facilitator();
  const networks: `${string}:${string}`[] = [];

  for (const { network, chain } of CHAINS) {
    const rpcUrl = network === "eip155:8453" ? rpc.base : rpc.baseSepolia;
    const client = createWalletClient({ account, chain, transport: http(rpcUrl) }).extend(publicActions);

    // The explicitly-passed `address` is load-bearing: see the module comment.
    const signer = toFacilitatorEvmSigner(
      {
        address: account.address,
        getCode: (args) => client.getCode(args),
        readContract: (args) => client.readContract({ ...args, args: args.args ?? [] }),
        // viem narrows VerifyTypedDataParameters to a block-bound union; the
        // facilitator interface is deliberately looser than that.
        verifyTypedData: (args) =>
          client.verifyTypedData(args as Parameters<typeof client.verifyTypedData>[0]),
        writeContract: (args) => client.writeContract({ ...args, args: args.args ?? [] }),
        sendTransaction: (args) => client.sendTransaction(args),
        waitForTransactionReceipt: (args) => client.waitForTransactionReceipt(args),
      },
      { confirmationTimeoutMs }
    );

    facilitator.register(network, new ExactEvmScheme(signer, { eip6492AllowedFactories: [] }));
    networks.push(network);
  }

  return { facilitator, address: account.address, networks };
}
