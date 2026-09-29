# PurpleCallio Demo POC

A small React + Express proof-of-concept for 1-to-1 audio/video calling using the official PurpleCallio SDK.

## Project overview

This app demonstrates:

- email-only login
- online user presence stored in memory on the backend
- polling-based user presence refresh
- audio and video call initiation
- incoming call UI
- accept and reject flows
- PurpleCallio `MeetingProvider` integration on the client
- microphone and camera toggling via the official React SDK
- call timeout and cleanup

## Architecture

```text
Client (React + Vite at localhost:3002)
  │
  │ /api requests through Vite proxy
  ▼
Express backend
  │
  │ PurpleCallioClient (server-only API key)
  ▼
PurpleCallio
```

## Prerequisites

- Node.js 18+
- npm
- a PurpleCallio project API key

## Installation

```bash
npm install
npm install --prefix client
npm install --prefix server
```

## Environment variables

Create a backend environment file at `server/.env`:

```env
PORT=3003
FRONTEND_ORIGIN=http://localhost:3002
PURPLECALLIO_API_KEY=your_api_key_here
PURPLECALLIO_BASE_URL=https://api.purplecallio.com
PURPLECALLIO_SIGNAL_URL=https://api.purplecallio.com
```

A template file is included at `server/.env.example`.

To point the client at a backend hosted outside the Vite development proxy, create `client/.env` and set:

```env
VITE_API_BASE_URL=http://localhost:3003
```

Leave this unset when using the local Vite proxy.

For separate Vercel projects, set `VITE_API_BASE_URL` in the frontend project's Production (and Preview, if needed) environment variables to the backend's origin, for example `https://your-backend.vercel.app` (no trailing slash). Set `FRONTEND_ORIGIN` in the backend project to the frontend's origin, for example `https://your-frontend.vercel.app`. Redeploy the frontend after changing its environment variables so Vite includes the new URL in the build.

## Running locally

```bash
npm run dev
```

This starts:

- React app at http://localhost:3002
- Express API at http://localhost:3003

If you prefer separate terminals:

```bash
npm run dev:client
npm run dev:server
```

## Testing two users

1. Open http://localhost:3002 in two browser tabs or two browser profiles.
2. Log in as `alice@test.com` in one tab.
3. Log in as `bob@test.com` in the other tab.
4. In the user list, click the audio or video button for the other user.
5. Accept the incoming call on the receiving browser.
6. Test mute/unmute, camera toggle, and hang up.

## PurpleCallio integration notes

This app uses the live PurpleCallio packages:

- `@purplecallio/react`
- `@purplecallio/sdk`

The flow follows the current SDK docs:

- create the call on the backend with `PurpleCallioClient`
- keep the caller and receiver tokens in server memory and return each user only their own token
- accept, reject, and end calls through the documented SDK methods
- never expose the API key to the browser
- return the participant token and signal URL to the browser
- mount `MeetingProvider` with `token`, `callId`, and `signalUrl`
- call `join()` in a component that runs under the provider
- use `CameraButton` and `MicrophoneButton` from the React SDK

The SDK's create-call response supplies `callId`, `callerToken`, and `receiverToken`. The signaling URL defaults to `PURPLECALLIO_SIGNAL_URL`, then `PURPLECALLIO_BASE_URL`, and finally `https://api.purplecallio.com`.

## Known POC limitations

- users are stored in memory only
- browser refresh/logouts are not persisted
- there is no database or production auth layer
- there is no call history or complex presence platform
- the app uses polling for presence and incoming calls for simplicity

## Security

- the PurpleCallio API key stays on the server
- the frontend never receives the API key
- secrets are kept in `server/.env`, which is ignored by Git

## Notes

This is a demo app meant for local testing and validation of the PurpleCallio integration path. It is intentionally kept simple and does not attempt to mimic the full production architecture.
