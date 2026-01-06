# Secure WebRTC Video Call System — Step-by-Step Plan

This plan walks through getting a browser-based, WebRTC-powered video calling system live with admin/user/guest roles and meeting scheduling.

## 1) Confirm requirements and constraints
- [x] Lock target browsers/devices, participant scale, and expected call sizes (1:1, small groups, larger). -> medium groups
- [x] Decide media model: SFU-first for scale; opt-in E2EE (insertable streams) vs. server-mixed recording. -> SFU with default E2EE
- [x] Compliance and privacy: GDPR/HIPAA? Data residency? Recording/retention policies and consent UX. -> No recordings at all
- [x] Choose identity: OIDC provider for users/admins; guest access via signed, scoped tokens. -> We'll use OIDC, guest via shared links
- [x] Pick infra posture: self-hosted vs. managed SFU (e.g., mediasoup/Janus/LiveKit), STUN/TURN hosting (coturn), and cloud region strategy. -> self-hosted, hosting

## 2) Development environment setup
- [x] Initialize repo (monorepo or separate client/server) with package manager, formatter, linter, and CI scaffolding. (repo/workspaces done; lint/CI pending)
- [ ] Configure env secrets management (dotenv + vault/KMS for production).
- [x] Set up base services: Web client (React/Vue/Svelte), signaling service (Node/Go) with WebSocket, SQL DB (Postgres), cache (Redis). (client + signaling + Postgres done; cache pending)
- [ ] Add dev certs for local HTTPS (required for getUserMedia) and a TURN server running locally or via docker.

## 3) Core architecture spike
- [x] Stand up signaling service skeleton: connect over WebSocket, exchange join/leave, room state, and ICE candidates.
- [ ] Integrate SFU of choice; validate publish/subscribe, simulcast/SVC support, and stats API.
- [x] Implement auth plumbing: JWT from OIDC for users/admins; ephemeral meeting-scoped token issuance for guests. (dev JWT + guest tokens; OIDC pending)
- [x] Define initial data model: users, orgs, meetings, invites, rooms, audit events. (Prisma schema for users/meetings/invites; orgs/audit pending)

## 4) WebRTC foundation
- [ ] Implement device selection and permission prompts; preflight checks for camera/mic/speakers/network.
- [ ] Build offer/answer and ICE flows with TURN fallback; add ICE restart and reconnection/backoff logic.
- [ ] Add adaptive bitrate: simulcast layers, bandwidth estimation, and renegotiation hooks.
- [ ] Basic UI to create/join a room; show participant tiles and connection indicators.

## 5) Roles, lobby, and access control
- [x] Enforce RBAC: admin (org policies, provisioning), user (schedule/host), guest (meeting-scoped). (basic roles in API)
- [ ] Meeting access rules: lobby/waiting room, host admit/deny, lock room, mute/kick.
- [x] Short-lived tokens for signaling; rotate media keys if using E2EE insertable streams. (JWT for signaling; rotation pending)

## 6) Scheduling and invites
- [x] CRUD for meetings with timezone handling, recurrence, and host assignment. (basic create/list with recurrence field)
- [x] Generate invite links with signed guest tokens and expiry; optional email with ICS attachment. (tokens done; email/ICS pending)
- [ ] Reminders and calendar integration (Google/Microsoft) if required; webhook handlers for updates.
- [x] Meeting policies per event: lobby required, recording allowed/required, screen share allowed, max participants. (policy object present; enforcement pending)

## 7) In-call features
- [ ] Screen share with role-based restrictions; optional application/window-only.
- [ ] Chat (transient by default); reactions; hand raise; simple moderation hooks.
- [ ] Recording strategy: server-side via SFU/MCU or client-side; consent prompts and visual indicators.
- [ ] Optional watermarking for screen share/recorded streams.

## 8) Security and privacy hardening
- [ ] All traffic over TLS; TURN with TLS/ALPN; rate limiting on signaling endpoints.
- [ ] CSRF protection on scheduling endpoints; JWT audience/issuer checks; replay protection on guest tokens.
- [ ] Audit logs for admin/user actions; DLP/PII policy if storing chat/recordings; retention windows.
- [ ] Security testing: JWT tampering, role escalation, meeting token abuse, TURN leakage, WebRTC IP leak checks.

## 9) Observability, scale, and resilience
- [ ] Metrics and traces: signaling latencies, join time, ICE success, bitrate, packet loss, SFU room stats.
- [ ] Structured logs with correlation IDs; per-call diagnostics export.
- [ ] Load tests with SFU under target topologies; chaos tests (packet loss/latency, TURN-only, ICE restart).
- [ ] Autoscaling for SFU/signaling; regional TURN/SFU placement and routing policy.

## 10) QA, rollout, and runbooks
- [ ] Browser matrix testing (Chrome/Firefox/Safari; desktop/mobile); accessibility and consent UX checks.
- [ ] Pen test + threat model review; fix blockers before beta.
- [ ] Create on-call runbooks: incident playbooks for audio/video failure, TURN exhaustion, SFU overload.
- [ ] Progressive rollout: internal dogfood → limited beta → GA; capture feedback and iterate policies.

## 11) Production readiness checklist
- [ ] Secrets in KMS; backups for DB; infra IaC (Terraform/Helm) for SFU/signaling/TURN.
- [ ] Default-secure configs: lobby on, recording off unless consented, screen share restricted.
- [ ] Monitoring alerts: join failure rate, ICE failure rate, TURN allocation errors, SFU CPU/bandwidth, auth errors.
- [ ] DR plan: multi-AZ for stateful services, tested restores, and log retention per compliance.
