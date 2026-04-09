import { describe, expect, it } from 'vitest';
import { SystemClock } from '../../src/application/ports/Clock.js';
import { DeterministicIntakeNormalizer } from '../../src/application/ports/IntakeNormalizer.js';
import { IdGenerator } from '../../src/application/ports/IdGenerator.js';
import { IntakeService } from '../../src/application/services/IntakeService.js';
import { MediationService } from '../../src/application/services/MediationService.js';
import {
  IntakeAccessDeniedError,
  IntakeConflictError,
  IntakeValidationError,
  SummaryMismatchError
} from '../../src/domain/intake/errors.js';
import { IntakeFieldOrder, IntakeStates } from '../../src/domain/intake/types.js';
import { SessionStates } from '../../src/domain/session/types.js';
import { InMemoryIntakeRepository } from '../../src/infrastructure/repositories/InMemoryIntakeRepository.js';
import { InMemorySessionRepository } from '../../src/infrastructure/repositories/InMemorySessionRepository.js';

class FixedClock extends SystemClock {
  constructor(private value: Date) {
    super();
  }

  now(): Date {
    return this.value;
  }
}

class SequentialIdGenerator implements IdGenerator {
  private index = 0;

  nextId(): string {
    this.index += 1;
    return `id-${this.index}`;
  }
}

const bootstrap = async () => {
  const clock = new FixedClock(new Date('2026-01-03T00:00:00.000Z'));
  const ids = new SequentialIdGenerator();
  const sessionRepo = new InMemorySessionRepository();
  const intakeRepo = new InMemoryIntakeRepository();
  const mediation = new MediationService(sessionRepo, clock, ids);
  const intake = new IntakeService(
    sessionRepo,
    intakeRepo,
    new DeterministicIntakeNormalizer(),
    ids,
    clock
  );

  const created = await mediation.createSession('party-a');
  const joined = await mediation.joinSessionByInviteToken(created.inviteToken, 'party-b');
  await mediation.grantConsent(joined.id, 'party-a');
  await mediation.grantConsent(joined.id, 'party-b');

  return { sessionId: joined.id, intake, sessionRepo };
};

const completeIntake = async (
  intakeService: IntakeService,
  sessionId: string,
  userId: string
): Promise<{ summary: string; version: number }> => {
  let view = await intakeService.startOrResume(sessionId, userId);

  for (const field of IntakeFieldOrder) {
    view = await intakeService.submitFieldAnswer({
      sessionId,
      telegramUserId: userId,
      field,
      rawValue: `${userId} ${field}`,
      expectedVersion: view.version
    });
  }

  if (!view.generatedSummary) {
    throw new Error('Expected generated summary');
  }

  view = await intakeService.confirmSummary({
    sessionId,
    telegramUserId: userId,
    summary: view.generatedSummary,
    expectedVersion: view.version
  });

  return {
    summary: view.confirmedSummary ?? '',
    version: view.version
  };
};

