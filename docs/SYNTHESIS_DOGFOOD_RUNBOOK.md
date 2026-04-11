# Mediation Dogfood Runbook (5–10 Sessions)

## Scope
Run full currently implemented flow:
`create -> join -> consent -> structured intake -> shared synthesis -> issue loop -> draft agreement/outcome`

## 1) Start a fresh session
1. In Telegram account A: `/start` -> `Создать договорённость`.
2. Send invite link/token to account B.
3. In account B: open link or join by token.
4. Both accounts press `Подтвердить участие`.
5. Both accounts submit short problem statement and confirm it.
6. Each account reacts to synthesis:
   - `Это похоже на правду` or
   - `Нет, нужно уточнить` (+ clarification text).
7. Continue issue loop and agreement draft until one outcome is visible (`agreement`/`partial_agreement`/`deadlock`) or participant drops.

## 2) Capture `session_id`
- Fast way via HTTP create response:
  - `POST /sessions/create` returns `session_id`.
- If session was created from Telegram only:
  - call status endpoint once you know participant id:
  - `GET /sessions/<session_id>/status?telegramUserId=<id>`
- During dogfood, keep a simple table: `session_id`, date, participants.

## 3) Inspect per-session full export
For each finished session:

`GET /sessions/<session_id>/full-export?telegramUserId=<participant_telegram_id>`

Check:
- `synthesis.review_summary`
- `issue_loop.reactions`
- `draft_agreement.final_outcome`
- `evaluation`:
  - `synthesis_confirmed`
  - `synthesis_clarified`
  - `option_accept_rate`
  - `agreement_reached`
  - `agreement_after_edit`
  - `deadlock`
  - `quality_flags`

## 4) Detect clarify-heavy sessions
Flag session as clarify-heavy if:
- `clarify_count >= 1` for pilot scale, or
- `review_summary != both_confirmed`.

## 5) Aggregate report for 5–10 sessions
`GET /dogfood/report`

Track:
1. `% both_confirmed synthesis`
2. `% workable_path_found`
3. `% agreement`
4. `% deadlock`
5. `top_failure_patterns`

## 6) Signals to watch in first 5–10 sessions
Track these exact metrics:
1. `both_confirmed` synthesis rate.
2. workable option acceptance trend (`option_accept_rate` by session).
3. agreement vs deadlock split.
4. Clarification themes:
   - “не узнал себя”
   - “слишком обобщено”
   - “искажён акцент”
   - any hint of private wording leakage.
5. sessions with `quality_flags`:
   - `low_recognition`
   - `over_generalization`
   - `full_option_rejection`
   - `repeated_edits_without_convergence`

## 7) Minimal go/no-go heuristic before broader rollout
- Go to next stage only if:
  - `both_confirmed` >= 70% of sessions,
  - no confirmed privacy leakage cases,
  - option rejection is not dominant,
  - clarifications are mostly “detail gap” (not “misrepresentation”).
- Hold if:
  - `both_clarified` appears repeatedly,
  - `full_option_rejection` dominates,
  - clarifications indicate trust/recognition issues.
