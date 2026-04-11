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
import { DraftAgreementResponseTypes } from '../../src/domain/agreement/types.js';
import { IssueReactionTypes } from '../../src/domain/issue/types.js';
import { buildHttpServer } from '../../src/infrastructure/http/server.js';
import { InMemoryDraftAgreementRepository } from '../../src/infrastructure/repositories/InMemoryDraftAgreementRepository.js';
import { InMemoryIntakeRepository } from '../../src/infrastructure/repositories/InMemoryIntakeRepository.js';
import { InMemoryIssueResolutionRepository } from '../../src/infrastructure/repositories/InMemoryIssueResolutionRepository.js';
import { InMemoryMediationSummaryRepository } from '../../src/infrastructure/repositories/InMemoryMediationSummaryRepository.js';
import { InMemoryNegotiationRoundRepository } from '../../src/infrastructure/repositories/InMemoryNegotiationRoundRepository.js';
import { InMemoryProposalSetRepository } from '../../src/infrastructure/repositories/InMemoryProposalSetRepository.js';
import { InMemoryProtocolTrackingRepository } from '../../src/infrastructure/repositories/InMemoryProtocolTrackingRepository.js';
import { InMemorySessionEvaluationRepository } from '../../src/infrastructure/repositories/InMemorySessionEvaluationRepository.js';
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

const ctx = (actionType: string, caseId: string | null, participantId: string, payload: unknown) => ({
  correlation_id: `test:${actionType}:${participantId}`,
  channel: 'HTTP' as const,
  idempotency_key: `test:${actionType}:${participantId}:${caseId ?? 'na'}:${JSON.stringify(payload)}`,
  action_type: actionType,
  case_id: caseId,
  participant_id: participantId,
  payload
});

const setup = () => {
  const clock = new MutableClock(new Date('2026-02-01T00:00:00.000Z'));
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
  const evaluationRepo = new InMemorySessionEvaluationRepository();

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
    draftRepo,
    evaluationRepo
  );

  return { gateway };
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
    ctx('submit_intake_answers', sessionId, telegramUserId, { count: answers.length }),
    sessionId,
    telegramUserId,
    answers
  );
  await gateway.confirmSummary(ctx('confirm_summary', sessionId, telegramUserId, {}), sessionId, telegramUserId);
};

let caseSequence = 0;

const createCaseWithIntake = async (
  gateway: ProtocolGatewayService,
  a: Parameters<typeof completeIntake>[3],
  b: Parameters<typeof completeIntake>[3]
) => {
  caseSequence += 1;
  const seed = `${caseSequence}`;
  const created = await gateway.createSession(
    ctx('create_session', null, '101', { telegramUserId: '101', seed }),
    '101'
  );
  await gateway.joinSession(
    ctx('join_session', null, '102', { telegramUserId: '102', inviteToken: created.invite_token }),
    '102',
    created.invite_token
  );
  await gateway.giveConsent(ctx('give_consent', created.session_id, '101', {}), created.session_id, '101');
  await gateway.giveConsent(ctx('give_consent', created.session_id, '102', {}), created.session_id, '102');
  await completeIntake(gateway, created.session_id, '101', a);
  await completeIntake(gateway, created.session_id, '102', b);
  return created.session_id;
};

