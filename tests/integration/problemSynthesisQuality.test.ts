import { describe, expect, it } from 'vitest';
import { DeterministicIntakeNormalizer } from '../../src/application/ports/IntakeNormalizer.js';
import { IntakeService } from '../../src/application/services/IntakeService.js';
import { MediationService } from '../../src/application/services/MediationService.js';
import { NegotiationService } from '../../src/application/services/NegotiationService.js';
import { DeterministicProposalMapper } from '../../src/application/services/DeterministicProposalMapper.js';
import { ProposalGenerationService } from '../../src/application/services/ProposalGenerationService.js';
import { ProtocolGatewayService } from '../../src/application/services/ProtocolGatewayService.js';
import { DeterministicSynthesisMapper } from '../../src/application/services/DeterministicSynthesisMapper.js';
import { SynthesisService } from '../../src/application/services/SynthesisService.js';
import { InMemoryIntakeRepository } from '../../src/infrastructure/repositories/InMemoryIntakeRepository.js';
import { InMemoryMediationSummaryRepository } from '../../src/infrastructure/repositories/InMemoryMediationSummaryRepository.js';
import { InMemoryNegotiationRoundRepository } from '../../src/infrastructure/repositories/InMemoryNegotiationRoundRepository.js';
import { InMemoryProposalSetRepository } from '../../src/infrastructure/repositories/InMemoryProposalSetRepository.js';
import { InMemoryProtocolTrackingRepository } from '../../src/infrastructure/repositories/InMemoryProtocolTrackingRepository.js';
import { InMemorySessionRepository } from '../../src/infrastructure/repositories/InMemorySessionRepository.js';
import { InMemorySynthesisReviewRepository } from '../../src/infrastructure/repositories/InMemorySynthesisReviewRepository.js';

class MutableClock {
  constructor(private value: Date) {}

  now(): Date {
    return this.value;
  }
}

class SequentialIdGenerator {
  private value = 0;

  nextId(): string {
    this.value += 1;
    return `id-${this.value}`;
  }
}

const actionCtx = (
  actionType: string,
  caseId: string | null,
  participantId: string | null,
  payload: unknown
) => ({
  correlation_id: `test:${actionType}`,
  channel: 'TELEGRAM' as const,
  idempotency_key: `test:${actionType}:${participantId ?? 'na'}:${JSON.stringify(payload)}`,
  action_type: actionType,
  case_id: caseId,
  participant_id: participantId,
  payload
});

const setupGateway = async () => {
  const clock = new MutableClock(new Date('2026-01-15T00:00:00.000Z'));
  const ids = new SequentialIdGenerator();
  const sessionRepo = new InMemorySessionRepository();
  const intakeRepo = new InMemoryIntakeRepository();
  const summaryRepo = new InMemoryMediationSummaryRepository();
  const proposalSetRepo = new InMemoryProposalSetRepository();
  const roundRepo = new InMemoryNegotiationRoundRepository();
  const trackingRepo = new InMemoryProtocolTrackingRepository();
  const synthesisReviewRepo = new InMemorySynthesisReviewRepository();

  const mediationService = new MediationService(sessionRepo, clock, ids);
  const intakeService = new IntakeService(
    sessionRepo,
    intakeRepo,
    new DeterministicIntakeNormalizer(),
    ids,
    clock
  );
  const synthesisService = new SynthesisService(
    sessionRepo,
    intakeRepo,
    summaryRepo,
    new DeterministicSynthesisMapper(),
    ids,
    clock
  );
  const proposalService = new ProposalGenerationService(
    sessionRepo,
    summaryRepo,
    proposalSetRepo,
    new DeterministicProposalMapper(),
    ids,
    clock
  );
  const negotiationService = new NegotiationService(
    sessionRepo,
    proposalSetRepo,
    roundRepo,
    ids,
    clock
  );

  const gateway = new ProtocolGatewayService(
    mediationService,
    intakeService,
    synthesisService,
    proposalService,
    negotiationService,
    sessionRepo,
    proposalSetRepo,
    trackingRepo,
    ids,
    clock,
    undefined,
    synthesisReviewRepo
  );

  const created = await gateway.createSession(
    actionCtx('create_session', null, '101', { telegramUserId: '101' }),
    '101'
  );
  await gateway.joinSession(
    actionCtx('join_session', null, '102', {
      telegramUserId: '102',
      inviteToken: created.invite_token
    }),
    '102',
    created.invite_token
  );
  await gateway.giveConsent(
    actionCtx('give_consent', created.session_id, '101', { sessionId: created.session_id }),
    created.session_id,
    '101'
  );
  await gateway.giveConsent(
    actionCtx('give_consent', created.session_id, '102', { sessionId: created.session_id }),
    created.session_id,
    '102'
  );

  return { gateway, sessionId: created.session_id };
};

const assertNeutralNoLeakage = (
  synthesisText: string,
  sideAMarker: string,
  sideBMarker: string
) => {
  expect(synthesisText.toLowerCase()).not.toContain(sideAMarker.toLowerCase());
  expect(synthesisText.toLowerCase()).not.toContain(sideBMarker.toLowerCase());
  expect(synthesisText.toLowerCase()).not.toContain('я прав');
  expect(synthesisText.toLowerCase()).not.toContain('он виноват');
  expect(synthesisText.toLowerCase()).not.toContain('она виновата');
};

