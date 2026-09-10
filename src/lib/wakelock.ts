/**
 * Keep the screen on while a Live Session records (Screen Wake Lock API). The browser drops the
 * lock whenever the tab is hidden, so it is re-requested on return while still recording.
 * Silently a no-op where unsupported (Firefox desktop, older Safari) or when the request is denied.
 */
let lock: WakeLockSentinel | null = null
let wanted = false

async function acquire(): Promise<void> {
  if (!wanted || lock || document.visibilityState !== 'visible') return
  try {
    lock = await navigator.wakeLock.request('screen')
    lock.addEventListener('release', () => {
      lock = null
    })
  } catch {
    /* denied or unsupported */
  }
}

export function syncWakeLock(active: boolean): void {
  if (!('wakeLock' in navigator)) return
  wanted = active
  if (active) void acquire()
  else if (lock) void lock.release()
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => void acquire())
}
