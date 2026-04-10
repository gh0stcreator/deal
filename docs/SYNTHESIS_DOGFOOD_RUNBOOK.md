# Synthesis Dogfood Runbook (5–10 Sessions)

## Scope
Run only the minimal flow:
`create -> join -> consent -> problem statement confirm -> shared synthesis -> review reaction`

No proposal generation in this pass.

## 1) Start a fresh session
1. In Telegram account A: `/start` -> `Создать договорённость`.
2. Send invite link/token to account B.
3. In account B: open link or join by token.
4. Both accounts press `Подтвердить участие`.
5. Both accounts submit short problem statement and confirm it.
6. Each account reacts to synthesis:
   - `Это похоже на правду` or
   - `Нет, нужно уточнить` (+ clarification text).

## 2) Capture `session_id`
- Fast way via HTTP create response:
  - `POST /sessions/create` returns `session_id`.
- If session was created from Telegram only:
  - call status endpoint once you know participant id:
  - `GET /sessions/<session_id>/status?telegramUserId=<id>`
- During dogfood, keep a simple table: `session_id`, date, participants.

## 3) Inspect synthesis review summary
For each finished session:

`GET /sessions/<session_id>/synthesis/review/export?telegramUserId=<participant_telegram_id>`

Returns:
- `session_id`
- `synthesis_version`
- `review_summary` (`both_confirmed`, `one_confirmed_one_clarified`, `both_clarified`, `incomplete`)
- `confirm_count`
- `clarify_count`

## 4) Detect clarify-heavy sessions
Flag session as clarify-heavy if:
- `clarify_count >= 1` for pilot scale, or
- `review_summary != both_confirmed`.

## 5) Signals to watch in first 5–10 sessions
Track these exact metrics:
1. `both_confirmed` rate.
2. `one_confirmed_one_clarified` count.
3. `both_clarified` count.
4. Clarification text themes:
   - “не узнал себя”
   - “слишком обобщено”
   - “искажён акцент”
   - any hint of private wording leakage.
5. Sessions with repeated clarify reactions after resend.

## 6) Minimal go/no-go heuristic before proposals
- Go to next stage only if:
  - `both_confirmed` >= 70% of sessions,
  - no confirmed privacy leakage cases,
  - clarify reasons are mostly “detail gap” (not “misrepresentation”).
- Hold if:
  - `both_clarified` appears repeatedly,
  - clarifications indicate trust/recognition issues.
