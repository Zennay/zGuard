export function isSessionExpired(session, idleMs, now = Date.now()) {
  return session.expiresAt <= now || session.lastSeenAt + idleMs <= now;
}
