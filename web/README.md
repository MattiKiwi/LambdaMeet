# Web component

React + Vite client for LambdaMeet. Provides a simple control panel to authenticate, schedule meetings, create invites, and connect to the signaling WebSocket.

## Key responsibilities
- Authenticate (dev JWT flow)
- Schedule meetings and view list
- Generate guest invites
- Connect to signaling WebSocket for ICE/SDP exchange
- Run device preflight (camera/mic preview + device enumeration)
- Basic offer/answer + ICE exchange via signaling (demo)
- Participant tiles with connection indicators and ICE restart control
- Auto-reconnect signaling with exponential backoff
- LiveKit SFU join/leave scaffold (token from API)
- LiveKit remote tracks rendered in tiles
- LiveKit stats (bitrate/packet loss) with adaptive publish quality
- LiveKit room state and remote quality controls
- LiveKit signal health + per-track subscribe/mute toggles
- Meeting access control panel (lobby, lock, admit/deny, mute/kick)
- Local audio stats and global mute-all-remote-audio toggle

## Scripts
- `npm run dev` — start Vite dev server
- `npm run build` — production build
- `npm run preview` — preview build output

## Configuration
Optional `web/.env`:
```
VITE_API_URL=http://localhost:4000
```

## Notes
- WebRTC media is not wired yet; this is the control-plane scaffold.
- The signaling WebSocket URL is derived from `VITE_API_URL`.
