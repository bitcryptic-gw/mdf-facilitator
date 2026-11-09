/**
 * config.ts — environment parsing, validated once at startup.
 *
 * Only non-secret values come from the environment. The signer key is read
 * from a file (see keyfile.ts); it never appears in env, argv or a log line.
 */

export interface Config {
  port: number;
  keyPath: string;
  rpc: { base: string; baseSepolia: string };
  balancePollMs: number;
  gasThresholdWei: bigint;
  maxBodyBytes: number;
  rateLimitPerMinute: number;
  confirmationTimeoutMs: number;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}, got ${value}`);
  return value;
}

function urlEnv(name: string, fallback: string): string {
  const raw = process.env[name] ?? fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} is not a URL: "${raw}"`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`${name} must be http(s)`);
  return parsed.toString().replace(/\/$/, "");
}

export function loadConfig(): Config {
  return {
    port: intEnv("PORT", 8080, 1, 65535),
    keyPath: process.env.KEY_PATH ?? "/run/secrets/facilitator_signer_key",
    rpc: {
      base: urlEnv("BASE_RPC_URL", "https://mainnet.base.org"),
      baseSepolia: urlEnv("BASE_SEPOLIA_RPC_URL", "https://sepolia.base.org"),
    },
    // 5 minutes: the plan's polling interval for /health balances.
    balancePollMs: intEnv("BALANCE_POLL_MS", 300_000, 10_000, 3_600_000),
    // 0.0005 ETH: the plan's low-gas alert floor (~150k gas at 0.003 gwei).
    gasThresholdWei: BigInt(
      process.env.GAS_THRESHOLD_WEI ?? "500000000000000"
    ),
    maxBodyBytes: intEnv("MAX_BODY_BYTES", 65_536, 1_024, 1_048_576),
    rateLimitPerMinute: intEnv("RATE_LIMIT_PER_MINUTE", 240, 10, 100_000),
    confirmationTimeoutMs: intEnv("CONFIRMATION_TIMEOUT_MS", 25_000, 1_000, 170_000),
  };
}
