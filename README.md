# Voice Room Desktop

Electron desktop shell for Voice Room. It opens the hosted Voice Room web app from `VOICE_ROOM_URL` and provides desktop-only screen capture and window controls.

## Setup

Create a local `.env`:

```dotenv
VOICE_ROOM_URL=https://voice.example.com
```

## Commands

```bash
npm run electron
npm run build
npm run build:mac
npm run build:win
npm run check
```

Build artifacts are written to `dist/`.
