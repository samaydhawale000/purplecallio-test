import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Avatar,
  CameraButton,
  ConnectionStatus,
  LeaveButton,
  MeetingProvider,
  MicrophoneButton,
  ParticipantTile,
  useMeeting,
} from '@purplecallio/react';
import './App.css';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

async function apiRequest(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data?.error?.message || 'The request failed.');
  }

  return data;
}

const displayName = (email) => email.split('@')[0];

function joinErrorMessage(error, signalUrl) {
  switch (error?.name) {
    case 'NotAllowedError':
      return 'Camera/microphone permission was denied. Allow access from the browser address bar and try again.';
    case 'NotFoundError':
      return 'No camera or microphone was found on this device.';
    case 'NotReadableError':
      return 'Your camera or microphone is already in use by another app or tab.';
    default:
      break;
  }
  if (error?.message === 'websocket error') {
    return `Signaling connection failed at ${signalUrl}. Confirm this host provides PurpleCallio Socket.IO over HTTPS/WSS and set PURPLECALLIO_SIGNAL_URL to the correct origin (without /api). Restart the backend after changing it.`;
  }
  return error?.message || 'Could not join the PurpleCallio meeting.';
}

// Re-render when tracks are added/removed or change mute state. The SDK hands
// out the same MediaStream object as tracks arrive, so React would not notice.
function useStreamTracks(stream) {
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!stream) return undefined;
    const bump = () => setVersion((version) => version + 1);
    const watched = new Set();
    const watch = (track) => {
      if (watched.has(track)) return;
      watched.add(track);
      track.addEventListener('mute', bump);
      track.addEventListener('unmute', bump);
      track.addEventListener('ended', bump);
    };
    const onAddTrack = (event) => {
      watch(event.track);
      bump();
    };

    stream.getTracks().forEach(watch);
    stream.addEventListener('addtrack', onAddTrack);
    stream.addEventListener('removetrack', bump);
    return () => {
      stream.removeEventListener('addtrack', onAddTrack);
      stream.removeEventListener('removetrack', bump);
      watched.forEach((track) => {
        track.removeEventListener('mute', bump);
        track.removeEventListener('unmute', bump);
        track.removeEventListener('ended', bump);
      });
    };
  }, [stream]);
}

const hasLiveVideo = (stream) =>
  stream?.getVideoTracks().some((track) => track.enabled && !track.muted && track.readyState === 'live') ?? false;

function useElapsed(running) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return undefined;
    const startedAt = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => {
      clearInterval(timer);
      setSeconds(0);
    };
  }, [running]);
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function CallRoom({ call, currentUser, onHangUp }) {
  const [joinError, setJoinError] = useState('');
  return (
    <MeetingProvider
      key={call.id}
      token={call.participantToken}
      callId={call.id}
      signalUrl={call.signalUrl}
      video={call.type === 'video'}
      audio
    >
      <MeetingShell call={call} currentUser={currentUser} onHangUp={onHangUp} onJoinError={setJoinError} />
      {joinError ? <p className="error-message call-error">{joinError}</p> : null}
    </MeetingProvider>
  );
}

// The SDK's ParticipantTile only plays sound through its <video> element,
// which it renders only when there is video — so audio-only calls would be
// silent. Tiles stay muted and all remote audio goes through this element.
function RemoteAudio({ stream }) {
  const audioRef = useRef(null);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  useStreamTracks(stream);
  const audioTrackCount = stream?.getAudioTracks().length ?? 0;

  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;
    if (element.srcObject !== stream) element.srcObject = stream;
    if (!stream || audioTrackCount === 0) return;
    element.play()
      .then(() => setPlaybackBlocked(false))
      .catch((error) => {
        console.warn('Remote audio playback needs a user gesture:', error.message);
        setPlaybackBlocked(true);
      });
  }, [stream, audioTrackCount]);

  const enablePlayback = () => {
    audioRef.current?.play()
      .then(() => setPlaybackBlocked(false))
      .catch((error) => console.error('Could not start remote audio:', error));
  };

  return (
    <>
      <audio ref={audioRef} autoPlay playsInline aria-label="Remote participant audio" />
      {playbackBlocked ? (
        <button type="button" className="audio-enable-button" onClick={enablePlayback}>
          🔊 Click to enable speaker audio
        </button>
      ) : null}
    </>
  );
}

