import { isSessionExpired } from "./session-lifetime.js";

export function liveSessionCount(sessions, idleMs, now = Date.now()) {
  let count = 0;
  for (const session of sessions.values()) {
    if (!isSessionExpired(session, idleMs, now)) count += 1;
  }
  return count;
}
