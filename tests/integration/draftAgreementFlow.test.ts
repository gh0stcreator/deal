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
import {
  DraftAgreementOutcomeTypes,
  DraftAgreementResponseTypes
} from '../../src/domain/agreement/types.js';
import { IssueReactionTypes } from '../../src/domain/issue/types.js';
import { InMemoryDraftAgreementRepository } from '../../src/infrastructure/repositories/InMemoryDraftAgreementRepository.js';
import { InMemoryIntakeRepository } from '../../src/infrastructure/repositories/InMemoryIntakeRepository.js';
import { InMemoryIssueResolutionRepository } from '../../src/infrastructure/repositories/InMemoryIssueResolutionRepository.js';
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

const actionCtx = (actionType: string, caseId: string, participantId: string, payload: unknown) => ({
  correlation_id: `test:${actionType}:${participantId}`,
  channel: 'HTTP' as const,
  idempotency_key: `test:${actionType}:${participantId}:${JSON.stringify(payload)}`,
  action_type: actionType,
  case_id: caseId,
  participant_id: participantId,
  payload
});

const setup = async () => {
  const clock = new MutableClock(new Date('2026-01-21T00:00:00.000Z'));
  const ids = new SequentialIdGenerator();
  const sessionRepo = new InMemorySessionRepository();
  const intakeRepo = new InMemoryIntakeRepository();
  const summaryRepo = new InMemoryMediationSummaryRepository();
  const proposalSetRepo = new InMemoryProposalSetRepository();
  const roundRepo = new InMemoryNegotiationRoundRepository();
  const trackingRepo = new InMemoryProtocolTrackingRepository();
  const synthesisReviewRepo = new InMemorySynthesisReviewRepository();
  const issueRepo = new InMemoryIssueResolutionRepository();
  const draftRepo = new InMemoryDraftAgreementRepository();

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
    synthesisReviewRepo,
    issueRepo,
    draftRepo
  );

  const created = await gateway.createSession(
    {
      correlation_id: 'setup:create',
      channel: 'HTTP',
      idempotency_key: 'setup:create:101',
      action_type: 'create_session',
      case_id: null,
      participant_id: '101',
      payload: {}
    },
    '101'
  );
  await gateway.joinSession(
    {
      correlation_id: 'setup:join',
      channel: 'HTTP',
      idempotency_key: 'setup:join:102',
      action_type: 'join_session',
      case_id: null,
      participant_id: '102',
      payload: {}
    },
    '102',
    created.invite_token
  );
  await gateway.giveConsent(actionCtx('give_consent', created.session_id, '101', {}), created.session_id, '101');
  await gateway.giveConsent(actionCtx('give_consent', created.session_id, '102', {}), created.session_id, '102');

  return { gateway, sessionId: created.session_id };
};

const completeIntake = async (
  gateway: ProtocolGatewayService,
  sessionId: string,
  telegramUserId: string,
  input: {
    facts: string;
    tension: string;
    interest: string;
    constraint: string;
    outcome: string;
    flexibility: string;
  }
) => {
  await gateway.getIntakeProgress(sessionId, telegramUserId);
  const answers: StructuredIntakeAnswerInput[] = [
    { field: 'facts', value: input.facts },
    { field: 'interpretations', value: input.tension },
    { field: 'interests', value: input.interest },
    { field: 'constraints', value: input.constraint },
    { field: 'boundaries', value: input.constraint },
    { field: 'desired_outcome', value: input.outcome },
    { field: 'acceptable_concessions', value: input.flexibility },
    { field: 'non_negotiables', value: input.constraint }
  ];
  await gateway.submitIntakeAnswers(
    actionCtx('submit_intake_answers', sessionId, telegramUserId, { count: answers.length }),
    sessionId,
    telegramUserId,
    answers
  );
  await gateway.confirmSummary(actionCtx('confirm_summary', sessionId, telegramUserId, {}), sessionId, telegramUserId);
};

