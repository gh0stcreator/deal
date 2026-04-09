import { describe, expect, it } from 'vitest';
import { SystemClock } from '../../src/application/ports/Clock.js';
import { DeterministicIntakeNormalizer } from '../../src/application/ports/IntakeNormalizer.js';
import { IdGenerator } from '../../src/application/ports/IdGenerator.js';
import { IntakeService } from '../../src/application/services/IntakeService.js';
import { MediationService } from '../../src/application/services/MediationService.js';
import { DeterministicSynthesisMapper } from '../../src/application/services/DeterministicSynthesisMapper.js';
import { SynthesisService } from '../../src/application/services/SynthesisService.js';
import { IntakeField, IntakeFieldOrder } from '../../src/domain/intake/types.js';
import { SynthesisPreconditionError } from '../../src/domain/synthesis/errors.js';
import { InMemoryIntakeRepository } from '../../src/infrastructure/repositories/InMemoryIntakeRepository.js';
import { InMemoryMediationSummaryRepository } from '../../src/infrastructure/repositories/InMemoryMediationSummaryRepository.js';
import { InMemorySessionRepository } from '../../src/infrastructure/repositories/InMemorySessionRepository.js';

class FixedClock extends SystemClock {
  constructor(private readonly fixed: Date) {
    super();
  }

  now(): Date {
    return this.fixed;
  }
}

class SequentialIdGenerator implements IdGenerator {
  private index = 0;

  nextId(): string {
    this.index += 1;
    return `id-${this.index}`;
  }
}

const defaultAnswers = (prefix: string): Record<IntakeField, string> => ({
  facts: `${prefix} facts`,
  interpretations: `${prefix} interpretation`,
  interests: `${prefix} interest in fair communication`,
  constraints: `${prefix} time and budget constraints`,
  boundaries: `${prefix} needs respectful tone`,
  desired_outcome: `${prefix} wants predictable schedule`,
  acceptable_concessions: `${prefix} can adjust timeline`,
  non_negotiables: `${prefix} no legal escalation`
});

const bootstrap = async () => {
  const clock = new FixedClock(new Date('2026-01-04T00:00:00.000Z'));
  const ids = new SequentialIdGenerator();
  const sessionRepo = new InMemorySessionRepository();
  const intakeRepo = new InMemoryIntakeRepository();
  const summaryRepo = new InMemoryMediationSummaryRepository();

  const mediation = new MediationService(sessionRepo, clock, ids);
  const intake = new IntakeService(
    sessionRepo,
    intakeRepo,
    new DeterministicIntakeNormalizer(),
    ids,
    clock
  );
  const synthesis = new SynthesisService(
    sessionRepo,
    intakeRepo,
    summaryRepo,
    new DeterministicSynthesisMapper(),
    ids,
    clock
  );

  const created = await mediation.createSession('party-a');
  const joined = await mediation.joinSessionByInviteToken(created.inviteToken, 'party-b');
  await mediation.grantConsent(joined.id, 'party-a');
  await mediation.grantConsent(joined.id, 'party-b');

  return {
    sessionId: joined.id,
    intake,
    synthesis,
    intakeRepo
  };
};

const completeIntake = async (
  intake: IntakeService,
  sessionId: string,
  userId: string,
  answers: Record<IntakeField, string>
) => {
  let view = await intake.startOrResume(sessionId, userId);

  for (const field of IntakeFieldOrder) {
    view = await intake.submitFieldAnswer({
      sessionId,
      telegramUserId: userId,
      field,
      rawValue: answers[field],
      expectedVersion: view.version
    });
  }

  if (!view.generatedSummary) {
    throw new Error('Expected summary generation');
  }

  await intake.confirmSummary({
    sessionId,
    telegramUserId: userId,
    summary: view.generatedSummary,
    expectedVersion: view.version
  });
};

