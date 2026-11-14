// Shared WebRTC helpers for 1:1 and group calls.
import api from '../services/api';

// Used only if the server cannot be reached for its list. Free STUN alone is NOT enough for phones on
// mobile data: set TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL (or the METERED_* pair) on the server.
export const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// Optional build-time TURN relay (older setup). The server list below is preferred.
if (import.meta.env.VITE_TURN_URL) {
  iceServers.push({
    urls: import.meta.env.VITE_TURN_URL,
    username: import.meta.env.VITE_TURN_USER,
    credential: import.meta.env.VITE_TURN_PASS,
  });
}

// STUN + TURN list from the server, cached for a few minutes. Never throws.
let iceCache = { at: 0, servers: null, relay: false };

// True when the server says a TURN relay is configured (false until the list has been loaded)
export const hasRelay = () => iceCache.relay;
export async function loadIceServers() {
  if (iceCache.servers && Date.now() - iceCache.at < 10 * 60 * 1000) return iceCache.servers;
  try {
    const { data } = await api.get('/calls/ice-servers');
    if (Array.isArray(data.iceServers) && data.iceServers.length) {
      iceCache = { at: Date.now(), servers: data.iceServers, relay: !!data.relay };
      if (!data.relay) {
        console.warn('No TURN relay configured on the server: calls from mobile networks may not connect.');
      }
      return iceCache.servers;
    }
  } catch (err) {
    console.warn('Could not load ICE servers, using the defaults', err);
  }
  return iceServers;
}

const VIDEO_CONSTRAINTS = {
  facingMode: 'user',
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 24, max: 30 }, // phones on mobile data cope better with 24 fps
};

export function getMedia(type) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('insecure');
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: type === 'video' ? VIDEO_CONSTRAINTS : false,
  });
}

// ---- cameras -----------------------------------------------------------------------------
// 'user' = front camera (also what a laptop webcam reports), 'environment' = back camera
export function cameraFacing(stream) {
  const track = stream?.getVideoTracks?.()[0];
  const facing = track?.getSettings?.().facingMode;
  return facing === 'environment' ? 'environment' : 'user';
}

export async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'videoinput');
}

// Opens one camera and returns its video track. Pass a deviceId, or which way it should face.
export async function openCamera({ facing, deviceId } = {}) {
  const video = { ...VIDEO_CONSTRAINTS };
  if (deviceId) {
    delete video.facingMode;
    video.deviceId = { exact: deviceId };
  } else if (facing) {
    video.facingMode = { exact: facing };
  }
  const stream = await navigator.mediaDevices.getUserMedia({ video });
  return stream.getVideoTracks()[0];
}

export function mediaErrorMessage(err) {
  if (err?.message === 'insecure') {
    return 'Calls need HTTPS (or localhost) to access the microphone and camera.';
  }
  if (err?.name === 'NotAllowedError') {
    return 'Microphone/camera permission was denied.';
  }
  if (err?.name === 'NotFoundError') {
    return 'No microphone or camera was found.';
  }
  if (err?.name === 'NotReadableError') {
    return 'Your microphone or camera is being used by another app.';
  }
  return 'Could not start the call.';
}