const prepareWorkableLoop = async (gateway: ProtocolGatewayService, sessionId: string) => {
  await gateway.buildProblemSynthesis(actionCtx('problem_synthesis', sessionId, '101', {}), sessionId, '101');
  await gateway.recordProblemSynthesisReaction(
    actionCtx('synthesis_confirm', sessionId, '101', {}),
    sessionId,
    '101',
    'confirm'
  );
  await gateway.recordProblemSynthesisReaction(
    actionCtx('synthesis_confirm', sessionId, '102', {}),
    sessionId,
    '102',
    'confirm'
  );

  const loop = await gateway.generateIssueResolutionLoop(
    actionCtx('issue_loop_generate', sessionId, '101', {}),
    sessionId,
    '101'
  );

  await gateway.submitIssueOptionReaction(actionCtx('issue_react', sessionId, '101', {}), {
    session_id: sessionId,
    telegram_user_id: '101',
    loop_version: loop.loop_version,
    option_id: loop.options[0].option_id,
    reaction_type: IssueReactionTypes.ACCEPT
  });
  await gateway.submitIssueOptionReaction(actionCtx('issue_react', sessionId, '102', {}), {
    session_id: sessionId,
    telegram_user_id: '102',
    loop_version: loop.loop_version,
    option_id: loop.options[0].option_id,
    reaction_type: IssueReactionTypes.ACCEPT
  });

  return loop;
};

