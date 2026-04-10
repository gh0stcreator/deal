# API Spec (Phase 6)

Base URL: `http://localhost:3000`

## Health
### `GET /health`
- response: `{ "status": "ok" }`

## Session
### `POST /sessions/create`
- body: `{ "telegramUserId": "string" }`
- response `201`: `{ session_id, invite_token, state }`

### `POST /sessions/join`
- body: `{ "telegramUserId": "string", "inviteToken": "string" }`
- response: `{ session_id, state }`

### `POST /sessions/:sessionId/consent`
- body: `{ "telegramUserId": "string" }`
- response: `{ session_id, state }`

### `GET /sessions/:sessionId/status?telegramUserId=...`
- response: session status view model

### `GET /sessions/:sessionId/outcome?telegramUserId=...`
- response: terminal outcome summary view model

## Intake
### `POST /sessions/:sessionId/intake/resume`
- body: `{ "telegramUserId": "string" }`
- response: intake status view model

### `POST /sessions/:sessionId/intake/confirm-summary`
- body: `{ "telegramUserId": "string" }`
- response: intake status view model

### `POST /sessions/:sessionId/intake/reopen`
- body: `{ "telegramUserId": "string" }`
- response: intake status view model

## Proposal
### `POST /sessions/:sessionId/proposals/generate`
- body: `{ "telegramUserId": "string" }`
- response: proposal list view model

### `GET /sessions/:sessionId/proposals?telegramUserId=...`
- response: proposal list view model

### `GET /sessions/:sessionId/proposals?telegramUserId=...&variantType=BALANCED|A_LEANING|B_LEANING`
- response: proposal variant details view model

## Negotiation
### `POST /sessions/:sessionId/negotiation/select-preferred`
- body: `{ "telegramUserId": "string", "variantType": "BALANCED|A_LEANING|B_LEANING" }`

### `POST /sessions/:sessionId/negotiation/accept`
- body: `{ "telegramUserId": "string", "variantType": "BALANCED|A_LEANING|B_LEANING" }`

### `POST /sessions/:sessionId/negotiation/reject`
- body: `{ "telegramUserId": "string", "variantType": "BALANCED|A_LEANING|B_LEANING" }`

### `POST /sessions/:sessionId/negotiation/suggest-edit`
- body:
```json
{
  "telegramUserId": "string",
  "variantType": "BALANCED|A_LEANING|B_LEANING",
  "clauseId": "string",
  "operation": "MODIFY_CLAUSE_TEXT|ADJUST_TRADEOFF_NOTES|MARK_CLAUSE_UNACCEPTABLE",
  "proposedValue": "string|null"
}
```

### `GET /sessions/:sessionId/negotiation?telegramUserId=...`
- response: negotiation round status view model

## Idempotency
- Optional header: `x-idempotency-key` for POST endpoints.
- Duplicate actions return stable no-op responses.

## Error shape
```json
{
  "code": "STRING_CODE",
  "message": "Human-readable message"
}
```

## Error mapping highlights
- `401/403`: unauthorized participant/session access
- `404`: entity/token/session/variant not found
- `409`: invalid state transition / stale conflict / duplicate action / invite issues
- `422`: missing required data / validation errors
- `500`: unexpected internal failure
