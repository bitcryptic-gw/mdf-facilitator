/**
 * health.ts — cached balances for /health.
 *
 * Balances are polled in the background and served from the cache. /health is
 * hit by Caddy active checks and by Uptime Kuma, so a live RPC call per
 * request would turn monitoring into load on the RPC provider.
 */

export type HealthStatus = "ok" | "degraded";

export interface BalanceSource {
  network: string;
  address: string;
  getBalance(): Promise<bigint>;
}

export interface SignerHealth {
  network: string;
  address: string;
  balanceWei: string;
  thresholdWei: string;
  ok: boolean;
  updatedAt: string | null;
}

export interface HealthSnapshot {
  status: HealthStatus;
  version: string;
  uptimeSeconds: number;
  balancesUpdatedAt: string | null;
  stale: boolean;
  signers: SignerHealth[];
}

export interface MonitorOptions {
  sources: BalanceSource[];
  thresholdWei: bigint;
  pollMs: number;
  version: string;
  startedAt?: number;
  now?: () => number;
  log?: (fields: Record<string, unknown>) => void;
}

export class BalanceMonitor {
  private readonly opts: MonitorOptions;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private balances = new Map<string, { wei: bigint; at: number }>();

  constructor(opts: MonitorOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    // Fire immediately, but do not block startup on the RPC: a facilitator
    // must accept traffic even while the first balance read is in flight.
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    for (const source of this.opts.sources) {
      try {
        const wei = await source.getBalance();
        this.balances.set(source.network, { wei, at: this.now() });
      } catch (error) {
        this.opts.log?.({
          msg: "balance poll failed",
          network: source.network,
          err: (error as Error)?.message?.slice(0, 120),
        });
      }
    }
  }

  snapshot(): HealthSnapshot {
    const now = this.now();
    const staleAfter = this.opts.pollMs * 3;
    let stale = false;

    const signers: SignerHealth[] = this.opts.sources.map((source) => {
      const entry = this.balances.get(source.network);
      if (!entry) {
        stale = true;
        return {
          network: source.network,
          address: source.address,
          balanceWei: "0",
          thresholdWei: this.opts.thresholdWei.toString(),
          ok: false,
          updatedAt: null,
        };
      }
      if (now - entry.at > staleAfter) stale = true;
      return {
        network: source.network,
        address: source.address,
        balanceWei: entry.wei.toString(),
        thresholdWei: this.opts.thresholdWei.toString(),
        ok: entry.wei >= this.opts.thresholdWei,
        updatedAt: new Date(entry.at).toISOString(),
      };
    });

    const updated = signers
      .map((s) => s.updatedAt)
      .filter((v): v is string => v !== null)
      .sort()
      .at(-1) ?? null;

    return {
      status: stale || signers.some((s) => !s.ok) ? "degraded" : "ok",
      version: this.opts.version,
      uptimeSeconds: Math.round((now - (this.opts.startedAt ?? now)) / 1000),
      balancesUpdatedAt: updated,
      stale,
      signers,
    };
  }
}