describe('draft agreement flow', () => {
  it('builds clean agreement when both accepted one option', async () => {
    const { gateway, sessionId } = await setup();
    await completeIntake(gateway, sessionId, '101', {
      facts: 'Спор о бытовом графике',
      tension: 'Нет понятного порядка',
      interest: 'Важно предсказуемое расписание',
      constraint: 'Не подойдут внезапные изменения',
      outcome: 'Понятный график на неделю',
      flexibility: 'Готовы менять второстепенные слоты'
    });
    await completeIntake(gateway, sessionId, '102', {
      facts: 'Спор о бытовом графике',
      tension: 'Не хватает прозрачности',
      interest: 'Важно знать правила заранее',
      constraint: 'Не подойдёт хаос без подтверждений',
      outcome: 'Прозрачный порядок действий',
      flexibility: 'Готовы обсуждать обмен слотами'
    });

    const loop = await prepareWorkableLoop(gateway, sessionId);
    const draft = await gateway.generateDraftAgreement(
      actionCtx('draft_generate', sessionId, '101', {}),
      sessionId,
      '101'
    );

    expect(draft.loop_version).toBe(loop.loop_version);
    expect(draft.agreed_actions.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(draft).toLowerCase()).not.toContain('стараться');
    expect(JSON.stringify(draft).toLowerCase()).not.toContain('учитывать');
  });

  it('supports agreement after edits', async () => {
    const { gateway, sessionId } = await setup();
    await completeIntake(gateway, sessionId, '101', {
      facts: 'Спор по дедлайнам',
      tension: 'Сроки срываются',
      interest: 'Нужен стабильный темп',
      constraint: 'Не подойдут переносы в последний день',
      outcome: 'План с фиксированными точками',
      flexibility: 'Готовы смещать второстепенные задачи'
    });
    await completeIntake(gateway, sessionId, '102', {
      facts: 'Спор по дедлайнам',
      tension: 'Не хватает подтверждений',
      interest: 'Нужна прозрачность изменений',
      constraint: 'Не подойдут скрытые правки',
      outcome: 'Понятный процесс согласований',
      flexibility: 'Готовы делать короткие синки'
    });
    await prepareWorkableLoop(gateway, sessionId);

    const draft = await gateway.generateDraftAgreement(
      actionCtx('draft_generate', sessionId, '101', {}),
      sessionId,
      '101'
    );

    await gateway.submitDraftAgreementResponse(actionCtx('draft_response', sessionId, '101', {}), {
      session_id: sessionId,
      telegram_user_id: '101',
      draft_version: draft.draft_version,
      response_type: DraftAgreementResponseTypes.REQUEST_CHANGE,
      change_request: 'Добавить правило про подтверждение до 20:00'
    });

    const regenerated = await gateway.regenerateDraftAgreement(
      actionCtx('draft_regen', sessionId, '102', {}),
      sessionId,
      '102'
    );

    await gateway.submitDraftAgreementResponse(
      actionCtx('draft_response', sessionId, '101', { v: regenerated.draft_version }),
      {
        session_id: sessionId,
        telegram_user_id: '101',
        draft_version: regenerated.draft_version,
        response_type: DraftAgreementResponseTypes.CONFIRM
      }
    );
    const decision = await gateway.submitDraftAgreementResponse(
      actionCtx('draft_response', sessionId, '102', { v: regenerated.draft_version }),
      {
        session_id: sessionId,
        telegram_user_id: '102',
        draft_version: regenerated.draft_version,
        response_type: DraftAgreementResponseTypes.CONFIRM
      }
    );

    expect(decision.outcome).toBe(DraftAgreementOutcomeTypes.AGREEMENT);
  });

  it('marks partial agreement when one confirms and second rejects', async () => {
    const { gateway, sessionId } = await setup();
    await completeIntake(gateway, sessionId, '101', {
      facts: 'Спор о задачах',
      tension: 'Перегруз',
      interest: 'Равномерная нагрузка',
      constraint: 'Не подойдёт перекос ролей',
      outcome: 'Чёткое распределение',
      flexibility: 'Готовы к ротации'
    });
    await completeIntake(gateway, sessionId, '102', {
      facts: 'Спор о задачах',
      tension: 'Просадки качества',
      interest: 'Сохранить качество',
      constraint: 'Не подойдёт ускорение в ущерб качеству',
      outcome: 'Баланс качества и сроков',
      flexibility: 'Готовы к этапному ревью'
    });
    await prepareWorkableLoop(gateway, sessionId);

    const draft = await gateway.generateDraftAgreement(
      actionCtx('draft_generate', sessionId, '101', {}),
      sessionId,
      '101'
    );
    await gateway.submitDraftAgreementResponse(actionCtx('draft_response', sessionId, '101', {}), {
      session_id: sessionId,
      telegram_user_id: '101',
      draft_version: draft.draft_version,
      response_type: DraftAgreementResponseTypes.CONFIRM
    });
    const decision = await gateway.submitDraftAgreementResponse(
      actionCtx('draft_response', sessionId, '102', {}),
      {
        session_id: sessionId,
        telegram_user_id: '102',
        draft_version: draft.draft_version,
        response_type: DraftAgreementResponseTypes.REJECT
      }
    );

    expect(decision.outcome).toBe(DraftAgreementOutcomeTypes.PARTIAL_AGREEMENT);
  });

  it('returns deadlock when both reject draft', async () => {
    const { gateway, sessionId } = await setup();
    await completeIntake(gateway, sessionId, '101', {
      facts: 'Спор о формате',
      tension: 'Сильное расхождение ожиданий',
      interest: 'Сохранить контроль по срокам',
      constraint: 'Не подойдёт гибкий режим',
      outcome: 'Жёсткая рамка',
      flexibility: 'Готовы обсуждать только детали'
    });
    await completeIntake(gateway, sessionId, '102', {
      facts: 'Спор о формате',
      tension: 'Нужна адаптивность',
      interest: 'Сохранить гибкость',
      constraint: 'Не подойдёт жёсткий регламент',
      outcome: 'Гибкая модель',
      flexibility: 'Готовы фиксировать базовые принципы'
    });
    await prepareWorkableLoop(gateway, sessionId);

    const draft = await gateway.generateDraftAgreement(
      actionCtx('draft_generate', sessionId, '102', {}),
      sessionId,
      '102'
    );
    await gateway.submitDraftAgreementResponse(actionCtx('draft_response', sessionId, '101', {}), {
      session_id: sessionId,
      telegram_user_id: '101',
      draft_version: draft.draft_version,
      response_type: DraftAgreementResponseTypes.REJECT
    });
    const decision = await gateway.submitDraftAgreementResponse(
      actionCtx('draft_response', sessionId, '102', {}),
      {
        session_id: sessionId,
        telegram_user_id: '102',
        draft_version: draft.draft_version,
        response_type: DraftAgreementResponseTypes.REJECT
      }
    );

    expect(decision.outcome).toBe(DraftAgreementOutcomeTypes.DEADLOCK);
  });

  it('does not generate draft when no workable option exists', async () => {
    const { gateway, sessionId } = await setup();
    await completeIntake(gateway, sessionId, '101', {
      facts: 'Спор о графике',
      tension: 'Напряжение по времени',
      interest: 'Нужен стабильный график',
      constraint: 'Не подойдут переносы',
      outcome: 'Фиксированный календарь',
      flexibility: 'Готовы двигать второстепенные блоки'
    });
    await completeIntake(gateway, sessionId, '102', {
      facts: 'Спор о графике',
      tension: 'Напряжение по формату',
      interest: 'Нужна гибкость',
      constraint: 'Не подойдёт фиксированная рамка',
      outcome: 'Гибкий календарь',
      flexibility: 'Готовы к коротким подтверждениям'
    });

    await gateway.buildProblemSynthesis(
      actionCtx('problem_synthesis', sessionId, '101', {}),
      sessionId,
      '101'
    );
    await gateway.recordProblemSynthesisReaction(
      actionCtx('synthesis_confirm', sessionId, '101', {}),
      sessionId,
      '101',
      'confirm'
    );
    await gateway.recordProblemSynthesisReaction(
      actionCtx('synthesis_confirm', sessionId, '102', {}),
      sessionId,
      '102',
      'confirm'
    );
    const loop = await gateway.generateIssueResolutionLoop(
      actionCtx('issue_loop_generate', sessionId, '101', {}),
      sessionId,
      '101'
    );

    for (const option of loop.options) {
      await gateway.submitIssueOptionReaction(
        actionCtx('issue_react', sessionId, '101', { option: option.option_id }),
        {
          session_id: sessionId,
          telegram_user_id: '101',
          loop_version: loop.loop_version,
          option_id: option.option_id,
          reaction_type: IssueReactionTypes.REJECT
        }
      );
      await gateway.submitIssueOptionReaction(
        actionCtx('issue_react', sessionId, '102', { option: option.option_id }),
        {
          session_id: sessionId,
          telegram_user_id: '102',
          loop_version: loop.loop_version,
          option_id: option.option_id,
          reaction_type: IssueReactionTypes.REJECT
        }
      );
    }

    await expect(
      gateway.generateDraftAgreement(actionCtx('draft_generate', sessionId, '101', {}), sessionId, '101')
    ).rejects.toMatchObject({ code: 'INTAKE_VALIDATION_ERROR' });
  });

  it('keeps draft neutral and without raw leakage markers', async () => {
    const { gateway, sessionId } = await setup();
    const marker = 'RAW_PRIVATE_MARKER_123';
    await completeIntake(gateway, sessionId, '101', {
      facts: `Факты ${marker}`,
      tension: 'Напряжение в коммуникации',
      interest: 'Спокойный формат',
      constraint: 'Не подойдёт давление',
      outcome: 'Понятные правила',
      flexibility: 'Готовы к ревью раз в неделю'
    });
    await completeIntake(gateway, sessionId, '102', {
      facts: `Другие факты ${marker}`,
      tension: 'Разные ожидания',
      interest: 'Прозрачность',
      constraint: 'Не подойдёт хаос',
      outcome: 'Единый ритм',
      flexibility: 'Готовы к согласованию приоритетов'
    });
    await prepareWorkableLoop(gateway, sessionId);

    const draft = await gateway.generateDraftAgreement(
      actionCtx('draft_generate', sessionId, '102', {}),
      sessionId,
      '102'
    );
    const serialized = JSON.stringify(draft).toLowerCase();

    expect(serialized).not.toContain(marker.toLowerCase());
    expect(serialized).not.toContain('виноват');
  });
});
