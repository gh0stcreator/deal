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
import { IssueReactionTypes } from '../../src/domain/issue/types.js';
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
    issueRepo
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

  return { gateway, sessionId: created.session_id, issueRepo };
};

const completeIntake = async (
  gateway: ProtocolGatewayService,
  sessionId: string,
  telegramUserId: string,
  input: {
    situation_facts: string;
    tension_point: string;
    interest: string;
    constraint: string;
    desired_outcome: string;
    flexibility: string;
  }
) => {
  await gateway.getIntakeProgress(sessionId, telegramUserId);
  const answers: StructuredIntakeAnswerInput[] = [
    { field: 'facts', value: input.situation_facts },
    { field: 'interpretations', value: input.tension_point },
    { field: 'interests', value: input.interest },
    { field: 'constraints', value: input.constraint },
    { field: 'boundaries', value: input.constraint },
    { field: 'desired_outcome', value: input.desired_outcome },
    { field: 'acceptable_concessions', value: input.flexibility },
    { field: 'non_negotiables', value: input.constraint }
  ];
  await gateway.submitIntakeAnswers(
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
};

const prepareLoop = async (gateway: ProtocolGatewayService, sessionId: string) => {
  await gateway.buildProblemSynthesis(
    actionCtx('problem_synthesis', sessionId, '101', {}),
    sessionId,
    '101'
  );
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
  return gateway.generateIssueResolutionLoop(
    actionCtx('issue_loop_generate', sessionId, '101', {}),
    sessionId,
    '101'
  );
};

describe('issue resolution loop', () => {
  it('supports both sides accepting one option', async () => {
    const { gateway, sessionId } = await setup();
    await completeIntake(gateway, sessionId, '101', {
      situation_facts: 'Часто сдвигаются сроки и бюджет',
      tension_point: 'Напрягает непредсказуемость',
      interest: 'Нужен понятный план работ',
      constraint: 'Не подойдут изменения в последний момент',
      desired_outcome: 'Стабильный график и понятная оплата',
      flexibility: 'Готовы обсуждать перенос второстепенных задач'
    });
    await completeIntake(gateway, sessionId, '102', {
      situation_facts: 'Сложно планировать этапы из-за плавающих договорённостей',
      tension_point: 'Напрягает отсутствие фиксации условий',
      interest: 'Нужны чёткие роли и подтверждения',
      constraint: 'Не подойдёт формат без зафиксированных рамок',
      desired_outcome: 'Прозрачные этапы и понятный ритм',
      flexibility: 'Готовы двигать сроки по второстепенным задачам'
    });

    const loop = await prepareLoop(gateway, sessionId);
    const option = loop.options[0];

    await gateway.submitIssueOptionReaction(
      actionCtx('issue_option_reaction', sessionId, '101', {}),
      {
        session_id: sessionId,
        telegram_user_id: '101',
        loop_version: loop.loop_version,
        option_id: option.option_id,
        reaction_type: IssueReactionTypes.ACCEPT
      }
    );
    const summary = await gateway.submitIssueOptionReaction(
      actionCtx('issue_option_reaction', sessionId, '102', {}),
      {
        session_id: sessionId,
        telegram_user_id: '102',
        loop_version: loop.loop_version,
        option_id: option.option_id,
        reaction_type: IssueReactionTypes.ACCEPT
      }
    );

    expect(summary.status).toBe('WORKABLE_PATH_FOUND');
    expect(summary.workable_option_id).toBe(option.option_id);
  });

  it('handles one side accepts and one side rejects', async () => {
    const { gateway, sessionId } = await setup();
    await completeIntake(gateway, sessionId, '101', {
      situation_facts: 'Спор о сроках',
      tension_point: 'Напрягает задержка решений',
      interest: 'Важно ускорить согласование',
      constraint: 'Не подойдёт неопределённость дедлайна',
      desired_outcome: 'Фиксированный график',
      flexibility: 'Готовы двигать второстепенные задачи'
    });
    await completeIntake(gateway, sessionId, '102', {
      situation_facts: 'Спор о качестве',
      tension_point: 'Напрягает потеря качества при спешке',
      interest: 'Важно сохранить качество',
      constraint: 'Не подойдёт ускорение за счёт качества',
      desired_outcome: 'Сбалансированный ритм',
      flexibility: 'Готовы принимать промежуточные дедлайны'
    });
    const loop = await prepareLoop(gateway, sessionId);
    const option = loop.options[1];

    await gateway.submitIssueOptionReaction(
      actionCtx('issue_option_reaction', sessionId, '101', {}),
      {
        session_id: sessionId,
        telegram_user_id: '101',
        loop_version: loop.loop_version,
        option_id: option.option_id,
        reaction_type: IssueReactionTypes.ACCEPT
      }
    );
    const summary = await gateway.submitIssueOptionReaction(
      actionCtx('issue_option_reaction', sessionId, '102', {}),
      {
        session_id: sessionId,
        telegram_user_id: '102',
        loop_version: loop.loop_version,
        option_id: option.option_id,
        reaction_type: IssueReactionTypes.REJECT
      }
    );

    expect(summary.status).toBe('IN_PROGRESS');
    expect(summary.workable_option_id).toBeNull();
  });

  it('handles both sides rejecting all options', async () => {
    const { gateway, sessionId } = await setup();
    await completeIntake(gateway, sessionId, '101', {
      situation_facts: 'Конфликт по формату',
      tension_point: 'Напрягает навязанный формат',
      interest: 'Важно выбрать комфортный режим',
      constraint: 'Не подойдёт одностороннее решение',
      desired_outcome: 'Равноправный формат',
      flexibility: 'Готовы обсуждать сроки внедрения'
    });
    await completeIntake(gateway, sessionId, '102', {
      situation_facts: 'Конфликт по ролям',
      tension_point: 'Напрягает размытая ответственность',
      interest: 'Важно заранее закрепить зоны ответственности',
      constraint: 'Не подойдёт отсутствие письменной фиксации',
      desired_outcome: 'Прозрачная модель ответственности',
      flexibility: 'Готовы обсуждать формат ревизии'
    });
    const loop = await prepareLoop(gateway, sessionId);

    for (const option of loop.options) {
      await gateway.submitIssueOptionReaction(
        actionCtx('issue_option_reaction', sessionId, '101', { option: option.option_id }),
        {
          session_id: sessionId,
          telegram_user_id: '101',
          loop_version: loop.loop_version,
          option_id: option.option_id,
          reaction_type: IssueReactionTypes.REJECT
        }
      );
      await gateway.submitIssueOptionReaction(
        actionCtx('issue_option_reaction', sessionId, '102', { option: option.option_id }),
        {
          session_id: sessionId,
          telegram_user_id: '102',
          loop_version: loop.loop_version,
          option_id: option.option_id,
          reaction_type: IssueReactionTypes.REJECT
        }
      );
    }

    const summary = await gateway.getIssueResolutionSummary(sessionId, '101');
    expect(summary.status).toBe('NO_WORKABLE_PATH');
  });

  it('stores private change requests without leaking them in shared summary', async () => {
    const { gateway, sessionId, issueRepo } = await setup();
    const privateMarker = 'PRIVATE_CHANGE_REQ_999';
    await completeIntake(gateway, sessionId, '101', {
      situation_facts: 'Конфликт по дедлайнам',
      tension_point: 'Напрягает срыв этапов',
      interest: 'Важно соблюдать базовый план',
      constraint: 'Не подойдут внезапные переносы',
      desired_outcome: 'Понятный календарь',
      flexibility: 'Готовы двигать второстепенные этапы'
    });
    await completeIntake(gateway, sessionId, '102', {
      situation_facts: 'Конфликт по оплате',
      tension_point: 'Напрягает неоднозначность условий',
      interest: 'Важно заранее фиксировать суммы',
      constraint: 'Не подойдёт устная договорённость',
      desired_outcome: 'Прозрачная оплата',
      flexibility: 'Готовы обсуждать этапность'
    });
    const loop = await prepareLoop(gateway, sessionId);

    const summary = await gateway.submitIssueOptionReaction(
      actionCtx('issue_option_reaction', sessionId, '101', {}),
      {
        session_id: sessionId,
        telegram_user_id: '101',
        loop_version: loop.loop_version,
        option_id: loop.options[0].option_id,
        reaction_type: IssueReactionTypes.REQUEST_CHANGE,
        change_request: `Нужно уточнить пункт по срокам ${privateMarker}`
      }
    );

    expect(JSON.stringify(summary)).not.toContain(privateMarker);
    const reactions = await issueRepo.listReactions(sessionId, loop.loop_version);
    expect(reactions.some((entry) => entry.changeRequest?.includes(privateMarker))).toBe(true);
  });

  it('keeps options neutral and grounded', async () => {
    const { gateway, sessionId } = await setup();
    await completeIntake(gateway, sessionId, '101', {
      situation_facts: 'Есть спор о распределении задач',
      tension_point: 'Напрягает неравномерная нагрузка',
      interest: 'Важно равномерное распределение',
      constraint: 'Не подойдёт перекос по ролям',
      desired_outcome: 'Согласованный формат работ',
      flexibility: 'Готовы обсуждать ротацию'
    });
    await completeIntake(gateway, sessionId, '102', {
      situation_facts: 'Есть спор по срокам',
      tension_point: 'Напрягает риск просрочек',
      interest: 'Важно соблюдать дедлайны',
      constraint: 'Не подойдёт хаотичное планирование',
      desired_outcome: 'Предсказуемый ритм',
      flexibility: 'Готовы обсуждать приоритеты'
    });
    const loop = await prepareLoop(gateway, sessionId);
    const serialized = JSON.stringify(loop).toLowerCase();
    expect(serialized).not.toContain('виноват');
    expect(serialized).not.toMatch(/\b(ты|вы)?\s*прав(ы|а|)\b/u);
    expect(loop.issue_constraints).toHaveLength(2);
    expect(loop.options).toHaveLength(3);
    expect(new Set(loop.options.map((entry) => entry.title)).size).toBe(3);
  });

  it('produces different option sets for different conflict fixtures', async () => {
    const first = await setup();
    await completeIntake(first.gateway, first.sessionId, '101', {
      situation_facts: 'Спор о бюджете',
      tension_point: 'Напрягает перерасход',
      interest: 'Важно контролировать расходы',
      constraint: 'Не подойдут расходы без лимита',
      desired_outcome: 'Понятный бюджет',
      flexibility: 'Готовы обсуждать этапные лимиты'
    });
    await completeIntake(first.gateway, first.sessionId, '102', {
      situation_facts: 'Спор о бюджете и сроках',
      tension_point: 'Напрягает нестабильность финансирования',
      interest: 'Важно заранее знать условия оплаты',
      constraint: 'Не подойдёт неопределённая стоимость',
      desired_outcome: 'Предсказуемая оплата',
      flexibility: 'Готовы обсуждать график выплат'
    });
    const loopA = await prepareLoop(first.gateway, first.sessionId);

    const second = await setup();
    await completeIntake(second.gateway, second.sessionId, '101', {
      situation_facts: 'Спор о границах общения',
      tension_point: 'Напрягает жёсткий тон',
      interest: 'Важно уважительное общение',
      constraint: 'Не подойдёт давление в диалоге',
      desired_outcome: 'Спокойный рабочий тон',
      flexibility: 'Готовы обсуждать правила обратной связи'
    });
    await completeIntake(second.gateway, second.sessionId, '102', {
      situation_facts: 'Спор о правилах коммуникации',
      tension_point: 'Напрягают эмоциональные реакции',
      interest: 'Важно сохранить конструктив',
      constraint: 'Не подойдут личные оценки',
      desired_outcome: 'Понятные правила общения',
      flexibility: 'Готовы обсуждать формат фиксации договорённостей'
    });
    const loopB = await prepareLoop(second.gateway, second.sessionId);

    expect(loopA.options.map((entry) => entry.title).join('|')).not.toBe(
      loopB.options.map((entry) => entry.title).join('|')
    );
  });
});
