import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Avatar,
  CameraButton,
  ConnectionStatus,
  ControlButton,
  DualViewCaptions,
  LanguagePicker,
  LeaveButton,
  MeetingProvider,
  MicrophoneButton,
  ParticipantTile,
  TranslationControls,
  aiErrorMessage,
  translationErrorMessage,
  useMeeting,
  usePurpleCallioAI,
  useTranslation,
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
      iceServers={call.iceServers}
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
  const { engine } = useMeeting();
  const audioRef = useRef(null);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  useStreamTracks(stream);
  const audioTrackCount = stream?.getAudioTracks().length ?? 0;

  // Live Translate ducks registered elements while the translated voice plays.
  useEffect(() => {
    if (!engine || !audioRef.current) return undefined;
    return engine.registerAudioElement(audioRef.current);
  }, [engine]);

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

// LanguagePicker fetches `${apiUrl}/translation/languages`, which the backend proxies.
const TRANSLATION_API_URL = `${API_BASE_URL}/api`;

// The SDK reports "joined" once the call room is entered; "connected" only
// covers the brief signaling handshake before that (and reconnects).
const CALL_READY_STATES = new Set(['connected', 'joined']);

function TranslateIcon({ active }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? '#c4b5fd' : '#94A3B8'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 8l6 6" />
      <path d="M4 14l6-6 2-3" />
      <path d="M2 5h12" />
      <path d="M7 2h1" />
      <path d="M22 22l-5-10-5 10" />
      <path d="M14 18h6" />
    </svg>
  );
}

function TranslateButton({ translation, speak, hear }) {
  const { engine, connectionState } = useMeeting();
  const { enabled, state } = translation;
  const starting = state.status === 'connecting';
  const callReady = Boolean(engine) && CALL_READY_STATES.has(connectionState);

  return (
    <ControlButton
      label={starting ? 'Starting…' : enabled ? 'Stop translate' : 'Translate'}
      title={callReady ? undefined : 'Available once the call is connected'}
      active={enabled}
      activeColor="#4c1d95"
      size={56}
      disabled={!enabled && !callReady}
      onClick={enabled ? translation.disable : () => translation.enable({ speak, hear, mode: 'voice' })}
    >
      <TranslateIcon active={enabled} />
    </ControlButton>
  );
}

function TranslationPanel({ peerName, translation, speak, hear, onSpeakChange, onHearChange }) {
  const { enabled, state, error, repeatRequests } = translation;

  const changeLanguages = (languages) => {
    if (languages.speak) onSpeakChange(languages.speak);
    if (languages.hear) onHearChange(languages.hear);
    if (enabled) translation.setLanguages(languages);
  };

  return (
    <section className="translate-panel" aria-label="Live translation">
      <div className="translate-header">
        <div>
          <h4>🌐 Live translation</h4>
          <p>
            {state.status === 'ready'
              ? state.peer?.connected
                ? `${displayName(peerName)} is translating too`
                : `Waiting for ${displayName(peerName)} to turn on translation…`
              : 'Pick your languages, then press Translate in the call controls.'}
          </p>
        </div>
      </div>

      <div className="translate-languages">
        <LanguagePicker
          label="I speak"
          value={speak}
          onChange={(code) => changeLanguages({ speak: code })}
          apiUrl={TRANSLATION_API_URL}
          allowAuto
        />
        <LanguagePicker
          label="I want to hear"
          value={hear}
          onChange={(code) => changeLanguages({ hear: code })}
          apiUrl={TRANSLATION_API_URL}
          require={state.mode === 'captions' ? 'captions' : 'voice'}
        />
      </div>

      {error ? <p className="error-message">{translationErrorMessage(error.code)}</p> : null}

      {enabled ? <TranslationControls translation={translation} /> : null}

      {repeatRequests.map((request) => (
        <div className="translate-repeat" key={request.phraseId}>
          <span>{request.prompt} “{request.original}”</span>
          <button type="button" onClick={() => translation.dismissRepeatRequest(request.phraseId)}>
            OK
          </button>
        </div>
      ))}

      {translation.phrases.length > 0 ? (
        <DualViewCaptions
          className="translate-captions"
          translation={translation}
          youLabel="You"
          peerLabel={displayName(peerName)}
        />
      ) : null}
    </section>
  );
}

const AGENT_STATE_LABELS = {
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
};

