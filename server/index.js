const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { PurpleCallioClient } = require('@purplecallio/sdk');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3003);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:3002';
const users = new Map();
const activeCalls = new Map();
const CALL_TIMEOUT_MS = 30_000;
const TERMINAL_CALL_TTL_MS = 60_000;

const readEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const errorPayload = (code, message) => ({ success: false, error: { code, message } });
const signalUrl = () => process.env.PURPLECALLIO_SIGNAL_URL || process.env.PURPLECALLIO_BASE_URL || 'https://api.purplecallio.com';

function purpleClient() {
  if (!process.env.PURPLECALLIO_API_KEY) return null;
  return new PurpleCallioClient({
    apiKey: process.env.PURPLECALLIO_API_KEY,
    baseUrl: process.env.PURPLECALLIO_BASE_URL || 'https://api.purplecallio.com',
  });
}

function publicCall(call, email) {
  return {
    id: call.id,
    callId: call.id,
    caller: call.caller,
    receiver: call.receiver,
    type: call.type,
    status: call.status,
    signalUrl: call.signalUrl,
    participantToken: call.tokens[email] || '',
    createdAt: call.createdAt,
    acceptedAt: call.acceptedAt,
  };
}

function userHasActiveCall(email) {
  return Array.from(activeCalls.values()).some(
    (call) => [call.caller, call.receiver].includes(email) && ['ringing', 'accepted'].includes(call.status),
  );
}

function finishCall(call, status) {
  call.status = status;
  call.finishedAt = Date.now();
  setTimeout(() => {
    if (activeCalls.get(call.id) === call) activeCalls.delete(call.id);
  }, TERMINAL_CALL_TTL_MS).unref?.();
}

app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/api/login', (req, res) => {
  const email = readEmail(req.body?.email);
  if (!isValidEmail(email)) return res.status(400).json(errorPayload('INVALID_EMAIL', 'Please enter a valid email address.'));
  if (users.has(email)) return res.status(409).json(errorPayload('USER_ALREADY_ONLINE', 'This email is already logged in.'));
  users.set(email, { email });
  console.log(`User logged in: ${email}`);
  return res.json({ success: true, user: { email } });
});

app.post('/api/logout', (req, res) => {
  const email = readEmail(req.body?.email);
  if (!isValidEmail(email)) return res.status(400).json(errorPayload('INVALID_EMAIL', 'Please provide a valid email address.'));
  users.delete(email);
  for (const call of activeCalls.values()) {
    if ([call.caller, call.receiver].includes(email) && ['ringing', 'accepted'].includes(call.status)) {
      const wasAccepted = call.status === 'accepted';
      finishCall(call, 'ended');
      const client = purpleClient();
      if (client) {
        const cleanup = wasAccepted ? client.endCall(call.id, call.tokens[email]) : client.rejectCall(call.id, call.tokens[email]);
        cleanup.catch((error) => console.error('PurpleCallio call cleanup error:', error.message));
      }
    }
  }
  console.log(`User logged out: ${email}`);
  return res.json({ success: true });
});

app.get('/api/users', (_req, res) => {
  res.json(Array.from(users.keys(), (email) => ({ email, online: true })));
});

app.get('/api/calls', (req, res) => {
  const email = readEmail(req.query.user);
  if (!users.has(email)) return res.json({ success: true, calls: [] });
  const calls = Array.from(activeCalls.values())
    .filter((call) => call.caller === email || call.receiver === email)
    .map((call) => publicCall(call, email));
  return res.json({ success: true, calls });
});

