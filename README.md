# LambdaMeet prototype

Runnable scaffold for a secure WebRTC meeting platform: TypeScript signaling/API server plus React/Vite client with scheduling, invite creation, and basic WebSocket signaling loop.

## Prerequisites
- Node 18+ (dev setup uses npm workspaces)
- Docker (for local Postgres) or your own Postgres instance
- Copy env files and set a non-default `JWT_SECRET` before exposing beyond localhost.

## Setup
1) Install deps
```bash
npm install --workspaces
```
2) Server env
```bash
cp server/.env.example server/.env
# edit server/.env and set JWT_SECRET
```
3) Database + cache + TURN (local)
```bash
# start Postgres locally (requires docker)
docker compose up -d db redis turn
# push schema
cd server && npm run db:push && cd ..
```

4) Client env (optional if using defaults)
```bash
cat > web/.env <<'EOF'
VITE_API_URL=http://localhost:4000
EOF
```

## Run (dev)
In two terminals:
```bash
cd server && npm run dev
cd web && npm run dev
```

## What’s included
- API (`/api`):
  - `POST /auth/login` — returns JWT; with `DEV_AUTH_ENABLED=true`, password is optional and users are auto-created (role user/admin).
  - `POST /auth/guest` — redeem invite token for guest JWT.
  - `POST /meetings` / `GET /meetings` — create/list meetings for the authenticated host.
  - `POST /meetings/:id/invites` — create guest/user invite tokens.
- Signaling: WebSocket at `/ws?token=...&meetingId=...`, currently relays messages to other participants in the meeting room (for ICE/SDP).
- Persistence: Postgres via Prisma for users/meetings/invites (see `docker-compose.yml`).

## Next build steps
- Add orgs and meeting policies; migrate policy enforcement to DB rows.
- Harden auth (password flows, OIDC, MFA), rate limits, and audit logging.
- Expand signaling to full SDP/ICE flows with SFU integration; add media/recording controls on the client.
- Add tests/linters, CI, and infra-as-code for TURN/SFU/signaling/TURN.
