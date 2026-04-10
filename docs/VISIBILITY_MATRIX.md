# Visibility Matrix

## Scope
Defines transport-level visibility guarantees for Phase 7 hardening.

## Participants
- `Party A`: session initiator
- `Party B`: invited participant

## Visibility rules
| Artifact / View | Party A | Party B | Notes |
|---|---|---|---|
| Session stage/state | Yes | Yes | Shared protocol stage only |
| Participant count / consent count | Yes | Yes | No private message content |
| Own intake progress (state/current field/summary status) | Yes | Yes | Own record only |
| Other party intake raw messages | No | No | Strictly forbidden |
| Other party assistant question history | No | No | Strictly forbidden |
| Other party normalized private intake payload | No | No | Not exposed in transport |
| Mediation summary (neutral structured output) | Yes | Yes | Shared neutral artifact |
| Proposal variants | Yes | Yes | Shared negotiation artifact |
| Negotiation round status/outcome | Yes | Yes | Shared protocol status |
| Transport audit events | Internal only | Internal only | Debug/trace only, not user-facing |

## Invariants tested
- Unauthorized participant cannot act on session they do not belong to.
- Transport rendering does not leak private raw intake phrases.
- HTTP and Telegram parity routes expose the same protocol-safe structures.

## Non-goals
- Rich role-specific UX customization.
- Internal analytics/dashboard visibility.
