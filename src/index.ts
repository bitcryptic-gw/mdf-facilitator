#!/usr/bin/env node
/**
 * index.ts — boot: key file, facilitator, self-check, balance poller, server.
 *
 * Any startup failure is fatal on purpose. A facilitator that serves traffic
 * with an unreadable key or a null signer is worse than one that refuses to
 * start: callers would see structured "invalid payment" answers for what is
 * actually a broken deployment.
 */

import { createServer } from "node:http";
import { createPublicClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { loadConfig } from "./config.ts";
import { KeyFileError, loadSignerKey } from "./keyfile.ts";
import { buildFacilitator, assertSupportedSigners, SignerSelfCheckError } from "./facilitator.ts";
import { BalanceMonitor } from "./health.ts";
import { createHandler } from "./http.ts";
import { dropPrivileges } from "./privileges.ts";
import { createLogger } from "./log.ts";

const VERSION = "0.1.1";

/**
 * The Unraid Tailscale hook runs as root (it installs packages, starts
 * tailscaled and needs NET_ADMIN), then execs this process. Drop to the
 * unprivileged uid before the key is read or the socket is opened, so the
 * facilitator itself never runs as root and the key-file ownership check still
 * means something. A no-op when the container already starts as the app user.
 */
async function main(): Promise<void> {
  const log = createLogger();
  dropPrivileges(log);
  const config = loadConfig();

  let privateKey: `0x${string}`;
  try {
    privateKey = loadSignerKey(config.keyPath) as `0x${string}`;
  } catch (error) {
    log.error({ msg: "startup refused", err: (error as KeyFileError).message });
    process.exit(1);
  }

  const { facilitator, address, networks } = buildFacilitator(
    privateKey,
    config.rpc,
    config.confirmationTimeoutMs
  );

  // Fail closed if /supported would advertise a null or wrong signer.
  try {
    assertSupportedSigners(facilitator.getSupported() as never, { networks, address });
  } catch (error) {
    log.error({ msg: "startup refused", err: (error as SignerSelfCheckError).message });
    process.exit(1);
  }

  const clients = [
    { network: "eip155:8453", client: createPublicClient({ chain: base, transport: http(config.rpc.base) }) },
    {
      network: "eip155:84532",
      client: createPublicClient({ chain: baseSepolia, transport: http(config.rpc.baseSepolia) }),
    },
  ];

  const monitor = new BalanceMonitor({
    thresholdWei: config.gasThresholdWei,
    pollMs: config.balancePollMs,
    version: VERSION,
    startedAt: Date.now(),
    sources: clients.map(({ network, client }) => ({
      network,
      address,
      getBalance: () => client.getBalance({ address: address as `0x${string}` }),
    })),
    log: (fields) => log.warn(fields),
  });
  monitor.start();

  const handler = createHandler({
    facilitator: facilitator as never,
    health: () => monitor.snapshot(),
    version: VERSION,
    maxBodyBytes: config.maxBodyBytes,
    rateLimitPerMinute: config.rateLimitPerMinute,
    log,
  });

  const server = createServer(handler);
  server.listen(config.port, "0.0.0.0", () => {
    log.info({
      msg: "facilitator listening",
      address,
      signerCount: networks.length,
    });
  });

  const shutdown = (signal: string) => {
    log.info({ msg: "shutting down", reason: signal });
    monitor.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ level: "error", msg: "fatal", err: String(error?.message ?? error) })}\n`);
  process.exit(1);
});
