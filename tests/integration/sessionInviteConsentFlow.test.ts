import { describe, expect, it } from 'vitest';
import { SystemClock } from '../../src/application/ports/Clock.js';
import { IdGenerator } from '../../src/application/ports/IdGenerator.js';
import { MediationService } from '../../src/application/services/MediationService.js';
import {
  DuplicateJoinError,
  ExpiredInviteTokenError,
  InvalidInviteTokenError,
  InvalidStateTransitionError
} from '../../src/domain/session/errors.js';
import { SessionStates } from '../../src/domain/session/types.js';
import { InMemorySessionRepository } from '../../src/infrastructure/repositories/InMemorySessionRepository.js';

class FixedClock extends SystemClock {
  constructor(private time: Date) {
    super();
  }

  now(): Date {
    return this.time;
  }

  set(time: Date): void {
    this.time = time;
  }
}

class SequentialIdGenerator implements IdGenerator {
  private i = 0;

  nextId(): string {
    this.i += 1;
    return `session-${this.i}`;
  }
}

describe('session/invite/join/consent integration flow', () => {
  it('supports valid session creation and invite generation', async () => {
    const repo = new InMemorySessionRepository();
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    const service = new MediationService(repo, clock, new SequentialIdGenerator());

    const created = await service.createSession('party-a');

    expect(created.session.id).toBe('session-1');
    expect(created.inviteToken).toBeTruthy();
    expect(created.session.state).toBe(SessionStates.INVITED);
  });

  it('rejects invalid invite token', async () => {
    const repo = new InMemorySessionRepository();
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    const service = new MediationService(repo, clock, new SequentialIdGenerator());

    await expect(service.joinSessionByInviteToken('invalid-token', 'party-b')).rejects.toThrow(
      InvalidInviteTokenError
    );
  });

  it('rejects expired invite token', async () => {
    const repo = new InMemorySessionRepository();
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    const service = new MediationService(repo, clock, new SequentialIdGenerator());

    const created = await service.createSession('party-a');
    clock.set(new Date('2026-01-10T00:00:00.000Z'));

    await expect(service.joinSessionByInviteToken(created.inviteToken, 'party-b')).rejects.toThrow(
      ExpiredInviteTokenError
    );
  });

  it('rejects duplicate join attempts', async () => {
    const repo = new InMemorySessionRepository();
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    const service = new MediationService(repo, clock, new SequentialIdGenerator());

    const created = await service.createSession('party-a');
    await service.joinSessionByInviteToken(created.inviteToken, 'party-b');

    await expect(service.joinSessionByInviteToken(created.inviteToken, 'party-b')).rejects.toThrow(
      DuplicateJoinError
    );
  });

  it('records both consents and transitions to consented', async () => {
    const repo = new InMemorySessionRepository();
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    const service = new MediationService(repo, clock, new SequentialIdGenerator());

    const created = await service.createSession('party-a');
    const joined = await service.joinSessionByInviteToken(created.inviteToken, 'party-b');

    const afterA = await service.grantConsent(joined.id, 'party-a');
    const afterB = await service.grantConsent(joined.id, 'party-b');

    expect(afterA.state).toBe(SessionStates.CONSENT_PENDING);
    expect(afterB.state).toBe(SessionStates.CONSENTED);
    expect(afterB.participants.filter((p) => p.consentGrantedAt).length).toBe(2);
  });

  it('rejects invalid state transitions after both parties have joined', async () => {
    const repo = new InMemorySessionRepository();
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    const service = new MediationService(repo, clock, new SequentialIdGenerator());

    const created = await service.createSession('party-a');
    await service.joinSessionByInviteToken(created.inviteToken, 'party-b');

    await expect(service.joinSessionByInviteToken(created.inviteToken, 'party-c')).rejects.toThrow(
      InvalidStateTransitionError
    );
  });
});