function AiAgentCard({ currentUser, signalUrl }) {
  const ai = usePurpleCallioAI({
    apiUrl: signalUrl,
    getToken: () =>
      apiRequest('/api/ai/sessions', {
        method: 'POST',
        body: JSON.stringify({ email: currentUser.email }),
      }),
  });
  const transcriptRef = useRef(null);
  const inCall = ['starting', 'connecting', 'connected'].includes(ai.status);
  const mm = String(Math.floor(ai.durationSeconds / 60)).padStart(2, '0');
  const ss = String(ai.durationSeconds % 60).padStart(2, '0');

  useEffect(() => {
    const element = transcriptRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [ai.transcript]);

  let statusLabel = 'Talk to the AI voice agent from your browser.';
  if (ai.status === 'starting' || ai.status === 'connecting') statusLabel = 'Connecting…';
  if (ai.status === 'connected') statusLabel = `${AGENT_STATE_LABELS[ai.agentState]} · ${mm}:${ss}`;
  if (ai.status === 'ended' && ai.endedReason && !ai.error) statusLabel = `Call ended (${ai.endedReason}).`;

  return (
    <div className="card ai-card">
      <div className="ai-card-header">
        <div className={`ai-orb is-${ai.status === 'connected' ? ai.agentState : 'idle'}`} aria-hidden="true">
          🤖
        </div>
        <div className="ai-card-title">
          <h3>AI Agent</h3>
          <p className="muted">{statusLabel}</p>
        </div>
        <div className="button-group">
          {inCall ? (
            <>
              <button
                type="button"
                className="icon-button"
                disabled={ai.status !== 'connected'}
                onClick={ai.isMuted ? ai.unmute : ai.mute}
              >
                {ai.isMuted ? '🎙️ Unmute' : '🔇 Mute'}
              </button>
              <button type="button" className="icon-button danger-button" onClick={ai.end}>
                End
              </button>
            </>
          ) : (
            <button type="button" className="icon-button primary" onClick={ai.start}>
              📞 Call AI agent
            </button>
          )}
        </div>
      </div>

      {ai.error ? <p className="error-message">{aiErrorMessage(ai.error.code) || ai.error.message}</p> : null}

      {ai.pendingConfirmations.map((tool) => (
        <div className="ai-confirm" key={tool.id}>
          <span>The agent wants to run <strong>{tool.name}</strong>.</span>
          <div className="button-group">
            <button type="button" className="icon-button" onClick={() => ai.confirmTool(tool.id, false)}>
              Decline
            </button>
            <button type="button" className="icon-button primary" onClick={() => ai.confirmTool(tool.id, true)}>
              Allow
            </button>
          </div>
        </div>
      ))}

      {ai.transcript.length > 0 ? (
        <ul className="ai-transcript" ref={transcriptRef}>
          {ai.transcript.map((line) => (
            <li key={line.key} className={`ai-line is-${line.role} ${line.final ? '' : 'is-partial'}`}>
              <span className="ai-line-role">{line.role === 'agent' ? 'Agent' : 'You'}</span>
              {line.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function MeetingShell({ call, currentUser, onHangUp, onJoinError }) {
  const { engine, join, leave, connectionState, localStream, remoteStream } = useMeeting();
  // meeting.translation reuses this call's token, microphone and remote audio.
  const translation = useTranslation({ client: engine?.translation ?? null });
  const [speak, setSpeak] = useState('en');
  const [hear, setHear] = useState('hi');
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

  const waitingLabel = CALL_READY_STATES.has(connectionState)
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
        <TranslateButton translation={translation} speak={speak} hear={hear} />
        <LeaveButton label="Hang up" onLeave={onHangUp} />
      </div>

      <TranslationPanel
        peerName={remoteUser}
        translation={translation}
        speak={speak}
        hear={hear}
        onSpeakChange={setSpeak}
        onHearChange={setHear}
      />
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
  const [config, setConfig] = useState(null);
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
    // Closing or refreshing the tab marks the user offline right away instead of
    // after the server's presence TTL; a refresh or back-forward restore comes
    // back online on the next heartbeat.
    const goOffline = () =>
      navigator.sendBeacon?.(`${API_BASE_URL}/api/logout?email=${encodeURIComponent(currentUser.email)}`);
    const onPageShow = (event) => {
      if (event.persisted) heartbeat();
    };
    heartbeat();
    const presenceInterval = setInterval(heartbeat, 10_000);
    window.addEventListener('pagehide', goOffline);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      clearInterval(presenceInterval);
      window.removeEventListener('pagehide', goOffline);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) return;
    apiRequest('/api/config')
      .then(setConfig)
      .catch((configError) => console.error(configError));
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
        <>
          {config?.aiAgentEnabled ? (
            <AiAgentCard currentUser={currentUser} signalUrl={config.signalUrl} />
          ) : null}
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
        </>
      )}
    </div>
  );
}

export default App;
