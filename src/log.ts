/**
 * log.ts — structured JSON logs with a strict allowlist of fields.
 *
 * A facilitator sees payment payloads, signatures and authorizations. None of
 * that belongs in a log line: the #56 run recorded signatures by length only,
 * and the same rule applies here. Callers pass named fields; anything else is
 * dropped.
 */

type Level = "info" | "warn" | "error";

const ALLOWED = new Set([
  "msg",
  "method",
  "path",
  "status",
  "ms",
  "network",
  "scheme",
  "outcome",
  "reason",
  "address",
  "signerCount",
  "balanceWei",
  "thresholdWei",
  "err",
  "uptimeSeconds",
  "uid",
]);

export interface Logger {
  info(fields: Record<string, unknown>): void;
  warn(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
}

export function createLogger(stream: { write(chunk: string): unknown } = process.stdout): Logger {
  const emit = (level: Level, fields: Record<string, unknown>) => {
    const out: Record<string, unknown> = { ts: new Date().toISOString(), level };
    for (const [key, value] of Object.entries(fields)) {
      if (ALLOWED.has(key)) out[key] = value;
    }
    stream.write(`${JSON.stringify(out)}\n`);
  };
  return {
    info: (fields) => emit("info", fields),
    warn: (fields) => emit("warn", fields),
    error: (fields) => emit("error", fields),
  };
}
