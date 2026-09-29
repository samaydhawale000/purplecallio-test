import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CameraButton,
  MeetingProvider,
  MicrophoneButton,
  ParticipantTile,
  useMeeting,
} from '@purplecallio/react';
import './App.css';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

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
      {joinError ? <p className="error-message">{joinError}</p> : null}
    </MeetingProvider>
  );
}

function MeetingShell({ call, currentUser, onHangUp, onJoinError }) {
  const { join, leave, connectionState, localStream, remoteStream, participantId } = useMeeting();

  useEffect(() => {
    join().catch((error) => onJoinError(error?.message || 'Could not join the PurpleCallio meeting.'));
    return () => {
      leave();
    };
  }, [join, leave, onJoinError]);

  const handleHangUp = async () => {
    try {
      await leave();
    } finally {
      onHangUp();
    }
  };

  const remoteUser = call.caller === currentUser.email ? call.receiver : call.caller;

  return (
    <div className="call-shell">
      <div className="call-header">
        <h2>{call.type === 'video' ? 'Video Call' : 'Audio Call'}</h2>
        <p>{remoteUser}</p>
        <span>Connection: {connectionState}</span>
      </div>

      {call.type === 'video' ? (
        <div className="video-grid">
          <div className="video-panel remote-panel">
            {remoteStream ? (
              <ParticipantTile participantId={remoteUser} stream={remoteStream} />
            ) : (
              <div className="video-placeholder">Remote video</div>
            )}
          </div>
          <div className="video-panel local-panel">
            {localStream ? (
              <ParticipantTile participantId={participantId || 'me'} stream={localStream} muted mirror />
            ) : (
              <div className="video-placeholder">Local video</div>
            )}
          </div>
        </div>
      ) : (
        <div className="audio-view">
          <h3>{remoteUser}</h3>
          <p>Connected</p>
        </div>
      )}

      <div className="call-controls">
        <MicrophoneButton labelOn="Mute" labelOff="Unmute" />
        {call.type === 'video' ? (
          <CameraButton labelOn="Turn camera off" labelOff="Turn camera on" />
        ) : null}
        <button type="button" className="danger-button" onClick={handleHangUp}>
          Hang Up
        </button>
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

  const refreshUsers = useCallback(async () => {
    if (!currentUser) {
      return;
    }

    try {
      const data = await apiRequest('/api/users');
      setUsers(data.filter((user) => user.email !== currentUser.email));
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
    const releasePresence = () => {
      fetch(`${API_BASE_URL}/api/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: currentUser.email }),
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener('pagehide', releasePresence);
    return () => window.removeEventListener('pagehide', releasePresence);
  }, [currentUser]);

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

      setStatus(`Calling ${targetUser.email}...`);
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
      setStatus('Call accepted. Connecting…');
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

  const handleHangUp = async () => {
    if (!activeCall) {
      return;
    }

    try {
      await apiRequest(`/api/calls/${activeCall.id}/end`, {
        method: 'POST',
        body: JSON.stringify({ userEmail: currentUser.email }),
      });
      setActiveCall(null);
      setPendingCall(null);
      setIncomingCall(null);
      setStatus('Call ended.');
      setError('');
    } catch (hangUpError) {
      setError(hangUpError.message);
    }
  };

  if (!currentUser) {
    return (
      <div className="app-shell">
        <div className="card login-card">
          <h1>PurpleCallio Demo</h1>
          <form onSubmit={handleLogin} className="login-form">
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="alice@example.com"
              autoComplete="off"
            />
            <button type="submit">Login</button>
          </form>
          {error ? <p className="error-message">{error}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="app-topbar">
        <div>
          <p className="eyebrow">Logged in as</p>
          <h2>{currentUser.email}</h2>
        </div>
        <button type="button" className="logout-button" onClick={handleLogout}>
          Logout
        </button>
      </div>

      {error ? <p className="error-message">{error}</p> : null}
      {status ? <p className="status-message">{status}</p> : null}

      {incomingCall ? (
        <div className="panel incoming-panel">
        <h3>Incoming {incomingCall.type === 'video' ? 'Video' : 'Audio'} Call</h3>
          <p>{incomingCall.caller}</p>
          <div className="inline-actions">
            <button type="button" className="secondary-button" onClick={handleRejectCall}>
              Reject
            </button>
            <button type="button" className="primary-button" onClick={handleAcceptCall}>
              Accept
            </button>
          </div>
        </div>
      ) : null}

      {pendingCall ? (
        <div className="panel status-panel">
          <h3>Calling {pendingCall.receiver}</h3>
          <p>Ringing...</p>
        </div>
      ) : null}

      {activeCall ? (
        <CallRoom call={activeCall} currentUser={currentUser} onHangUp={handleHangUp} />
      ) : (
        <div className="card user-card">
          <h3>Online Users</h3>
          <div className="user-list">
            {users.length === 0 ? (
              <p>No other users online.</p>
            ) : (
              users.map((user) => (
                <div className="user-row" key={user.email}>
                  <div>
                    <strong>{user.email.split('@')[0]}</strong>
                    <small>{user.email}</small>
                  </div>
                  <div className="button-group">
                    <button type="button" onClick={() => startCall(user, 'audio')}>
                      Audio Call
                    </button>
                    <button type="button" onClick={() => startCall(user, 'video')}>
                      Video Call
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