function MeetingShell({ call, currentUser, onHangUp, onJoinError }) {
  const { join, leave, connectionState, localStream, remoteStream } = useMeeting();
  const isVideo = call.type === 'video';
  const remoteUser = call.caller === currentUser.email ? call.receiver : call.caller;

  useStreamTracks(remoteStream);
  useStreamTracks(localStream);
  const remoteVideoOn = hasLiveVideo(remoteStream);
  const localVideoOn = hasLiveVideo(localStream);
  const elapsed = useElapsed(Boolean(remoteStream));

  useEffect(() => {
    join().catch((error) => onJoinError(joinErrorMessage(error, call.signalUrl)));
    return () => {
      leave();
    };
  }, [join, leave, onJoinError, call.signalUrl]);

  useEffect(() => {
    if (!remoteStream) return;
    console.info(
      '[PurpleCallio] remote tracks:',
      remoteStream.getTracks().map((track) => `${track.kind}:${track.readyState}${track.muted ? ':muted' : ''}`),
    );
  }, [remoteStream]);

  const waitingLabel = connectionState === 'connected'
    ? `Waiting for ${displayName(remoteUser)} to join…`
    : 'Connecting…';

  return (
    <div className="call-shell">
      <header className="call-header">
        <div className="call-peer">
          <Avatar id={remoteUser} size={40} />
          <div>
            <h2>{displayName(remoteUser)}</h2>
            <p>{isVideo ? 'Video call' : 'Audio call'} · {remoteStream ? elapsed : waitingLabel}</p>
          </div>
        </div>
        <ConnectionStatus />
      </header>

      <RemoteAudio stream={remoteStream} />

      {isVideo ? (
        <div className="video-stage">
          {/* key forces a remount so the SDK tile re-attaches srcObject when video (re)appears */}
          <ParticipantTile
            key={`remote-${remoteVideoOn}`}
            className="remote-tile"
            participantId={remoteUser}
            name={displayName(remoteUser)}
            stream={remoteVideoOn ? remoteStream : null}
            muted
          />
          {!remoteStream ? <div className="stage-overlay">{waitingLabel}</div> : null}
          <ParticipantTile
            key={`local-${localVideoOn}`}
            className="local-tile"
            participantId={currentUser.email}
            name="You"
            stream={localVideoOn ? localStream : null}
            muted
            mirror
          />
        </div>
      ) : (
        <div className="audio-stage">
          <div className={`audio-avatar ${remoteStream ? 'is-live' : ''}`}>
            <Avatar id={remoteUser} size={120} />
          </div>
          <h3>{remoteUser}</h3>
          <p>{remoteStream ? `Connected · ${elapsed}` : waitingLabel}</p>
        </div>
      )}

      <div className="call-controls">
        <MicrophoneButton />
        {isVideo ? <CameraButton /> : null}
        <LeaveButton label="Hang up" onLeave={onHangUp} />
      </div>
    </div>
  );
}

