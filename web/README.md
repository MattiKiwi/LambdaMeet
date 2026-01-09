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
- Admin user management (full names, roles, passwords)

## Screens
- Login: authenticate and select role
- User Space: preflight and meeting list
- Admin Space: scheduling, invites, access control
- Call Room: signaling + LiveKit call UI

## UI components
- `App` (`web/src/App.tsx`): owns auth/session state, LiveKit room lifecycle, WebSocket signaling state, and routes into the three screens.
- `UserSpace` (`web/src/App.tsx`): login and device readiness screen; surfaces meeting list and one-click navigation to the call room.
- `AdminSpace` (`web/src/App.tsx`): scheduling + invite management; includes lobby/lock/mute/kick controls for the selected meeting.
- `CallSpace` (`web/src/App.tsx`): dedicated call layout with local/remote previews, LiveKit controls, and side panels for signaling + stats.
- `LiveKitTrackTile` (`web/src/App.tsx`): per-participant tile that attaches tracks and exposes subscribe/quality/mute controls.

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
