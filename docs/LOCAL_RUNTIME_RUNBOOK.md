# Local Runtime Runbook (First Manual Run)

This is a copy-paste path from zero to first successful manual scenario.

## 0) One-time prerequisites
- Docker Desktop running
- Node.js 20+
- `pnpm` via `corepack`

## 1) Start infrastructure
```bash
cd /Users/rpopov/Documents/Codex/Договорились/deal
docker compose up -d postgres
```

## 2) Create `.env`
```bash
cat > .env <<'EOF'
DATABASE_URL=postgresql://deal:deal@localhost:5432/deal?schema=public
APP_PORT=3000
LOG_LEVEL=info
# optional: needed only for Telegram polling flow
# TELEGRAM_BOT_TOKEN=123456:replace_me
EOF
```

## 3) Install + generate Prisma client
```bash
corepack pnpm install
corepack pnpm prisma:generate
```

## 4) Apply migrations (must be green)
```bash
corepack pnpm prisma:deploy
```
Expected: exit code `0`, no `Schema engine error`.

## 5) Check migration status (must be green)
```bash
corepack pnpm prisma:status
```
Expected: exit code `0`, schema/migrations are up to date.

## 6) Run real Postgres runtime tests (must be green)
```bash
TEST_DATABASE_URL=postgresql://deal:deal@localhost:5432/deal?schema=public corepack pnpm test:postgres
```
Expected: test file `tests/integration/postgresRuntime.test.ts` passes.

## 7) Start application
```bash
corepack pnpm dev
```
Expected in logs:
- `HTTP server started`
- if no token: `Telegram bot token not configured. Bot bootstrap skipped.`
- if token set: `Telegram bot started`

## Exact HTTP demo path (without Telegram)
Run these in a second terminal while app is running.
Requires `jq` for variable extraction in commands below.

### Step A: create session (Party A = `101`)
```bash
CREATE_JSON=$(curl -s -X POST http://localhost:3000/sessions/create \
  -H 'content-type: application/json' \
  -H 'x-idempotency-key: demo-create-1' \
  -d '{"telegramUserId":"101"}')
echo "$CREATE_JSON"
SESSION_ID=$(echo "$CREATE_JSON" | jq -r '.session_id')
INVITE_TOKEN=$(echo "$CREATE_JSON" | jq -r '.invite_token')
```
Expected HTTP status: `201`  
Expected body shape:
```json
{
  "session_id": "string",
  "invite_token": "string",
  "state": "INVITED"
}
```

### Step B: join session (Party B = `102`)
```bash
JOIN_JSON=$(curl -s -X POST http://localhost:3000/sessions/join \
  -H 'content-type: application/json' \
  -H 'x-idempotency-key: demo-join-1' \
  -d "{\"telegramUserId\":\"102\",\"inviteToken\":\"$INVITE_TOKEN\"}")
echo "$JOIN_JSON"
```
Expected HTTP status: `200`  
Expected body shape:
```json
{
  "session_id": "same-as-created",
  "state": "CONSENT_PENDING"
}
```

### Step C: consent from Party A
```bash
CONSENT_A_JSON=$(curl -s -X POST "http://localhost:3000/sessions/$SESSION_ID/consent" \
  -H 'content-type: application/json' \
  -H 'x-idempotency-key: demo-consent-a-1' \
  -d '{"telegramUserId":"101"}')
echo "$CONSENT_A_JSON"
```
Expected HTTP status: `200`  
Expected body shape:
```json
{
  "session_id": "same-session",
  "state": "CONSENT_PENDING"
}
```

### Step D: consent from Party B
```bash
CONSENT_B_JSON=$(curl -s -X POST "http://localhost:3000/sessions/$SESSION_ID/consent" \
  -H 'content-type: application/json' \
  -H 'x-idempotency-key: demo-consent-b-1' \
  -d '{"telegramUserId":"102"}')
echo "$CONSENT_B_JSON"
```
Expected HTTP status: `200`  
Expected body shape:
```json
{
  "session_id": "same-session",
  "state": "CONSENTED"
}
```

### Step E: verify session status view
```bash
curl -s "http://localhost:3000/sessions/$SESSION_ID/status?telegramUserId=101"
```
Expected body fields and values:
- `session_id` = created session id
- `state` = `CONSENTED`
- `participant_count` = `2`
- `both_joined` = `true`
- `consent_count` = `2`
- `all_consented` = `true`

## Telegram flow (if `TELEGRAM_BOT_TOKEN` is set)
Use two Telegram accounts.

### Party A
1. `/start`  
   Expected: command list from bot.
2. `/create_session`  
   Expected message includes:
   - `Session created: <session_id>`
   - `state: INVITED`
   - `invite_token: <token>`

### Party B
3. `/join_session <invite_token>`  
   Expected: `Joined session <session_id>` and `state: CONSENT_PENDING`

### Consent
4. Party A: `/give_consent <session_id>`  
   Expected block includes `consent: CONSENT_PENDING`
5. Party B: `/give_consent <session_id>`  
   Expected block includes `consent: CONSENTED`

## Required env variables
- Required always: `DATABASE_URL`
- Required only for Postgres integration tests: `TEST_DATABASE_URL`
- Optional: `APP_PORT` (default `3000`)
- Optional: `LOG_LEVEL` (default `info`)
- Optional (Telegram only): `TELEGRAM_BOT_TOKEN`

## Troubleshooting (only blockers for first run)
- `Schema engine error`: Postgres is not reachable at `localhost:5432` or wrong `DATABASE_URL`.
- Runtime tests fail in `beforeAll`: fix DB connectivity first; harness teardown already guards against secondary `afterAll` crash.
