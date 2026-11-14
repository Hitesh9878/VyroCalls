import { useEffect } from 'react';

// Keeps the phone's screen on while `active` is true. A locked screen suspends the page, which
// drops the socket and freezes the camera, so calls on mobile die without this.
// (Needs a browser with the Screen Wake Lock API; elsewhere it quietly does nothing.)
export default function useWakeLock(active) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return undefined;

    let lock = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        const next = await navigator.wakeLock.request('screen');
        if (cancelled) next.release().catch(() => {});
        else lock = next;
      } catch {
        // denied (e.g. battery saver): nothing to do
      }
    };

    // The lock is released automatically whenever the page is hidden, so ask again on return
    const onVisible = () => {
      if (document.visibilityState === 'visible') acquire();
    };

    acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      lock?.release().catch(() => {});
    };
  }, [active]);
}
