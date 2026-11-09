/**
 * http.ts — the HTTP surface: /health, /supported, /verify, /settle.
 *
 * Four routes, no framework. Everything the server accepts is size-limited and
 * type-checked before it reaches the x402 library, and nothing from a request
 * body is ever logged.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "./log.ts";
import type { HealthSnapshot } from "./health.ts";

export interface FacilitatorLike {
  verify(payload: unknown, requirements: unknown): Promise<Record<string, unknown>>;
  settle(payload: unknown, requirements: unknown): Promise<Record<string, unknown>>;
  getSupported(): unknown;
}

export interface AppDeps {
  facilitator: FacilitatorLike;
  health(): HealthSnapshot;
  version: string;
  maxBodyBytes: number;
  rateLimitPerMinute: number;
  log: Logger;
  now?: () => number;
}

interface RateEntry {
  count: number;
  resetAt: number;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, "content-length": Buffer.byteLength(payload), ...extra });
  res.end(payload);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class BodyTooLargeError extends Error {}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = Number.parseInt(req.headers["content-length"] ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyTooLargeError(`content-length ${declared} exceeds ${maxBytes}`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new BodyTooLargeError(`body exceeds ${maxBytes} bytes`);
    chunks.push(buf);
  }
  if (total === 0) throw new SyntaxError("empty body");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createHandler(deps: AppDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const now = deps.now ?? Date.now;
  const buckets = new Map<string, RateEntry>();

  const rateLimited = (ip: string): boolean => {
    const t = now();
    const entry = buckets.get(ip);
    if (!entry || t >= entry.resetAt) {
      buckets.set(ip, { count: 1, resetAt: t + 60_000 });
      return false;
    }
    entry.count += 1;
    return entry.count > deps.rateLimitPerMinute;
  };

  // Keep the map from growing without bound on a busy or hostile network.
  setInterval(() => {
    const t = now();
    for (const [ip, entry] of buckets) if (t >= entry.resetAt) buckets.delete(ip);
  }, 60_000).unref?.();

  const handlePayment = async (req: IncomingMessage, res: ServerResponse, route: "verify" | "settle") => {
    let body: unknown;
    try {
      body = await readJson(req, deps.maxBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return send(res, 413, { error: "request body too large" });
      }
      return send(res, 400, { error: "request body must be JSON" });
    }

    if (!isObject(body) || !isObject(body.paymentPayload) || !isObject(body.paymentRequirements)) {
      return send(res, 400, { error: "paymentPayload and paymentRequirements are required objects" });
    }

    const requirements = body.paymentRequirements;
    const context = {
      network: typeof requirements.network === "string" ? requirements.network : undefined,
      scheme: typeof requirements.scheme === "string" ? requirements.scheme : undefined,
    };

    try {
      if (route === "verify") {
        const result = await deps.facilitator.verify(body.paymentPayload, requirements);
        deps.log.info({
          msg: "verify",
          ...context,
          outcome: result.isValid === true ? "valid" : "invalid",
          reason: typeof result.invalidReason === "string" ? result.invalidReason : undefined,
        });
        return send(res, 200, result);
      }
      const result = await deps.facilitator.settle(body.paymentPayload, requirements);
      deps.log.info({
        msg: "settle",
        ...context,
        outcome: result.success === true ? "settled" : "failed",
        reason: typeof result.errorReason === "string" ? result.errorReason : undefined,
      });
      return send(res, 200, result);
    } catch (error) {
      // A thrown error is a facilitator-side failure, not a payment verdict.
      // The detail goes to the log, not to the caller.
      deps.log.error({
        msg: `${route} failed`,
        ...context,
        err: (error as Error)?.message?.slice(0, 160),
      });
      return send(res, 500, { error: "internal error" });
    }
  };

  return (req, res) => {
    const started = now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const ip = req.socket.remoteAddress ?? "unknown";

    const finish = (status: number, extra?: Record<string, unknown>) => {
      deps.log.info({ msg: "request", method, path, status, ms: now() - started, ...extra });
    };

    if (rateLimited(ip)) {
      finish(429);
      return send(res, 429, { error: "rate limited" }, { "retry-after": "60" });
    }

    if (method === "GET" && path === "/health") {
      finish(200);
      const snapshot = deps.health();
      return send(res, 200, snapshot);
    }

    if (method === "GET" && path === "/supported") {
      finish(200);
      return send(res, 200, deps.facilitator.getSupported());
    }

    if (method === "POST" && (path === "/verify" || path === "/settle")) {
      const route = path === "/verify" ? "verify" : "settle";
      return handlePayment(req, res, route).then(
        () => finish(200),
        () => {
          finish(500);
          send(res, 500, { error: "internal error" });
        }
      );
    }

    if (path === "/verify" || path === "/settle") {
      finish(405);
      return send(res, 405, { error: "method not allowed" }, { allow: "POST" });
    }
    if (path === "/health" || path === "/supported") {
      finish(405);
      return send(res, 405, { error: "method not allowed" }, { allow: "GET" });
    }

    finish(404);
    return send(res, 404, { error: "not found" });
  };
}