describe('synthesis service', () => {
  it('does not leak raw participant phrases into synthesis output', async () => {
    const { intake, synthesis, sessionId } = await bootstrap();

    await completeIntake(intake, sessionId, 'party-a', {
      ...defaultAnswers('A'),
      facts: 'SECRET_A_987 payment issue'
    });
    await completeIntake(intake, sessionId, 'party-b', {
      ...defaultAnswers('B'),
      facts: 'SECRET_B_654 schedule issue'
    });

    const summary = await synthesis.synthesizeCase(sessionId);
    const serialized = JSON.stringify(summary.content);

    expect(serialized).not.toContain('SECRET_A_987');
    expect(serialized).not.toContain('SECRET_B_654');
  });

  it('keeps neutral representation symmetric in detail level', async () => {
    const { intake, synthesis, sessionId } = await bootstrap();

    await completeIntake(intake, sessionId, 'party-a', defaultAnswers('A'));
    await completeIntake(intake, sessionId, 'party-b', defaultAnswers('B'));

    const summary = await synthesis.synthesizeCase(sessionId);

    const aView = summary.content.neutral_representation_layer.for_party_a;
    const bView = summary.content.neutral_representation_layer.for_party_b;

    expect(Object.keys(aView).sort()).toEqual(Object.keys(bView).sort());
    expect(aView.what_seems_important_to_the_other_side.length).toBe(
      bView.what_seems_important_to_the_other_side.length
    );
    expect(aView.where_expectations_differ.length).toBe(
      bView.where_expectations_differ.length
    );
  });

  it('returns deterministic output shape for identical confirmed inputs', async () => {
    const run = async () => {
      const { intake, synthesis, sessionId } = await bootstrap();
      const same = defaultAnswers('same');
      await completeIntake(intake, sessionId, 'party-a', same);
      await completeIntake(intake, sessionId, 'party-b', same);
      return synthesis.synthesizeCase(sessionId);
    };

    const first = await run();
    const second = await run();

    expect(first.content).toEqual(second.content);
  });

  it('rejects synthesis when confirmed model is incomplete', async () => {
    const { intake, synthesis, sessionId, intakeRepo } = await bootstrap();

    await completeIntake(intake, sessionId, 'party-a', defaultAnswers('A'));
    await completeIntake(intake, sessionId, 'party-b', defaultAnswers('B'));

    const models = await intakeRepo.findConfirmedNormalizedModels(sessionId);
    const partyA = models.find((model) => model.participantRole === 'PARTY_A');
    if (!partyA || !partyA.normalizedPositionModel) {
      throw new Error('Expected PARTY_A model');
    }

    const intakeA = await intakeRepo.findByParticipantId(partyA.participantId);
    if (!intakeA || !intakeA.normalizedPositionModel) {
      throw new Error('Expected PARTY_A intake');
    }

    intakeA.normalizedPositionModel.interests = '';
    await intakeRepo.save(intakeA, { expectedVersion: intakeA.version });

    await expect(synthesis.synthesizeCase(sessionId)).rejects.toThrow(SynthesisPreconditionError);
  });

  it('detects conflicting non-negotiables', async () => {
    const { intake, synthesis, sessionId } = await bootstrap();

    await completeIntake(intake, sessionId, 'party-a', {
      ...defaultAnswers('A'),
      non_negotiables: 'no legal contract escalation'
    });
    await completeIntake(intake, sessionId, 'party-b', {
      ...defaultAnswers('B'),
      non_negotiables: 'legal contract escalation is required'
    });

    const summary = await synthesis.synthesizeCase(sessionId);

    expect(summary.content.non_negotiables_conflicts).toContain('Formal/legal process');
  });

  it('handles zero-overlap edge case explicitly', async () => {
    const { intake, synthesis, sessionId } = await bootstrap();

    await completeIntake(intake, sessionId, 'party-a', {
      ...defaultAnswers('A'),
      interests: 'budget cost payment',
      desired_outcome: 'budget savings',
      acceptable_concessions: 'none'
    });

    await completeIntake(intake, sessionId, 'party-b', {
      ...defaultAnswers('B'),
      interests: 'trust communication respect',
      desired_outcome: 'trust rebuilding',
      acceptable_concessions: 'none'
    });

    const summary = await synthesis.synthesizeCase(sessionId);

    expect(summary.content.overlapping_interests).toHaveLength(0);
    expect(summary.content.shared_goals).toHaveLength(0);
    expect(summary.content.risk_areas).toContain('Low overlap in articulated goals and interests');
  });
});
