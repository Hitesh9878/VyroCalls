import { useEffect, useRef, useState } from 'react';
import { Check, Speaker } from './Icons';
import './AudioOutputMenu.css';

// Button + pop-up list for choosing where the call sound plays (speaker, earpiece, Bluetooth ...).
// `output` comes from useAudioOutput().
export default function AudioOutputMenu({ output }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close when tapping anywhere else
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const labelOf = (d, i) => {
    if (d.deviceId === 'default') return 'Default (system choice)';
    return d.label || `Audio output ${i + 1}`;
  };

  return (
    <div className="ao" ref={ref}>
      <button
        className={`btn ${open ? 'active' : ''}`}
        title="Audio output (speaker, earpiece, Bluetooth…)"
        onClick={() => setOpen((o) => !o)}
      >
        <Speaker size={22} />
      </button>

      {open && (
        <div className="ao-menu" role="menu">
          <div className="ao-title">Play sound through</div>

          {!output.supported && (
            <p className="ao-note">
              This browser can't switch the audio output by itself. Use your device's sound controls to move the
              call between the speaker, earpiece or a Bluetooth device.
            </p>
          )}

          {output.supported && output.devices.length === 0 && (
            <p className="ao-note">No audio outputs found yet. Connect a device and it will show up here.</p>
          )}

          {output.supported &&
            output.devices.map((d, i) => (
              <button
                key={d.deviceId}
                className={`ao-item ${d.deviceId === output.activeId ? 'on' : ''}`}
                role="menuitemradio"
                aria-checked={d.deviceId === output.activeId}
                onClick={() => {
                  output.select(d.deviceId);
                  setOpen(false);
                }}
              >
                <span>{labelOf(d, i)}</span>
                {d.deviceId === output.activeId && <Check size={16} />}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