describe('dogfood hardening and quality validation', () => {
  it('exports full session snapshot and keeps private raw artifacts hidden', async () => {
    const { gateway } = setup();
    const sessionId = await createCaseWithIntake(
      gateway,
      {
        facts: 'Бытовой конфликт: UNIQUE_RAW_A_123',
        tension: 'Напрягает, что график не закреплён',
        interest: 'Важно предсказуемое утро',
        constraint: 'Не подойдут внезапные изменения',
        outcome: 'Понятный порядок использования ванной',
        flexibility: 'Готов обсудить смену слотов по дням'
      },
      {
        facts: 'Бытовой конфликт: UNIQUE_RAW_B_456',
        tension: 'Напрягает, что договорённость каждый день новая',
        interest: 'Важно знать порядок заранее',
        constraint: 'Не подойдёт отсутствие фиксированного окна',
        outcome: 'Прозрачный график без споров',
        flexibility: 'Готова обсуждать сдвиг времени в пределах 10 минут'
      }
    );

    const synthesis = await gateway.buildProblemSynthesis(
      ctx('problem_synthesis', sessionId, '101', {}),
      sessionId,
      '101'
    );
    await gateway.recordProblemSynthesisReaction(
      ctx('synthesis_react', sessionId, '101', { reaction: 'confirm' }),
      sessionId,
      '101',
      'confirm'
    );
    await gateway.recordProblemSynthesisReaction(
      ctx('synthesis_react', sessionId, '102', { reaction: 'confirm' }),
      sessionId,
      '102',
      'confirm'
    );

    const loop = await gateway.generateIssueResolutionLoop(
      ctx('issue_loop_generate', sessionId, '101', {}),
      sessionId,
      '101'
    );
    await gateway.submitIssueOptionReaction(ctx('issue_react', sessionId, '101', { option: 'change' }), {
      session_id: sessionId,
      telegram_user_id: '101',
      loop_version: loop.loop_version,
      option_id: loop.options[1].option_id,
      reaction_type: IssueReactionTypes.REQUEST_CHANGE,
      change_request: 'PRIVATE_CHANGE_REQUEST_A_999'
    });
    await gateway.submitIssueOptionReaction(ctx('issue_react', sessionId, '101', {}), {
      session_id: sessionId,
      telegram_user_id: '101',
      loop_version: loop.loop_version,
      option_id: loop.options[0].option_id,
      reaction_type: IssueReactionTypes.ACCEPT
    });
    await gateway.submitIssueOptionReaction(ctx('issue_react', sessionId, '102', {}), {
      session_id: sessionId,
      telegram_user_id: '102',
      loop_version: loop.loop_version,
      option_id: loop.options[0].option_id,
      reaction_type: IssueReactionTypes.ACCEPT
    });

    const draft = await gateway.generateDraftAgreement(
      ctx('draft_generate', sessionId, '101', {}),
      sessionId,
      '101'
    );
    await gateway.submitDraftAgreementResponse(ctx('draft_response', sessionId, '101', {}), {
      session_id: sessionId,
      telegram_user_id: '101',
      draft_version: draft.draft_version,
      response_type: DraftAgreementResponseTypes.CONFIRM
    });
    await gateway.submitDraftAgreementResponse(ctx('draft_response', sessionId, '102', {}), {
      session_id: sessionId,
      telegram_user_id: '102',
      draft_version: draft.draft_version,
      response_type: DraftAgreementResponseTypes.CONFIRM
    });

    const exported = await gateway.getSessionFullExport(sessionId, '101');
    expect(exported.synthesis.version).toBe(synthesis.synthesis_version);
    expect(exported.synthesis.review_summary).toBe('both_confirmed');
    expect(exported.draft_agreement.final_outcome).toBe('AGREEMENT');
    expect(exported.evaluation.synthesis_confirmed).toBe(true);
    expect(exported.evaluation.agreement_reached).toBe(true);

    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain('rawMessages');
    expect(serialized).not.toContain('assistantQuestions');
    expect(serialized).not.toContain('PRIVATE_CHANGE_REQUEST_A_999');
  });

  it('builds dogfood report across four conflict fixtures', async () => {
    const { gateway } = setup();

    // 1) simple household conflict: agreement
    {
      const sessionId = await createCaseWithIntake(
        gateway,
        {
          facts: 'Бытовой график пересекается каждый день',
          tension: 'Напрягает утренний хаос',
          interest: 'Важно спокойно собираться',
          constraint: 'Не подойдёт спонтанная смена слотов',
          outcome: 'Чёткий порядок на неделю',
          flexibility: 'Готов двигать второстепенные слоты'
        },
        {
          facts: 'Утром возникают споры из-за ванной',
          tension: 'Напрягает непредсказуемость',
          interest: 'Важно понимать порядок заранее',
          constraint: 'Не подойдёт отсутствие фиксированных границ',
          outcome: 'Согласованный и понятный порядок',
          flexibility: 'Готова двигать время по договорённости'
        }
      );
      const synthesis = await gateway.buildProblemSynthesis(
        ctx('problem_synthesis', sessionId, '101', {}),
        sessionId,
        '101'
      );
      await gateway.recordProblemSynthesisReaction(
        ctx('synthesis_react', sessionId, '101', {}),
        sessionId,
        '101',
        'confirm'
      );
      await gateway.recordProblemSynthesisReaction(
        ctx('synthesis_react', sessionId, '102', {}),
        sessionId,
        '102',
        'confirm'
      );
      const loop = await gateway.generateIssueResolutionLoop(
        ctx('issue_loop_generate', sessionId, '101', {}),
        sessionId,
        '101'
      );
      await gateway.submitIssueOptionReaction(ctx('issue_react', sessionId, '101', {}), {
        session_id: sessionId,
        telegram_user_id: '101',
        loop_version: loop.loop_version,
        option_id: loop.options[0].option_id,
        reaction_type: IssueReactionTypes.ACCEPT
      });
      await gateway.submitIssueOptionReaction(ctx('issue_react', sessionId, '102', {}), {
        session_id: sessionId,
        telegram_user_id: '102',
        loop_version: loop.loop_version,
        option_id: loop.options[0].option_id,
        reaction_type: IssueReactionTypes.ACCEPT
      });
      const draft = await gateway.generateDraftAgreement(
        ctx('draft_generate', sessionId, '101', {}),
        sessionId,
        '101'
      );
      await gateway.submitDraftAgreementResponse(ctx('draft_response', sessionId, '101', {}), {
        session_id: sessionId,
        telegram_user_id: '101',
        draft_version: draft.draft_version,
        response_type: DraftAgreementResponseTypes.CONFIRM
      });
      await gateway.submitDraftAgreementResponse(ctx('draft_response', sessionId, '102', {}), {
        session_id: sessionId,
        telegram_user_id: '102',
        draft_version: draft.draft_version,
        response_type: DraftAgreementResponseTypes.CONFIRM
      });
      expect(synthesis.synthesis.primary_tension_point.length).toBeGreaterThan(8);
      await gateway.getSessionFullExport(sessionId, '101');
    }

    // 2) work responsibility conflict: one side clarifies + mixed option reactions
    {
      const sessionId = await createCaseWithIntake(
        gateway,
        {
          facts: 'Команда спорит о зоне ответственности',
          tension: 'Напрягает что задачи передаются в последний момент',
          interest: 'Важно заранее понимать роль',
          constraint: 'Не подойдёт плавающая ответственность',
          outcome: 'Прозрачная ответственность по этапам',
          flexibility: 'Готов брать дополнительные задачи при раннем согласовании'
        },
        {
          facts: 'Часть задач остаётся без владельца',
          tension: 'Напрягают взаимные претензии',
          interest: 'Важно, чтобы работа не останавливалась',
          constraint: 'Не подойдёт узкая роль без подстраховки',
          outcome: 'Понятный процесс с резервным владельцем',
          flexibility: 'Готова менять приоритет задач по ситуации'
        }
      );
      await gateway.buildProblemSynthesis(ctx('problem_synthesis', sessionId, '101', {}), sessionId, '101');
      await gateway.recordProblemSynthesisReaction(
        ctx('synthesis_react', sessionId, '101', {}),
        sessionId,
        '101',
        'confirm'
      );
      await gateway.recordProblemSynthesisReaction(
        ctx('synthesis_react', sessionId, '102', {}),
        sessionId,
        '102',
        'clarify'
      );
      const loop = await gateway.generateIssueResolutionLoop(
        ctx('issue_loop_generate', sessionId, '101', {}),
        sessionId,
        '101'
      );
      await gateway.submitIssueOptionReaction(ctx('issue_react', sessionId, '101', {}), {
        session_id: sessionId,
        telegram_user_id: '101',
        loop_version: loop.loop_version,
        option_id: loop.options[0].option_id,
        reaction_type: IssueReactionTypes.ACCEPT
      });
      await gateway.submitIssueOptionReaction(ctx('issue_react', sessionId, '102', {}), {
        session_id: sessionId,
        telegram_user_id: '102',
        loop_version: loop.loop_version,
        option_id: loop.options[0].option_id,
        reaction_type: IssueReactionTypes.REJECT
      });
      await gateway.getSessionFullExport(sessionId, '101');
    }

    // 3) emotional conflict: both ask changes, then draft rejected as deadlock
    {
      const sessionId = await createCaseWithIntake(
        gateway,
        {
          facts: 'Накопилось раздражение из-за тона общения',
          tension: 'Напрягают резкие формулировки',
          interest: 'Важно сохранять уважение',
          constraint: 'Не подойдут обвинения при обсуждении',
          outcome: 'Понятный формат диалога без эскалации',
          flexibility: 'Готов обсуждать правила обратной связи'
        },
        {
          facts: 'Часто разговоры заканчиваются взаимными упрёками',
          tension: 'Напрягает, что каждый спор превращается в конфликт',
          interest: 'Важно быть услышанной',
          constraint: 'Не подойдёт давление и перебивания',
          outcome: 'Спокойные обсуждения и понятные правила',
          flexibility: 'Готова менять тон и время разговора'
        }
      );
      await gateway.buildProblemSynthesis(ctx('problem_synthesis', sessionId, '101', {}), sessionId, '101');
      await gateway.recordProblemSynthesisReaction(
        ctx('synthesis_react', sessionId, '101', {}),
        sessionId,
        '101',
        'confirm'
      );
      await gateway.recordProblemSynthesisReaction(
        ctx('synthesis_react', sessionId, '102', {}),
        sessionId,
        '102',
        'confirm'
      );
      const loop = await gateway.generateIssueResolutionLoop(
        ctx('issue_loop_generate', sessionId, '101', {}),
        sessionId,
        '101'
      );
      await gateway.submitIssueOptionReaction(ctx('issue_react', sessionId, '101', {}), {
        session_id: sessionId,
        telegram_user_id: '101',
        loop_version: loop.loop_version,
        option_id: loop.options[0].option_id,
        reaction_type: IssueReactionTypes.ACCEPT
      });
      await gateway.submitIssueOptionReaction(ctx('issue_react', sessionId, '102', {}), {
        session_id: sessionId,
        telegram_user_id: '102',
        loop_version: loop.loop_version,
        option_id: loop.options[0].option_id,
        reaction_type: IssueReactionTypes.ACCEPT
      });
      const draft = await gateway.generateDraftAgreement(
        ctx('draft_generate', sessionId, '101', {}),
        sessionId,
        '101'
      );
      await gateway.submitDraftAgreementResponse(ctx('draft_response', sessionId, '101', {}), {
        session_id: sessionId,
        telegram_user_id: '101',
        draft_version: draft.draft_version,
        response_type: DraftAgreementResponseTypes.REJECT
      });
      await gateway.submitDraftAgreementResponse(ctx('draft_response', sessionId, '102', {}), {
        session_id: sessionId,
        telegram_user_id: '102',
        draft_version: draft.draft_version,
        response_type: DraftAgreementResponseTypes.REJECT
      });
      await gateway.getSessionFullExport(sessionId, '101');
    }

    // 4) no-obvious-solution conflict: both reject all options
    {
      const sessionId = await createCaseWithIntake(
        gateway,
        {
          facts: 'Конфликт о переезде в другой город',
          tension: 'Напрягает риск потерять текущую работу',
          interest: 'Важно сохранить доход и стабильность',
          constraint: 'Точно не подходит срочный переезд',
          outcome: 'Оставаться в текущем городе минимум год',
          flexibility: 'Готов обсуждать короткие поездки'
        },
        {
          facts: 'Конфликт о переезде в другой город',
          tension: 'Напрягает ощущение, что развитие откладывается',
          interest: 'Важно переехать в этом сезоне',
          constraint: 'Не подойдёт оставаться в текущем городе ещё год',
          outcome: 'Переезд в ближайшие месяцы',
          flexibility: 'Готова обсуждать поэтапный переезд до трёх месяцев'
        }
      );
      await gateway.buildProblemSynthesis(ctx('problem_synthesis', sessionId, '101', {}), sessionId, '101');
      await gateway.recordProblemSynthesisReaction(
        ctx('synthesis_react', sessionId, '101', {}),
        sessionId,
        '101',
        'clarify'
      );
      await gateway.recordProblemSynthesisReaction(
        ctx('synthesis_react', sessionId, '102', {}),
        sessionId,
        '102',
        'clarify'
      );
      const loop = await gateway.generateIssueResolutionLoop(
        ctx('issue_loop_generate', sessionId, '101', {}),
        sessionId,
        '101'
      );
      for (const option of loop.options) {
        await gateway.submitIssueOptionReaction(ctx('issue_react', sessionId, '101', { option: option.option_id }), {
          session_id: sessionId,
          telegram_user_id: '101',
          loop_version: loop.loop_version,
          option_id: option.option_id,
          reaction_type: IssueReactionTypes.REJECT
        });
        await gateway.submitIssueOptionReaction(ctx('issue_react', sessionId, '102', { option: option.option_id }), {
          session_id: sessionId,
          telegram_user_id: '102',
          loop_version: loop.loop_version,
          option_id: option.option_id,
          reaction_type: IssueReactionTypes.REJECT
        });
      }
      const exported = await gateway.getSessionFullExport(sessionId, '101');
      expect(exported.evaluation.quality_flags).toContain('full_option_rejection');
    }

    const report = await gateway.getDogfoodReport();
    expect(report.sessions_count).toBe(4);
    expect(report.synthesis_both_confirmed_pct).toBeGreaterThanOrEqual(25);
    expect(report.workable_path_found_pct).toBeGreaterThan(0);
    expect(report.agreement_pct + report.deadlock_pct).toBeLessThanOrEqual(100);
    expect(report.top_failure_patterns.length).toBeGreaterThan(0);
  });

  it('exposes full export and report via HTTP adapter', async () => {
    const { gateway } = setup();
    const sessionId = await createCaseWithIntake(
      gateway,
      {
        facts: 'Спор по быту',
        tension: 'Неясные правила',
        interest: 'Предсказуемость',
        constraint: 'Без внезапных изменений',
        outcome: 'Понятные договорённости',
        flexibility: 'Можно обсуждать обмен слотами'
      },
      {
        facts: 'Спор по быту',
        tension: 'Не хватает прозрачности',
        interest: 'Ясные рамки',
        constraint: 'Без хаотичных изменений',
        outcome: 'Прозрачные шаги',
        flexibility: 'Готова обсуждать пересмотр раз в неделю'
      }
    );
    await gateway.buildProblemSynthesis(ctx('problem_synthesis', sessionId, '101', {}), sessionId, '101');
    await gateway.recordProblemSynthesisReaction(
      ctx('synthesis_react', sessionId, '101', {}),
      sessionId,
      '101',
      'confirm'
    );
    await gateway.recordProblemSynthesisReaction(
      ctx('synthesis_react', sessionId, '102', {}),
      sessionId,
      '102',
      'confirm'
    );

    const app = buildHttpServer(gateway);

    const exported = await app.inject({
      method: 'GET',
      url: `/sessions/${sessionId}/full-export?telegramUserId=101`
    });
    expect(exported.statusCode).toBe(200);
    const payload = exported.json();
    expect(payload.session_id).toBe(sessionId);
    expect(payload.intake.party_a.normalized_fields).toBeTypeOf('object');
    expect(payload.evaluation.synthesis_confirmed).toBe(true);

    const report = await app.inject({
      method: 'GET',
      url: '/dogfood/report'
    });
    expect(report.statusCode).toBe(200);
    expect(report.json().sessions_count).toBeGreaterThanOrEqual(1);
  });
});
