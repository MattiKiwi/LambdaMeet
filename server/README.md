# Server component

TypeScript API + signaling service for LambdaMeet. Handles authentication, meeting scheduling, invite creation, and WebSocket relay for WebRTC signaling. Uses Postgres via Prisma.

## Key responsibilities
- Auth: JWT issuance/verification, guest invite redemption
- Meetings: create/list meetings, issue invites
- Signaling: WebSocket fanout to room participants
- Persistence: users/meetings/invites in Postgres
- Cache: optional Redis connection (enabled when `REDIS_URL` is set)
- SFU: LiveKit server (token issuance via API)
- Logging: structured logs with component/step metadata to stdout and `logs/app.log`

## Scripts
- `npm run dev` — start server with TSX watch
- `npm run build` — compile TypeScript
- `npm run start` — run compiled server
- `npm run db:generate` — generate Prisma client
- `npm run db:push` — push schema to DB
- `npm run db:migrate` — create migration (dev)

## Configuration
Create `server/.env` from the example and set a real `JWT_SECRET`:
```
PORT=4000
HOST=0.0.0.0
JWT_SECRET=replace-me
DEV_AUTH_ENABLED=true
CORS_ORIGIN=http://localhost:5173
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/lambdameet?schema=public
LOG_LEVEL=debug
REDIS_URL=redis://localhost:6379
LIVEKIT_URL=http://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=devsecret
```

## Logging
Logs include a `component` field and a `step` field:
- Component examples: `api`, `signaling`, `store`
- Step examples: `auth.login.start`, `meeting.create.success`, `signal.receive.success`

Log files are created in `server/logs/app.log`.

## API surface
Base URL: `/api`
- `POST /auth/login`
- `POST /auth/guest`
- `GET /meetings`
- `POST /meetings`
- `POST /meetings/:id/invites`
- `POST /livekit/token`

WebSocket signaling: `/ws?token=...&meetingId=...`
