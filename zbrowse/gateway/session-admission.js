export function createSessionAdmission(maxSessions) {
  const pendingIps = new Set();

  function tryReserve(ip, activeSessions) {
    if (pendingIps.has(ip)) {
      return { ok: false, reason: 'pending' };
    }
    if (activeSessions + pendingIps.size >= maxSessions) {
      return { ok: false, reason: 'capacity' };
    }
    pendingIps.add(ip);
    return { ok: true };
  }

  function release(ip) {
    pendingIps.delete(ip);
  }

  return {
    tryReserve,
    release,
    get pendingCount() {
      return pendingIps.size;
    }
  };
}