describe('private intake flow', () => {
  it('supports interrupted flow and resume from exact step', async () => {
    const { intake, sessionId } = await bootstrap();

    const started = await intake.startOrResume(sessionId, 'party-a');

    const afterFirst = await intake.submitFieldAnswer({
      sessionId,
      telegramUserId: 'party-a',
      field: 'facts',
      rawValue: 'first answer',
      expectedVersion: started.version
    });

    expect(afterFirst.currentField).toBe('interpretations');

    const resumed = await intake.startOrResume(sessionId, 'party-a');
    expect(resumed.currentField).toBe('interpretations');
    expect(resumed.fields.facts.rawValue).toBe('first answer');
  });

  it('allows edit before confirmation and regenerates summary', async () => {
    const { intake, sessionId } = await bootstrap();
    let view = await intake.startOrResume(sessionId, 'party-a');

    for (const field of IntakeFieldOrder) {
      view = await intake.submitFieldAnswer({
        sessionId,
        telegramUserId: 'party-a',
        field,
        rawValue: `v1 ${field}`,
        expectedVersion: view.version
      });
    }

    const firstSummary = view.generatedSummary;

    view = await intake.submitFieldAnswer({
      sessionId,
      telegramUserId: 'party-a',
      field: 'facts',
      rawValue: 'edited facts',
      expectedVersion: view.version
    });

    expect(view.state).toBe(IntakeStates.SUMMARY_PENDING_CONFIRMATION);
    expect(view.generatedSummary).not.toBe(firstSummary);
  });

  it('rejects invalid transitions and out-of-order submissions', async () => {
    const { intake, sessionId } = await bootstrap();
    const started = await intake.startOrResume(sessionId, 'party-a');

    await expect(
      intake.submitFieldAnswer({
        sessionId,
        telegramUserId: 'party-a',
        field: 'interests',
        rawValue: 'skip facts',
        expectedVersion: started.version
      })
    ).rejects.toThrow(IntakeValidationError);
  });

  it('detects summary mismatch and supports regeneration', async () => {
    const { intake, sessionId } = await bootstrap();
    let view = await intake.startOrResume(sessionId, 'party-a');

    for (const field of IntakeFieldOrder) {
      view = await intake.submitFieldAnswer({
        sessionId,
        telegramUserId: 'party-a',
        field,
        rawValue: `ans ${field}`,
        expectedVersion: view.version
      });
    }

    await expect(
      intake.confirmSummary({
        sessionId,
        telegramUserId: 'party-a',
        summary: 'tampered summary',
        expectedVersion: view.version
      })
    ).rejects.toThrow(SummaryMismatchError);

    const regenerated = await intake.regenerateSummary({
      sessionId,
      telegramUserId: 'party-a',
      expectedVersion: view.version
    });

    expect(regenerated.generatedSummary).toBeTruthy();
  });

  it('rejects duplicate submissions with stale version (race condition)', async () => {
    const { intake, sessionId } = await bootstrap();
    const started = await intake.startOrResume(sessionId, 'party-a');

    const success = await intake.submitFieldAnswer({
      sessionId,
      telegramUserId: 'party-a',
      field: 'facts',
      rawValue: 'one',
      expectedVersion: started.version
    });

    expect(success.fields.facts.rawValue).toBe('one');

    await expect(
      intake.submitFieldAnswer({
        sessionId,
        telegramUserId: 'party-a',
        field: 'facts',
        rawValue: 'two',
        expectedVersion: started.version
      })
    ).rejects.toThrow(IntakeConflictError);
  });

  it('enforces privacy isolation between participants', async () => {
    const { intake, sessionId } = await bootstrap();

    let aView = await intake.startOrResume(sessionId, 'party-a');
    aView = await intake.submitFieldAnswer({
      sessionId,
      telegramUserId: 'party-a',
      field: 'facts',
      rawValue: 'A-private-facts',
      expectedVersion: aView.version
    });

    let bView = await intake.startOrResume(sessionId, 'party-b');
    bView = await intake.submitFieldAnswer({
      sessionId,
      telegramUserId: 'party-b',
      field: 'facts',
      rawValue: 'B-private-facts',
      expectedVersion: bView.version
    });

    const aData = await intake.getPrivateIntakeData(sessionId, 'party-a');
    const bData = await intake.getPrivateIntakeData(sessionId, 'party-b');

    expect(aData.rawMessages.some((m) => m.content.includes('A-private-facts'))).toBe(true);
    expect(aData.rawMessages.some((m) => m.content.includes('B-private-facts'))).toBe(false);

    expect(bData.rawMessages.some((m) => m.content.includes('B-private-facts'))).toBe(true);
    expect(bData.rawMessages.some((m) => m.content.includes('A-private-facts'))).toBe(false);

    await expect(intake.startOrResume(sessionId, 'intruder')).rejects.toThrow(IntakeAccessDeniedError);
  });

  it('moves session to ready_for_synthesis only after both intakes are completed', async () => {
    const { intake, sessionId, sessionRepo } = await bootstrap();

    await completeIntake(intake, sessionId, 'party-a');
    const mid = await sessionRepo.findById(sessionId);
    expect(mid?.state).toBe(SessionStates.SIDE_B_INTAKE);

    await completeIntake(intake, sessionId, 'party-b');
    const done = await sessionRepo.findById(sessionId);
    expect(done?.state).toBe(SessionStates.READY_FOR_SYNTHESIS);
  });
});
