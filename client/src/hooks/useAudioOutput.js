import { useCallback, useEffect, useState } from 'react';

const KEY = 'audio-output-id';

// Sends a <video>/<audio> element's sound to the chosen output device ('default' = system choice)
export function applySink(el, id) {
  if (!el || typeof el.setSinkId !== 'function') return;
  el.setSinkId(!id || id === 'default' ? '' : id).catch((err) => console.warn('Could not change audio output', err));
}

/**
 * Lists the audio outputs the browser exposes (speaker, headphones, Bluetooth ...) and remembers the
 * one the person picked. `supported` is false where the browser has no setSinkId (Safari / iOS, Firefox):
 * there the output can only be changed from the phone's or computer's own sound controls.
 */
export default function useAudioOutput() {
  const supported =
    typeof HTMLMediaElement !== 'undefined' &&
    typeof HTMLMediaElement.prototype.setSinkId === 'function' &&
    !!navigator.mediaDevices?.enumerateDevices;

  const [devices, setDevices] = useState([]);
  const [selected, setSelected] = useState(() => {
    try {
      return localStorage.getItem(KEY) || 'default';
    } catch {
      return 'default';
    }
  });

  useEffect(() => {
    if (!supported) return undefined;
    let cancelled = false;

    const refresh = async () => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) setDevices(all.filter((d) => d.kind === 'audiooutput'));
      } catch {
        // ignore
      }
    };

    refresh();
    // Fires when a Bluetooth device or headphones are connected / removed
    navigator.mediaDevices.addEventListener?.('devicechange', refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.('devicechange', refresh);
    };
  }, [supported]);

  // If the chosen device has been unplugged, fall back to the system default
  const activeId = devices.some((d) => d.deviceId === selected) ? selected : 'default';

  const select = useCallback((id) => {
    setSelected(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      // ignore
    }
  }, []);

  return { supported, devices, activeId, select };
}
