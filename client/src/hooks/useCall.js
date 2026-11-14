import { useCallback, useEffect, useRef, useState } from 'react';
import useRecorder from './useRecorder';
import { canPlayAudio, startRinging, stopRinging } from '../utils/ringer';
import { isAway, showNotification, startTitleFlash, stopTitleFlash } from '../utils/alerts';
import {
  cameraFacing,
  getMedia,
  hasRelay,
  listCameras,
  loadIceServers,
  mediaErrorMessage,
  openCamera,
} from '../utils/rtc';
import useWakeLock from './useWakeLock';

// A dropped connection (Wi-Fi -> 4G, a tunnel, a locked screen) gets this long to come back
const GIVE_UP_MS = 25000;
const MAX_ICE_RESTARTS = 3;

/**
 * Handles the whole call lifecycle with WebRTC + Socket.IO signalling.
 * status: idle | calling | incoming | connecting | connected
 */
export default function useCall(socket) {
  const [status, setStatus] = useState('idle');
  const [peer, setPeer] = useState(null); // { id, name, email }
  const [callType, setCallType] = useState('audio');
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [notice, setNotice] = useState('');
  const [peerRecording, setPeerRecording] = useState(false); // the other person is recording
  const [calleeOffline, setCalleeOffline] = useState(false); // ringing someone who is offline (we emailed them)
  const [reconnecting, setReconnecting] = useState(false); // the network dropped mid-call, trying to get back
  const [facing, setFacing] = useState('user'); // which way my camera faces: 'user' (front) | 'environment' (back)
  const [canSwitchCamera, setCanSwitchCamera] = useState(false); // this device has more than one camera

  const recorder = useRecorder({ onSaved: () => setNotice('Recording saved to your downloads.') });
  const stopRecorder = recorder.stop;

  const pcRef = useRef(null);
  const localRef = useRef(null);
  const remoteRef = useRef(null);
  const peerRef = useRef(null);
  const pendingIce = useRef([]);
  const incomingRef = useRef(null);
  const statusRef = useRef('idle');
  const isCallerRef = useRef(false); // only the caller sends ICE-restart offers (stops both sides offering at once)
  const everConnectedRef = useRef(false);
  const restartsRef = useRef(0);
  const timersRef = useRef({ disconnect: null, giveUp: null });
  const switchingRef = useRef(false);

  const changeStatus = useCallback((next) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  // Release camera/mic, close the connection and reset everything
  const cleanup = useCallback(() => {
    clearTimeout(timersRef.current.disconnect);
    clearTimeout(timersRef.current.giveUp);
    timersRef.current = { disconnect: null, giveUp: null };
    restartsRef.current = 0;
    everConnectedRef.current = false;
    isCallerRef.current = false;
    switchingRef.current = false;

    const pc = pcRef.current;
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
      pcRef.current = null;
    }
    stopRecorder(); // saves the recording (if any) before the streams go away
    if (localRef.current) {
      localRef.current.getTracks().forEach((t) => t.stop());
      localRef.current = null;
    }
    remoteRef.current = null;
    pendingIce.current = [];
    incomingRef.current = null;
    peerRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setPeer(null);
    setMuted(false);
    setCameraOff(false);
    setPeerRecording(false);
    setCalleeOffline(false);
    setReconnecting(false);
    setFacing('user');
    setCanSwitchCamera(false);
    changeStatus('idle');
  }, [changeStatus, stopRecorder]);

  const flushIce = useCallback(async (pc) => {
    const queued = pendingIce.current;
    pendingIce.current = [];
    for (const c of queued) {
      try {
        await pc.addIceCandidate(c);
      } catch (e) {
        console.warn('ICE candidate error', e);
      }
    }
  }, []);

  // The connection dropped: ask for fresh network paths (the caller sends the new offer),
  // and hang up properly if nothing works within GIVE_UP_MS.
  const restartIce = useCallback(
    async (pc, peerId) => {
      if (pcRef.current !== pc || statusRef.current === 'idle') return;

      const timers = timersRef.current;
      if (!timers.giveUp) {
        timers.giveUp = setTimeout(() => {
          timers.giveUp = null;
          if (pcRef.current === pc && pc.connectionState !== 'connected') {
            socket.emit('call:end', { to: peerId });
            setNotice('Connection lost. Check your network and try again.');
            cleanup();
          }
        }, GIVE_UP_MS);
      }

      if (!isCallerRef.current || restartsRef.current >= MAX_ICE_RESTARTS) return;
      restartsRef.current += 1;
      try {
        if (pc.restartIce) pc.restartIce();
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        socket.emit('call:negotiate', { to: peerId, description: offer });
      } catch (e) {
        console.warn('ICE restart failed', e);
      }
    },
    [socket, cleanup]
  );

  const createPeer = useCallback(
    (peerId, stream, servers) => {
      const pc = new RTCPeerConnection({ iceServers: servers });
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit('call:ice', { to: peerId, candidate: e.candidate });
      };
      pc.ontrack = (e) => {
        remoteRef.current = e.streams[0];
        setRemoteStream(e.streams[0]);
      };
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        const timers = timersRef.current;
        clearTimeout(timers.disconnect);

        if (state === 'connected') {
          clearTimeout(timers.giveUp);
          timers.giveUp = null;
          restartsRef.current = 0;
          everConnectedRef.current = true;
          setReconnecting(false);
          changeStatus('connected');
        } else if (state === 'disconnected' && everConnectedRef.current) {
          // Usually a short blip: wait a few seconds, then ask for new network paths
          setReconnecting(true);
          timers.disconnect = setTimeout(() => restartIce(pc, peerId), 3000);
        } else if (state === 'failed') {
          if (everConnectedRef.current) {
            setReconnecting(true);
            restartIce(pc, peerId);
          } else {
            // Never got through at all. Look at what this phone managed to gather to say why.
            (async () => {
              let relayCandidate = false;
              try {
                const stats = await pc.getStats();
                stats.forEach((r) => {
                  if (r.type === 'local-candidate' && r.candidateType === 'relay') relayCandidate = true;
                });
              } catch {
                // ignore
              }
              console.warn('[call] could not connect. TURN configured on server:', hasRelay(), '| relay candidate found:', relayCandidate);
              socket.emit('call:end', { to: peerId });
              setNotice(
                !hasRelay()
                  ? "Couldn't connect: the server has no TURN relay set up, which phones on mobile data need."
                  : !relayCandidate
                  ? "Couldn't connect: the TURN relay did not respond. Check its address and credentials."
                  : "Couldn't connect, even through the relay. Check both internet connections and try again."
              );
              cleanup();
            })();
          }
        }
      };
      return pc;
    },
    [socket, changeStatus, cleanup, restartIce]
  );

  // ---- actions -----------------------------------------------------------
  const startCall = useCallback(
    async (contactUser, type = 'audio') => {
      if (!socket || statusRef.current !== 'idle') return;
      setNotice('');
      try {
        const [stream, servers] = await Promise.all([getMedia(type), loadIceServers()]);
        localRef.current = stream;
        peerRef.current = contactUser;
        isCallerRef.current = true;

        setLocalStream(stream);
        setPeer(contactUser);
        setCallType(type);
        changeStatus('calling');

        setFacing(cameraFacing(stream));

        const pc = createPeer(contactUser.id, stream, servers);
        pcRef.current = pc;

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('call:invite', { to: contactUser.id, offer, callType: type });
      } catch (err) {
        console.error(err);
        setNotice(mediaErrorMessage(err));
        cleanup();
      }
    },
    [socket, createPeer, changeStatus, cleanup]
  );

  const acceptCall = useCallback(async () => {
    const incoming = incomingRef.current;
    if (!incoming || !socket) return;

    try {
      const [stream, servers] = await Promise.all([getMedia(incoming.callType), loadIceServers()]);

      // The caller may have hung up while the permission prompt was open
      if (peerRef.current?.id !== incoming.from.id) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      localRef.current = stream;
      setLocalStream(stream);
      setFacing(cameraFacing(stream));
      changeStatus('connecting');

      const pc = createPeer(incoming.from.id, stream, servers);
      pcRef.current = pc;

      await pc.setRemoteDescription(incoming.offer);
      await flushIce(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('call:answer', { to: incoming.from.id, answer });
    } catch (err) {
      console.error(err);
      setNotice(mediaErrorMessage(err));
      socket.emit('call:reject', { to: incoming.from.id });
      cleanup();
    }
  }, [socket, createPeer, flushIce, changeStatus, cleanup]);

  const rejectCall = useCallback(() => {
    const incoming = incomingRef.current;
    if (incoming && socket) socket.emit('call:reject', { to: incoming.from.id });
    cleanup();
  }, [socket, cleanup]);

  const hangUp = useCallback(() => {
    if (peerRef.current && socket) socket.emit('call:end', { to: peerRef.current.id });
    cleanup();
  }, [socket, cleanup]);

  const toggleMute = useCallback(() => {
    const tracks = localRef.current?.getAudioTracks() || [];
    tracks.forEach((t) => (t.enabled = !t.enabled));
    setMuted(tracks.length > 0 && !tracks[0].enabled);
  }, []);

  const toggleCamera = useCallback(() => {
    const tracks = localRef.current?.getVideoTracks() || [];
    tracks.forEach((t) => (t.enabled = !t.enabled));
    setCameraOff(tracks.length > 0 && !tracks[0].enabled);
  }, []);

  // Front <-> back camera (or the next webcam on a laptop) without interrupting the call
  const switchCamera = useCallback(async () => {
    const stream = localRef.current;
    const old = stream?.getVideoTracks()[0];
    if (!old || switchingRef.current) return;
    switchingRef.current = true;

    const wasEnabled = old.enabled;
    const oldSettings = old.getSettings ? old.getSettings() : {};
    const current = cameraFacing(stream);
    const wanted = current === 'user' ? 'environment' : 'user';

    old.stop(); // release it first: most phones can only open one camera at a time
    let track = null;
    try {
      try {
        track = await openCamera({ facing: wanted });
      } catch {
        // No camera that faces that way (a laptop with two webcams, say): step to the next device
        const cams = await listCameras();
        const i = cams.findIndex((c) => c.deviceId === oldSettings.deviceId);
        const next = cams[(i + 1) % cams.length];
        if (!next || next.deviceId === oldSettings.deviceId) throw new Error('no other camera');
        track = await openCamera({ deviceId: next.deviceId });
      }
    } catch (err) {
      console.warn('Could not switch camera', err);
      try {
        track = await openCamera({ deviceId: oldSettings.deviceId, facing: current }); // bring the old one back
        setNotice("Couldn't switch the camera.");
      } catch {
        setNotice('The camera stopped working.');
      }
    }

    if (track) {
      track.enabled = wasEnabled;
      const sender = pcRef.current?.getSenders().find((s) => s.track === old);
      if (sender) await sender.replaceTrack(track).catch((e) => console.warn('replaceTrack failed', e));

      stream.removeTrack(old);
      stream.addTrack(track);
      const updated = new MediaStream(stream.getTracks());
      localRef.current = updated;
      setLocalStream(updated);
      setFacing(cameraFacing(updated));
    }
    switchingRef.current = false;
  }, []);

  const toggleRecording = useCallback(() => {
    const other = peerRef.current;
    if (recorder.recording) {
      recorder.stop();
      if (other) socket.emit('call:recording', { to: other.id, recording: false });
      return;
    }
    if (statusRef.current !== 'connected' || !localRef.current || !remoteRef.current || !other) return;

    const started = recorder.start({
      local: localRef.current,
      remote: remoteRef.current,
      video: callType === 'video',
      label: other.name,
    });
    if (started) {
      // Let the other person know (they see a "recording" banner)
      socket.emit('call:recording', { to: other.id, recording: true });
    } else {
      setNotice('Recording is not supported in this browser.');
    }
  }, [socket, recorder, callType]);

  // Keep the phone's screen on during a call (a locked screen kills the connection)
  useWakeLock(['calling', 'connecting', 'connected'].includes(status));

  // Show the flip-camera button only when there is more than one camera
  useEffect(() => {
    if (!localStream || callType !== 'video') {
      setCanSwitchCamera(false);
      return undefined;
    }
    let cancelled = false;
    const check = () =>
      listCameras()
        .then((cams) => !cancelled && setCanSwitchCamera(cams.length > 1))
        .catch(() => {});
    check();
    navigator.mediaDevices?.addEventListener?.('devicechange', check);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.('devicechange', check);
    };
  }, [localStream, callType]);

  // Warm the ICE-server cache so starting or answering a call does not wait for it
  useEffect(() => {
    if (socket) loadIceServers();
  }, [socket]);

  // ---- sounds ------------------------------------------------------------
  // Incoming ring for the callee, ringback tone for the caller, silence otherwise
  useEffect(() => {
    if (status === 'incoming') startRinging('incoming');
    else if (status === 'calling') startRinging('ringback');
    else stopRinging();
    return stopRinging;
  }, [status]);

  // ---- background-tab alerts for an incoming call -------------------------
  useEffect(() => {
    if (status !== 'incoming' || !peer) return;

    let notification = null;
    const sync = () => {
      if (isAway()) {
        if (!notification) {
          notification = showNotification(`Incoming ${callType === 'video' ? 'video' : 'voice'} call`, {
            body: peer.name,
            tag: 'incoming-call',
            requireInteraction: true,
            silent: canPlayAudio(), // we're already ringing in-page; let the OS beep only if we can't
          });
        }
        startTitleFlash(`📞 ${peer.name} is calling…`);
      } else {
        stopTitleFlash();
        notification?.close();
        notification = null;
      }
    };

    sync();
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      stopTitleFlash();
      notification?.close();
    };
  }, [status, peer, callType]);

  // ---- signalling events -------------------------------------------------
  useEffect(() => {
    if (!socket) return;

    const onIncoming = ({ from, offer, callType: type }) => {
      incomingRef.current = { from, offer, callType: type };
      peerRef.current = from;
      pendingIce.current = [];
      setPeer(from);
      setCallType(type);
      changeStatus('incoming');
    };

    const onAnswered = async ({ answer }) => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        await pc.setRemoteDescription(answer);
        await flushIce(pc);
        if (statusRef.current === 'calling') changeStatus('connecting');
      } catch (e) {
        console.error(e);
      }
    };

    const onIce = async ({ candidate }) => {
      const pc = pcRef.current;
      if (pc && pc.remoteDescription) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (e) {
          console.warn('ICE candidate error', e);
        }
      } else {
        // Remote description isn't set yet, hold on to it
        pendingIce.current.push(candidate);
      }
    };

    // The other side restarted ICE after a network change: answer it (or take their answer)
    const onNegotiate = async ({ description }) => {
      const pc = pcRef.current;
      const peerId = peerRef.current?.id;
      if (!pc || !peerId || !description) return;
      try {
        if (description.type === 'offer') {
          await pc.setRemoteDescription(description);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('call:negotiate', { to: peerId, description: answer });
        } else if (description.type === 'answer') {
          await pc.setRemoteDescription(description);
        }
      } catch (e) {
        console.warn('Renegotiation failed', e);
      }
    };

    const onRejected = () => {
      if (statusRef.current === 'idle') return; // stale event (e.g. another tab of mine)
      setNotice(`${peerRef.current?.name || 'The user'} declined the call.`);
      cleanup();
    };

    const missedCallAlert = (name) => {
      setNotice(name ? `Missed call from ${name}.` : 'Missed call.');
      if (isAway()) {
        showNotification('Missed call', { body: name ? `From ${name}` : undefined, tag: 'missed-call' });
      }
    };

    const onEnded = () => {
      if (statusRef.current === 'idle') return;
      if (statusRef.current === 'incoming') missedCallAlert(peerRef.current?.name);
      else setNotice('Call ended.');
      cleanup();
    };

    // Nobody answered within the server's ring timeout
    const onTimeout = () => {
      const s = statusRef.current;
      if (s === 'idle') return;
      const name = peerRef.current?.name;
      if (s === 'incoming') missedCallAlert(name);
      else if (s === 'calling') setNotice(`${name || 'The user'} didn't answer.`);
      else setNotice('The call timed out.');
      cleanup();
    };

    // I answered or declined in another tab: stop ringing here without a fuss
    const onHandled = () => {
      if (statusRef.current === 'incoming') cleanup();
    };

    const onRemoteRecording = ({ recording }) => setPeerRecording(!!recording);

    // Callee is offline: the server keeps ringing and has emailed them
    const onOfflineRinging = () => setCalleeOffline(true);
    // They opened the app and the call is now ringing on their screen
    const onRinging = () => setCalleeOffline(false);

    const onNotAllowed = ({ reason }) => {
      const name = peerRef.current?.name || 'this person';
      setNotice(
        reason === 'blocked_by_me'
          ? `You blocked ${name}. Unblock them to call.`
          : 'You can only call people who have accepted your contact request.'
      );
      cleanup();
    };

    const onBusy = ({ self } = {}) => {
      setNotice(self ? 'You are already in a call.' : `${peerRef.current?.name || 'The user'} is busy on another call.`);
      cleanup();
    };

    // Tell the server we're listening, so a call that came in while we were offline is delivered now
    const announceReady = () => socket.emit('call:ready');

    socket.on('call:incoming', onIncoming);
    socket.on('call:answered', onAnswered);
    socket.on('call:ice', onIce);
    socket.on('call:negotiate', onNegotiate);
    socket.on('call:rejected', onRejected);
    socket.on('call:ended', onEnded);
    socket.on('call:offline-ringing', onOfflineRinging);
    socket.on('call:ringing', onRinging);
    socket.on('call:not-allowed', onNotAllowed);
    socket.on('call:busy', onBusy);
    socket.on('call:timeout', onTimeout);
    socket.on('call:handled', onHandled);
    socket.on('call:recording', onRemoteRecording);
    socket.on('connect', announceReady);
    if (socket.connected) announceReady();

    return () => {
      socket.off('call:incoming', onIncoming);
      socket.off('call:answered', onAnswered);
      socket.off('call:ice', onIce);
      socket.off('call:negotiate', onNegotiate);
      socket.off('call:rejected', onRejected);
      socket.off('call:ended', onEnded);
      socket.off('call:offline-ringing', onOfflineRinging);
      socket.off('call:ringing', onRinging);
      socket.off('call:not-allowed', onNotAllowed);
      socket.off('call:busy', onBusy);
      socket.off('call:timeout', onTimeout);
      socket.off('call:handled', onHandled);
      socket.off('call:recording', onRemoteRecording);
      socket.off('connect', announceReady);
    };
  }, [socket, changeStatus, cleanup, flushIce]);

  // Auto-dismiss notices
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // Release devices if the component unmounts mid-call
  useEffect(() => cleanup, [cleanup]);

  return {
    status,
    peer,
    callType,
    localStream,
    remoteStream,
    muted,
    cameraOff,
    notice,
    calleeOffline,
    reconnecting,
    facing,
    canSwitchCamera,
    recording: recorder.recording,
    peerRecording,
    startCall,
    acceptCall,
    rejectCall,
    hangUp,
    toggleMute,
    toggleCamera,
    switchCamera,
    toggleRecording,
  };
}