describe('problem synthesis quality fixtures', () => {
  it('handles high-overlap case with neutral non-leaking summary', async () => {
    const { gateway, sessionId } = await setupGateway();
    const aMarker = 'УНИКАЛЬНЫЙ_МАРКЕР_A_11';
    const bMarker = 'УНИКАЛЬНЫЙ_МАРКЕР_B_22';

    await gateway.submitProblemDefinition(
      actionCtx('problem_definition', sessionId, '101', { text: `Хотим согласовать сроки и оплату ${aMarker}` }),
      sessionId,
      '101',
      `Хотим согласовать сроки и оплату ${aMarker}`
    );
    await gateway.submitProblemDefinition(
      actionCtx('problem_definition', sessionId, '102', { text: `Нужно договориться по дедлайнам и оплате ${bMarker}` }),
      sessionId,
      '102',
      `Нужно договориться по дедлайнам и оплате ${bMarker}`
    );

    const synthesis = await gateway.buildProblemSynthesis(
      actionCtx('problem_synthesis', sessionId, '101', {}),
      sessionId,
      '101'
    );
    const text = JSON.stringify(synthesis.synthesis);
    assertNeutralNoLeakage(text, aMarker, bMarker);
    expect(synthesis.synthesis.focus).toContain('согласовать');
    expect(synthesis.synthesis.shared_points.length).toBeGreaterThan(10);
    expect(synthesis.synthesis.divergence.length).toBeGreaterThan(10);

    await gateway.recordProblemSynthesisReaction(
      actionCtx('synthesis_confirm', sessionId, '101', { reaction: 'confirm' }),
      sessionId,
      '101',
      'confirm'
    );
    await gateway.recordProblemSynthesisReaction(
      actionCtx('synthesis_confirm', sessionId, '102', { reaction: 'confirm' }),
      sessionId,
      '102',
      'confirm'
    );
    const review = await gateway.getProblemSynthesisReviewSummary(sessionId, '101');
    expect(review.review_summary).toBe('both_confirmed');
  });

  it('handles low-overlap respectful case without side-specific phrasing copy-through', async () => {
    const { gateway, sessionId } = await setupGateway();
    const aMarker = 'A_SIDE_PRIVATE_PHRASE_777';
    const bMarker = 'B_SIDE_PRIVATE_PHRASE_888';

    await gateway.submitProblemDefinition(
      actionCtx('problem_definition', sessionId, '101', { text: `Хочу ясные роли и формат работы ${aMarker}` }),
      sessionId,
      '101',
      `Хочу ясные роли и формат работы ${aMarker}`
    );
    await gateway.submitProblemDefinition(
      actionCtx('problem_definition', sessionId, '102', { text: `Для меня важны уважительный тон и границы ${bMarker}` }),
      sessionId,
      '102',
      `Для меня важны уважительный тон и границы ${bMarker}`
    );

    const synthesis = await gateway.buildProblemSynthesis(
      actionCtx('problem_synthesis', sessionId, '102', {}),
      sessionId,
      '102'
    );
    const text = JSON.stringify(synthesis.synthesis);
    assertNeutralNoLeakage(text, aMarker, bMarker);
    expect(synthesis.synthesis.focus.length).toBeGreaterThan(10);
    expect(synthesis.synthesis.shared_points.length).toBeGreaterThan(10);
    expect(synthesis.synthesis.divergence.length).toBeGreaterThan(10);

    await gateway.recordProblemSynthesisReaction(
      actionCtx('synthesis_clarify', sessionId, '101', { reaction: 'clarify' }),
      sessionId,
      '101',
      'clarify'
    );
    await gateway.recordProblemSynthesisReaction(
      actionCtx('synthesis_clarify', sessionId, '102', { reaction: 'clarify' }),
      sessionId,
      '102',
      'clarify'
    );
    const review = await gateway.getProblemSynthesisReviewSummary(sessionId, '101');
    expect(review.review_summary).toBe('both_clarified');
  });

  it('handles conflicting framings and reports mixed review state', async () => {
    const { gateway, sessionId } = await setupGateway();
    const aMarker = 'PRIVATE_A_CONFLICT_123';
    const bMarker = 'PRIVATE_B_CONFLICT_456';

    await gateway.submitProblemDefinition(
      actionCtx('problem_definition', sessionId, '101', { text: `Нужно быстро закрыть вопрос по срокам ${aMarker}` }),
      sessionId,
      '101',
      `Нужно быстро закрыть вопрос по срокам ${aMarker}`
    );
    await gateway.submitProblemDefinition(
      actionCtx('problem_definition', sessionId, '102', { text: `Сроки вторичны, главное качество и роли ${bMarker}` }),
      sessionId,
      '102',
      `Сроки вторичны, главное качество и роли ${bMarker}`
    );

    const synthesis = await gateway.buildProblemSynthesis(
      actionCtx('problem_synthesis', sessionId, '101', {}),
      sessionId,
      '101'
    );
    const text = JSON.stringify(synthesis.synthesis);
    assertNeutralNoLeakage(text, aMarker, bMarker);

    await gateway.recordProblemSynthesisReaction(
      actionCtx('synthesis_confirm', sessionId, '101', { reaction: 'confirm' }),
      sessionId,
      '101',
      'confirm'
    );
    await gateway.recordProblemSynthesisReaction(
      actionCtx('synthesis_clarify', sessionId, '102', { reaction: 'clarify' }),
      sessionId,
      '102',
      'clarify'
    );

    const review = await gateway.getProblemSynthesisReviewSummary(sessionId, '101');
    expect(review.synthesis_version).toBe(synthesis.synthesis_version);
    expect(review.review_summary).toBe('one_confirmed_one_clarified');
  });
});
