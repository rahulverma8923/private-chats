# Private Couple Chat

Temporary private chat website for two people. It uses:

- Node.js built-in HTTP server
- Native WebSocket for real-time chat, typing, presence, notes, and WebRTC signaling
- WebRTC for voice and video
- No database and no permanent message storage

## Run Locally

```bash
node server.js
```

Open:

```text
http://localhost:3000
```

Default password:

```text
AaravRiya2026
```

To set your own password:

```bash
SECRET_PASSWORD="your-strong-password" node server.js
```

On Windows PowerShell:

```powershell
$env:SECRET_PASSWORD="your-strong-password"
node server.js
```

## Privacy Behavior

- Chat messages are forwarded live through the server.
- Messages are not written to a database or file.
- Refreshing the browser removes local chat history.
- Restarting the server removes active rooms and shared temporary notes.
- Shared notes are only kept in server memory while the room exists.

## Deployment Notes

- Use HTTPS in production, otherwise camera and microphone permissions may fail.
- For reliable WebRTC across networks, add a TURN server. The app currently includes a public STUN server for basic connection discovery.
- Keep `SECRET_PASSWORD` in hosting environment variables, not in the source code.
