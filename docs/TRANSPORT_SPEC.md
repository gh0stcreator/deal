# Transport Spec

## Purpose
Define thin transport wiring over deterministic application services.

## Adapter responsibilities
- Parse command/request payload.
- Resolve actor identity (`telegramUserId`).
- Build idempotency context.
- Call `ProtocolGatewayService`.
- Map service results/errors into transport view models.

## Non-responsibilities
- No business-state mutation logic in handlers.
- No conversational fallback mode.
- No direct repository access from handlers.

## Telegram commands
- `/start`
- `/create_session`
- `/join_session <invite_token>`
- `/give_consent <session_id>`
- `/resume_intake <session_id>`
- `/confirm_summary <session_id>`
- `/reopen_intake <session_id>`
- `/generate_proposals <session_id>`
- `/select_preferred <session_id> <BALANCED|A_LEANING|B_LEANING>`
- `/accept_proposal <session_id> <BALANCED|A_LEANING|B_LEANING>`
- `/reject_proposal <session_id> <BALANCED|A_LEANING|B_LEANING>`
- `/suggest_edit <session_id> <variant> <clause_id> <operation> [proposed_value]`

## HTTP parity
HTTP endpoints mirror the same protocol actions and call the same gateway/service layer.

## Idempotency
### Telegram
- key format: `tg:{update_id}:{participant_id}:{action_type}`

### HTTP
- if header exists: `x-idempotency-key` -> `http:{correlation_id}:{header}`
- otherwise derived key: `http:{correlation_id}:{sha256(actionType,userId,payload)}`
- note: correlation id is prefixed in HTTP idempotency keys for end-to-end traceability.

### Retry dedupe window
- payload fingerprint (`payloadHash`) supports no-op dedupe of rapid retries with different keys.

## Authorization boundaries
- Actor must be a participant of the target session.
- No cross-session access.
- No cross-participant private artifact access.
- Unauthorized actions return deterministic transport errors.

## Rate limiting
- Join/invite brute-force protection: `8 requests / 60s` per participant.
- General protocol action spam protection: `30 requests / 60s` per participant/session scope.
- Invalid Telegram command spam protection: `10 requests / 60s` per participant.
- HTTP returns `429 RATE_LIMITED`; Telegram returns a short retry message.

## Visibility rules
- Participants can see: session stage, participant count, consent count, proposal/negotiation status.
- Participants cannot see: other side raw intake messages, assistant question history, private intake artifacts.
- Proposal and negotiation views expose only neutral/shared structures.

## Audit events
Every transport-triggered protocol action persists `ProtocolEvent` with:
- `caseId`
- `participantId`
- `actionType`
- `idempotencyKey`
- `channel`
- `outcome` (`ACCEPTED`, `NO_OP`, `ERROR`)
- `errorCode` (if any)
- version metadata (`sessionState`, `proposalSetVersion`, `roundNumber`) when available.

## Outbound delivery resilience
- Telegram outbound responses are retried with exponential backoff for transient failures.
- Protocol mutation success is decoupled from outbound delivery success.
- If outbound delivery fails after mutation, replaying the same action is safe via idempotency.
