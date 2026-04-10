import { ProtocolTrackingRepository } from '../../application/ports/ProtocolTrackingRepository.js';
import { IdempotencyRecord, ProtocolEvent } from '../../domain/protocol/types.js';

export class InMemoryProtocolTrackingRepository implements ProtocolTrackingRepository {
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly events: ProtocolEvent[] = [];

  async findIdempotencyRecord(key: string): Promise<IdempotencyRecord | null> {
    const found = this.idempotency.get(key);
    return found ? structuredClone(found) : null;
  }

  async findRecentByFingerprint(input: {
    channel: IdempotencyRecord['channel'];
    case_id: string | null;
    participant_id: string | null;
    action_type: string;
    payload_hash: string;
    since: Date;
  }): Promise<IdempotencyRecord | null> {
    const found = [...this.idempotency.values()]
      .filter(
        (record) =>
          record.channel === input.channel &&
          record.case_id === input.case_id &&
          record.participant_id === input.participant_id &&
          record.action_type === input.action_type &&
          record.payload_hash === input.payload_hash &&
          record.created_at.getTime() >= input.since.getTime()
      )
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];

    return found ? structuredClone(found) : null;
  }

  async saveIdempotencyRecord(record: IdempotencyRecord): Promise<void> {
    this.idempotency.set(record.key, structuredClone(record));
  }

  async saveProtocolEvent(event: ProtocolEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async listProtocolEvents(caseId: string): Promise<ProtocolEvent[]> {
    return this.events
      .filter((event) => event.case_id === caseId)
      .map((event) => structuredClone(event))
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  }
}