function App() {
  const [email, setEmail] = useState('');
  const [currentUser, setCurrentUser] = useState(() => {
    try {
      const stored = localStorage.getItem('purplecallio-demo-user');
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });
  const [users, setUsers] = useState([]);
  const [incomingCall, setIncomingCall] = useState(null);
  const [pendingCall, setPendingCall] = useState(null);
  const [activeCall, setActiveCall] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const observedCallStates = useRef(new Map());
  const userRefreshId = useRef(0);

  const refreshUsers = useCallback(async () => {
    if (!currentUser) {
      return;
    }

    const refreshId = ++userRefreshId.current;
    try {
      const data = await apiRequest('/api/users');
      if (refreshId === userRefreshId.current) {
        setUsers(data.filter((user) => user.email !== currentUser.email));
      }
    } catch (refreshError) {
      console.error(refreshError);
    }
  }, [currentUser]);

  const refreshCalls = useCallback(async () => {
    if (!currentUser) {
      return;
    }

    try {
      const data = await apiRequest(`/api/calls?user=${encodeURIComponent(currentUser.email)}`);
      const calls = data.calls || [];

      const ringingIncoming = calls.find(
        (call) => call.status === 'ringing' && call.receiver === currentUser.email,
      );
      const ringingOutgoing = calls.find(
        (call) => call.status === 'ringing' && call.caller === currentUser.email,
      );
      const acceptedCall = calls.find(
        (call) =>
          call.status === 'accepted' &&
          (call.caller === currentUser.email || call.receiver === currentUser.email),
      );

      calls.forEach((call) => {
        const previous = observedCallStates.current.get(call.id);
        if (previous === 'ringing' && call.status === 'accepted') setStatus('Call accepted. Connecting…');
        if (previous && ['ringing', 'accepted'].includes(previous) && ['rejected', 'ended'].includes(call.status)) {
          setStatus(call.status === 'rejected' ? 'Call rejected.' : 'Call ended.');
        }
        observedCallStates.current.set(call.id, call.status);
      });

      setIncomingCall(ringingIncoming || null);
      setPendingCall(ringingOutgoing || null);
      setActiveCall(acceptedCall || null);
    } catch (callError) {
      console.error(callError);
    }
  }, [currentUser]);

  useEffect(() => {
    const initialPoll = setTimeout(refreshUsers, 0);
    const userInterval = setInterval(refreshUsers, 4000);
    return () => {
      clearTimeout(initialPoll);
      clearInterval(userInterval);
    };
  }, [refreshUsers]);

  useEffect(() => {
    const initialPoll = setTimeout(refreshCalls, 0);
    const callInterval = setInterval(refreshCalls, 2500);
    return () => {
      clearTimeout(initialPoll);
      clearInterval(callInterval);
    };
  }, [refreshCalls]);

  useEffect(() => {
    if (!currentUser) return undefined;
    const heartbeat = () => {
      apiRequest('/api/presence', {
        method: 'POST',
        body: JSON.stringify({ email: currentUser.email }),
      }).catch((presenceError) => console.error(presenceError));
    };
    heartbeat();
    const presenceInterval = setInterval(heartbeat, 10_000);
    return () => clearInterval(presenceInterval);
  }, [currentUser]);

  useEffect(() => {
    if (!status) return undefined;
    const timer = setTimeout(() => setStatus(''), 4000);
    return () => clearTimeout(timer);
  }, [status]);

  const handleLogin = async (event) => {
    event.preventDefault();
    const normalized = email.trim().toLowerCase();

    try {
      const data = await apiRequest('/api/login', {
        method: 'POST',
        body: JSON.stringify({ email: normalized }),
      });

      localStorage.setItem('purplecallio-demo-user', JSON.stringify(data.user));
      observedCallStates.current.clear();
      setCurrentUser(data.user);
      setStatus('Logged in successfully.');
      setError('');
      setEmail('');
    } catch (loginError) {
      setError(loginError.message);
    }
  };

  const handleLogout = async () => {
    if (!currentUser) {
      return;
    }

    try {
      await apiRequest('/api/logout', {
        method: 'POST',
        body: JSON.stringify({ email: currentUser.email }),
      });
      localStorage.removeItem('purplecallio-demo-user');
      observedCallStates.current.clear();
      setCurrentUser(null);
      setUsers([]);
      setIncomingCall(null);
      setPendingCall(null);
      setActiveCall(null);
      setStatus('');
      setError('');
    } catch (logoutError) {
      setError(logoutError.message);
    }
  };

  const startCall = async (targetUser, type) => {
    if (!currentUser) {
      return;
    }

    try {
      const data = await apiRequest('/api/calls', {
        method: 'POST',
        body: JSON.stringify({
          callerId: currentUser.email,
          receiverId: targetUser.email,
          type,
        }),
      });

      setPendingCall(data.call);
      setIncomingCall(null);
      setError('');
    } catch (callError) {
      setError(callError.message);
    }
  };

  const handleAcceptCall = async () => {
    if (!incomingCall) {
      return;
    }

    try {
      const data = await apiRequest(`/api/calls/${incomingCall.id}/accept`, {
        method: 'POST',
        body: JSON.stringify({ userEmail: currentUser.email }),
      });

      setIncomingCall(null);
      setActiveCall(data.call);
      setError('');
    } catch (acceptError) {
      setError(acceptError.message);
    }
  };

  const handleRejectCall = async () => {
    if (!incomingCall) {
      return;
    }

    try {
      await apiRequest(`/api/calls/${incomingCall.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ userEmail: currentUser.email }),
      });

      setIncomingCall(null);
      setStatus('Call rejected.');
      setError('');
    } catch (rejectError) {
      setError(rejectError.message);
    }
  };

  const endCall = async (call, message) => {
    try {
      await apiRequest(`/api/calls/${call.id}/end`, {
        method: 'POST',
        body: JSON.stringify({ userEmail: currentUser.email }),
      });
      setError('');
    } catch (endError) {
      // The other side may have already ended it; still leave locally.
      console.warn(endError);
    } finally {
      setActiveCall(null);
      setPendingCall(null);
      setIncomingCall(null);
      setStatus(message);
    }
  };

  const handleHangUp = () => (activeCall ? endCall(activeCall, 'Call ended.') : undefined);
  const handleCancelCall = () => (pendingCall ? endCall(pendingCall, 'Call cancelled.') : undefined);

  if (!currentUser) {
    return (
      <div className="app-shell">
        <div className="card login-card">
          <div className="brand-mark" aria-hidden="true">📞</div>
          <h1>PurpleCallio Demo</h1>
          <p className="muted">Sign in with any email to start calling other online users.</p>
          <form onSubmit={handleLogin} className="login-form">
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="alice@example.com"
              autoComplete="off"
              required
            />
            <button type="submit">Continue</button>
          </form>
          {error ? <p className="error-message">{error}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className={`app-shell ${activeCall ? 'is-in-call' : ''}`}>
      <div className="app-topbar">
        <div className="me">
          <Avatar id={currentUser.email} size={40} />
          <div>
            <p className="eyebrow">Signed in as</p>
            <h2>{currentUser.email}</h2>
          </div>
        </div>
        <button type="button" className="logout-button" onClick={handleLogout}>
          Log out
        </button>
      </div>

      {error ? <p className="error-message">{error}</p> : null}
      {status && !activeCall ? <p className="status-message">{status}</p> : null}

      {incomingCall ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="incoming-title">
          <div className="incoming-card">
            <div className="ringing-avatar">
              <Avatar id={incomingCall.caller} size={88} />
            </div>
            <p className="eyebrow">Incoming {incomingCall.type === 'video' ? 'video' : 'audio'} call</p>
            <h3 id="incoming-title">{displayName(incomingCall.caller)}</h3>
            <p className="muted">{incomingCall.caller}</p>
            <div className="inline-actions">
              <button type="button" className="danger-button" onClick={handleRejectCall}>
                Decline
              </button>
              <button type="button" className="accept-button" onClick={handleAcceptCall}>
                Accept
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingCall ? (
        <div className="panel outgoing-panel">
          <div className="ringing-avatar small">
            <Avatar id={pendingCall.receiver} size={48} />
          </div>
          <div className="outgoing-text">
            <h3>Calling {displayName(pendingCall.receiver)}…</h3>
            <p className="muted">{pendingCall.type === 'video' ? 'Video' : 'Audio'} call · ringing</p>
          </div>
          <button type="button" className="danger-button" onClick={handleCancelCall}>
            Cancel
          </button>
        </div>
      ) : null}

      {activeCall ? (
        <CallRoom call={activeCall} currentUser={currentUser} onHangUp={handleHangUp} />
      ) : (
        <div className="card user-card">
          <div className="user-card-header">
            <h3>Online users</h3>
            <span className="count-pill">{users.length}</span>
          </div>
          {users.length === 0 ? (
            <p className="empty-state">No one else is online yet. Open this app in another browser profile and sign in with a different email.</p>
          ) : (
            <ul className="user-list">
              {users.map((user) => (
                <li className="user-row" key={user.email}>
                  <div className="user-info">
                    <span className="presence-avatar">
                      <Avatar id={user.email} size={40} />
                    </span>
                    <div>
                      <strong>{displayName(user.email)}</strong>
                      <small>{user.email}</small>
                    </div>
                  </div>
                  <div className="button-group">
                    <button
                      type="button"
                      className="icon-button"
                      disabled={Boolean(pendingCall)}
                      onClick={() => startCall(user, 'audio')}
                    >
                      📞 Audio
                    </button>
                    <button
                      type="button"
                      className="icon-button primary"
                      disabled={Boolean(pendingCall)}
                      onClick={() => startCall(user, 'video')}
                    >
                      🎥 Video
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