app.post('/api/calls', async (req, res) => {
  const caller = readEmail(req.body?.callerId);
  const receiver = readEmail(req.body?.receiverId);
  const type = String(req.body?.type || '').toLowerCase();
  if (!isValidEmail(caller) || !isValidEmail(receiver)) return res.status(400).json(errorPayload('INVALID_EMAIL', 'Caller and receiver emails are required.'));
  if (!['audio', 'video'].includes(type)) return res.status(400).json(errorPayload('INVALID_CALL_TYPE', 'Call type must be audio or video.'));
  if (!users.has(caller) || !users.has(receiver)) return res.status(404).json(errorPayload('USER_NOT_FOUND', 'Both users must be online to call.'));
  if (caller === receiver) return res.status(400).json(errorPayload('INVALID_CALL_PARTICIPANT', 'You cannot call yourself.'));
  if (userHasActiveCall(caller) || userHasActiveCall(receiver)) return res.status(409).json(errorPayload('USER_BUSY', 'One of the users is already in a call.'));

  const client = purpleClient();
  if (!client) return res.status(500).json(errorPayload('PURPLECALLIO_ERROR', 'Set PURPLECALLIO_API_KEY in server/.env to create calls.'));
  try {
    const result = await client.createCall({ callerId: caller, receiverId: receiver, type: type === 'audio' ? 'AUDIO' : 'VIDEO' });
    const tokens = { [caller]: result.callerToken, [receiver]: result.receiverToken };
    if (!result.callId || !tokens[caller] || !tokens[receiver]) {
      throw new Error('PurpleCallio did not return a call ID and both participant tokens.');
    }
    const call = {
      id: result.callId,
      caller,
      receiver,
      type,
      status: 'ringing',
      signalUrl: signalUrl(),
      tokens,
      createdAt: Date.now(),
      acceptedAt: null,
    };
    activeCalls.set(call.id, call);
    console.log(`Call created: ${caller} -> ${receiver}, type=${type}, callId=${call.id}`);
    setTimeout(() => {
      if (call.status !== 'ringing') return;
      finishCall(call, 'ended');
      client.endCall(call.id, tokens[caller]).catch((error) => console.error('PurpleCallio timeout cleanup error:', error.message));
      console.log(`Call timed out: ${call.id}`);
    }, CALL_TIMEOUT_MS).unref?.();
    return res.json({ success: true, call: publicCall(call, caller) });
  } catch (error) {
    console.error('PurpleCallio createCall error:', error.message);
    return res.status(502).json(errorPayload('PURPLECALLIO_ERROR', error.message || 'Could not create the PurpleCallio call.'));
  }
});

app.post('/api/calls/:callId/accept', async (req, res) => {
  const email = readEmail(req.body?.userEmail || req.body?.email);
  const call = activeCalls.get(req.params.callId);
  if (!call || call.status !== 'ringing') return res.status(404).json(errorPayload('CALL_NOT_FOUND', 'This call is no longer ringing.'));
  if (call.receiver !== email) return res.status(403).json(errorPayload('INVALID_CALL_PARTICIPANT', 'Only the receiver can accept this call.'));
  const client = purpleClient();
  try {
    if (!client) throw new Error('PurpleCallio API key is not configured on the server.');
    await client.acceptCall(call.id, call.tokens[email]);
    call.status = 'accepted';
    call.acceptedAt = Date.now();
    console.log(`Call accepted: ${email}, callId=${call.id}`);
    return res.json({ success: true, call: publicCall(call, email) });
  } catch (error) {
    console.error('PurpleCallio acceptCall error:', error.message);
    return res.status(502).json(errorPayload('PURPLECALLIO_ERROR', error.message || 'Could not accept the PurpleCallio call.'));
  }
});

app.post('/api/calls/:callId/reject', async (req, res) => {
  const email = readEmail(req.body?.userEmail || req.body?.email);
  const call = activeCalls.get(req.params.callId);
  if (!call || call.status !== 'ringing') return res.status(404).json(errorPayload('CALL_NOT_FOUND', 'This call is no longer ringing.'));
  if (call.receiver !== email) return res.status(403).json(errorPayload('INVALID_CALL_PARTICIPANT', 'Only the receiver can reject this call.'));
  try {
    const client = purpleClient();
    if (!client) throw new Error('PurpleCallio API key is not configured on the server.');
    await client.rejectCall(call.id, call.tokens[email]);
    finishCall(call, 'rejected');
    console.log(`Call rejected: ${call.id}`);
    return res.json({ success: true });
  } catch (error) {
    console.error('PurpleCallio rejectCall error:', error.message);
    return res.status(502).json(errorPayload('PURPLECALLIO_ERROR', error.message || 'Could not reject the PurpleCallio call.'));
  }
});

app.post('/api/calls/:callId/end', async (req, res) => {
  const email = readEmail(req.body?.userEmail || req.body?.email);
  const call = activeCalls.get(req.params.callId);
  if (!call || !['ringing', 'accepted'].includes(call.status)) return res.status(404).json(errorPayload('CALL_NOT_FOUND', 'This call is no longer active.'));
  if (![call.caller, call.receiver].includes(email)) return res.status(403).json(errorPayload('INVALID_CALL_PARTICIPANT', 'You are not part of this call.'));
  try {
    const client = purpleClient();
    if (!client) throw new Error('PurpleCallio API key is not configured on the server.');
    if (call.status === 'accepted') await client.endCall(call.id, call.tokens[email]);
    else await client.rejectCall(call.id, call.tokens[email]);
    finishCall(call, 'ended');
    console.log(`Call ended: ${call.id}`);
    return res.json({ success: true });
  } catch (error) {
    console.error('PurpleCallio endCall error:', error.message);
    return res.status(502).json(errorPayload('PURPLECALLIO_ERROR', error.message || 'Could not end the PurpleCallio call.'));
  }
});

app.listen(PORT, () => console.log(`PurpleCallio POC backend running on http://localhost:${PORT}`));
