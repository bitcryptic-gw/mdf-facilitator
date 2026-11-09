/**
 * privileges.ts — drop from root to the app uid.
 *
 * The Unraid Tailscale hook runs as root (it installs packages, starts
 * tailscaled and needs NET_ADMIN), then execs this process. Drop to the
 * unprivileged uid before the key is read or the socket is opened, so the
 * facilitator itself never runs as root and the key-file ownership check still
 * means something. A no-op when the container already starts as the app user.
 */

import type { Logger } from "./log.ts";

export function dropTarget(env: Record<string, string | undefined> = process.env): {
  uid: number;
  gid: number;
} {
  const uid = Number(env.APP_UID ?? 1000);
  const gid = Number(env.APP_GID ?? 1000);
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid <= 0 || gid < 0) {
    throw new Error("APP_UID/APP_GID must be positive integers");
  }
  return { uid, gid };
}

export function dropPrivileges(log: Logger): void {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  const { uid, gid } = dropTarget(process.env);

  const { setgroups, setgid, setuid } = process;
  if (!setgroups || !setgid || !setuid) {
    throw new Error("cannot drop privileges: process.setuid is unavailable");
  }
  setgroups([]);
  setgid(gid);
  setuid(uid);
  if (process.getuid() !== uid) throw new Error("privilege drop failed");
  log.info({ msg: "dropped privileges", uid: `${uid}:${gid}` });
}
