import { IdempotencyRecord, ProtocolEvent } from '../../domain/protocol/types.js';

export interface ProtocolTrackingRepository {
  findIdempotencyRecord(key: string): Promise<IdempotencyRecord | null>;
  findRecentByFingerprint(input: {
    channel: IdempotencyRecord['channel'];
    case_id: string | null;
    participant_id: string | null;
    action_type: string;
    payload_hash: string;
    since: Date;
  }): Promise<IdempotencyRecord | null>;
  saveIdempotencyRecord(record: IdempotencyRecord): Promise<void>;
  saveProtocolEvent(event: ProtocolEvent): Promise<void>;
  listProtocolEvents(caseId: string): Promise<ProtocolEvent[]>;
}
