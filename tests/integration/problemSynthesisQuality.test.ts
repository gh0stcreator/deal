import { describe, expect, it } from 'vitest';
import { DeterministicIntakeNormalizer } from '../../src/application/ports/IntakeNormalizer.js';
import { IntakeService } from '../../src/application/services/IntakeService.js';
import { MediationService } from '../../src/application/services/MediationService.js';
import { NegotiationService } from '../../src/application/services/NegotiationService.js';
import { DeterministicProposalMapper } from '../../src/application/services/DeterministicProposalMapper.js';
import { ProposalGenerationService } from '../../src/application/services/ProposalGenerationService.js';
import {
  ProtocolGatewayService,
  StructuredIntakeAnswerInput
} from '../../src/application/services/ProtocolGatewayService.js';
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

const completeStructuredIntake = async (
  gateway: ProtocolGatewayService,
  sessionId: string,
  telegramUserId: string,
  input: {
    situation_facts: string;
    tension_point: string;
    important_need_or_interest: string;
    hard_constraint: string;
    desired_outcome: string;
    acceptable_flexibility: string;
  }
) => {
  await gateway.getIntakeProgress(sessionId, telegramUserId);
  const answers: StructuredIntakeAnswerInput[] = [
    { field: 'facts', value: input.situation_facts },
    { field: 'interpretations', value: input.tension_point },
    { field: 'interests', value: input.important_need_or_interest },
    { field: 'constraints', value: input.hard_constraint },
    { field: 'boundaries', value: input.hard_constraint },
    { field: 'desired_outcome', value: input.desired_outcome },
    { field: 'acceptable_concessions', value: input.acceptable_flexibility },
    { field: 'non_negotiables', value: input.hard_constraint }
  ];
  const view = await gateway.submitIntakeAnswers(
    actionCtx('submit_intake_answers', sessionId, telegramUserId, { count: answers.length }),
    sessionId,
    telegramUserId,
    answers
  );
  await gateway.confirmSummary(
    actionCtx('confirm_summary', sessionId, telegramUserId, {}),
    sessionId,
    telegramUserId
  );
  return view;
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

    await completeStructuredIntake(gateway, sessionId, '101', {
      situation_facts: `Сейчас часто сдвигаются сроки и бюджет ${aMarker}`,
      tension_point: 'Напрягает отсутствие предсказуемости по дедлайнам',
      important_need_or_interest: 'Важно заранее понимать план и роли',
      hard_constraint: 'Не подойдут резкие переносы без предупреждения',
      desired_outcome: 'Нужен прозрачный график и понятная оплата',
      acceptable_flexibility: 'Готовы обсуждать перенос второстепенных задач'
    });
    await completeStructuredIntake(gateway, sessionId, '102', {
      situation_facts: `Есть риск срыва дедлайнов и перерасхода ${bMarker}`,
      tension_point: 'Напрягает, что договорённости часто плавают',
      important_need_or_interest: 'Важно фиксировать ответственность заранее',
      hard_constraint: 'Не подойдёт формат без заранее оговорённых рамок',
      desired_outcome: 'Нужен стабильный ритм работы и ясные условия',
      acceptable_flexibility: 'Готовы обсуждать перенос части этапов'
    });

    const synthesis = await gateway.buildProblemSynthesis(
      actionCtx('problem_synthesis', sessionId, '101', {}),
      sessionId,
      '101'
    );
    const text = JSON.stringify(synthesis.synthesis);
    assertNeutralNoLeakage(text, aMarker, bMarker);
    expect(synthesis.synthesis.shared_goal.length).toBeGreaterThan(10);
    expect(synthesis.synthesis.agreement_points.length).toBeGreaterThan(0);
    expect(synthesis.synthesis.primary_tension_point.length).toBeGreaterThan(5);
    expect(synthesis.synthesis.possible_zone_of_agreement.length).toBeGreaterThan(10);

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

    await completeStructuredIntake(gateway, sessionId, '101', {
      situation_facts: `Нужен понятный формат работы ${aMarker}`,
      tension_point: 'Напрягают изменения ролей в последний момент',
      important_need_or_interest: 'Важно чёткое разделение ответственности',
      hard_constraint: 'Не подойдёт размытая зона ответственности',
      desired_outcome: 'Нужны зафиксированные роли и процесс',
      acceptable_flexibility: 'Готовы обсуждать небольшую ротацию задач'
    });
    await completeStructuredIntake(gateway, sessionId, '102', {
      situation_facts: `Хочу более уважительный тон общения ${bMarker}`,
      tension_point: 'Напрягает жёсткая коммуникация в спорных моментах',
      important_need_or_interest: 'Важно уважительное взаимодействие',
      hard_constraint: 'Не подойдёт давление в диалоге',
      desired_outcome: 'Нужны ясные договорённости и спокойный тон',
      acceptable_flexibility: 'Готовы обсуждать формат фиксации договорённостей'
    });

    const synthesis = await gateway.buildProblemSynthesis(
      actionCtx('problem_synthesis', sessionId, '102', {}),
      sessionId,
      '102'
    );
    const text = JSON.stringify(synthesis.synthesis);
    assertNeutralNoLeakage(text, aMarker, bMarker);
    expect(synthesis.synthesis.shared_goal.length).toBeGreaterThan(10);
    expect(synthesis.synthesis.tension_points.length).toBeGreaterThan(0);
    expect(synthesis.synthesis.side_a_interest.length).toBeGreaterThan(10);
    expect(synthesis.synthesis.side_b_constraint.length).toBeGreaterThan(10);

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

    await completeStructuredIntake(gateway, sessionId, '101', {
      situation_facts: `Нужно быстро закрыть вопрос со сроками ${aMarker}`,
      tension_point: 'Напрягает затягивание решений',
      important_need_or_interest: 'Важно ускорить согласование',
      hard_constraint: 'Не подойдёт неопределённый дедлайн',
      desired_outcome: 'Нужен быстрый и финальный план',
      acceptable_flexibility: 'Готовы двигать вторичные задачи'
    });
    await completeStructuredIntake(gateway, sessionId, '102', {
      situation_facts: `Сроки вторичны, главное качество и роли ${bMarker}`,
      tension_point: 'Напрягает просадка качества при спешке',
      important_need_or_interest: 'Важно сохранить качество результата',
      hard_constraint: 'Не подойдёт ускорение за счёт качества',
      desired_outcome: 'Нужен сбалансированный ритм без потери качества',
      acceptable_flexibility: 'Готовы обсуждать промежуточные дедлайны'
    });

    const synthesis = await gateway.buildProblemSynthesis(
      actionCtx('problem_synthesis', sessionId, '101', {}),
      sessionId,
      '101'
    );
    const text = JSON.stringify(synthesis.synthesis);
    assertNeutralNoLeakage(text, aMarker, bMarker);
    expect(synthesis.synthesis.primary_tension_point.length).toBeGreaterThan(5);

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
