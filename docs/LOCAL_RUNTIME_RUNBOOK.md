# Local Runtime Runbook

## 1) Start Postgres
```bash
docker compose up -d postgres
```

## 2) Install deps + generate Prisma client
```bash
corepack pnpm install
corepack pnpm prisma:generate
```

## 3) Apply migrations (green gate #1)
```bash
DATABASE_URL='postgresql://deal:deal@localhost:5432/deal?schema=public' corepack pnpm prisma:deploy
```

## 4) Verify migration status (green gate #2)
```bash
DATABASE_URL='postgresql://deal:deal@localhost:5432/deal?schema=public' corepack pnpm prisma:status
```

## 5) Run real Postgres runtime tests (green gate #3)
```bash
DATABASE_URL='postgresql://deal:deal@localhost:5432/deal?schema=public' \
TEST_DATABASE_URL='postgresql://deal:deal@localhost:5432/deal?schema=public' \
corepack pnpm test:postgres
```

## 6) Start application
```bash
corepack pnpm dev
```

## Required env vars
- `DATABASE_URL` (required)
- `APP_PORT` (optional, default 3000)
- `LOG_LEVEL` (optional)
- `TEST_DATABASE_URL` (required only for Postgres runtime tests)
- `TELEGRAM_BOT_TOKEN` (optional for HTTP-only flow)

## Telegram token requirement now
- Not required for HTTP-only runtime verification.
- Required only if you want bot polling + Telegram command flow.

## Verify HTTP flow without Telegram
1. Create session:
```bash
curl -s -X POST http://localhost:3000/sessions/create \
  -H 'content-type: application/json' \
  -d '{"telegramUserId":"101"}'
```
2. Use returned `invite_token` to join:
```bash
curl -s -X POST http://localhost:3000/sessions/join \
  -H 'content-type: application/json' \
  -d '{"telegramUserId":"102","inviteToken":"<TOKEN>"}'
```
3. Grant consent for both sides:
```bash
curl -s -X POST http://localhost:3000/sessions/<SESSION_ID>/consent \
  -H 'content-type: application/json' \
  -d '{"telegramUserId":"101"}'

curl -s -X POST http://localhost:3000/sessions/<SESSION_ID>/consent \
  -H 'content-type: application/json' \
  -d '{"telegramUserId":"102"}'
```
4. Check state:
```bash
curl -s "http://localhost:3000/sessions/<SESSION_ID>/status?telegramUserId=101"
```

## Verify Telegram flow if token is set
1. Put real token into `.env` as `TELEGRAM_BOT_TOKEN`.
2. Start app (`corepack pnpm dev`).
3. In Telegram DM with bot run:
- `/start`
- `/create_session`
- `/join_session <invite_token>` (from second account)
- `/give_consent <session_id>`

## Quick troubleshooting
- If Prisma says `Schema engine error`, verify Postgres is reachable on `localhost:5432`.
- If `test:postgres` fails in setup, fix DB connectivity first; protocol code may still be healthy.
