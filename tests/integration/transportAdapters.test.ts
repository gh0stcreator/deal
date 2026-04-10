import { describe, expect, it } from 'vitest';
import { Bot } from 'grammy';
import { Clock } from '../../src/application/ports/Clock.js';
import { DeterministicIntakeNormalizer } from '../../src/application/ports/IntakeNormalizer.js';
import { IdGenerator } from '../../src/application/ports/IdGenerator.js';
import { IntakeService } from '../../src/application/services/IntakeService.js';
import { MediationService } from '../../src/application/services/MediationService.js';
import { NegotiationService } from '../../src/application/services/NegotiationService.js';
import { ProtocolGatewayService } from '../../src/application/services/ProtocolGatewayService.js';
import { DeterministicProposalMapper } from '../../src/application/services/DeterministicProposalMapper.js';
import { ProposalGenerationService } from '../../src/application/services/ProposalGenerationService.js';
import { DeterministicSynthesisMapper } from '../../src/application/services/DeterministicSynthesisMapper.js';
import { SynthesisService } from '../../src/application/services/SynthesisService.js';
import { SessionStates } from '../../src/domain/session/types.js';
import { buildHttpServer } from '../../src/infrastructure/http/server.js';
import { InMemoryIntakeRepository } from '../../src/infrastructure/repositories/InMemoryIntakeRepository.js';
import { InMemoryMediationSummaryRepository } from '../../src/infrastructure/repositories/InMemoryMediationSummaryRepository.js';
import { InMemoryNegotiationRoundRepository } from '../../src/infrastructure/repositories/InMemoryNegotiationRoundRepository.js';
import { InMemoryProposalSetRepository } from '../../src/infrastructure/repositories/InMemoryProposalSetRepository.js';
import { InMemoryProtocolTrackingRepository } from '../../src/infrastructure/repositories/InMemoryProtocolTrackingRepository.js';
import { InMemorySessionRepository } from '../../src/infrastructure/repositories/InMemorySessionRepository.js';
import { buildTelegramBot } from '../../src/infrastructure/telegram/bot.js';
import { InMemoryRateLimiter } from '../../src/infrastructure/transport/rateLimiter.js';

class MutableClock implements Clock {
  constructor(private value: Date) {}

  now(): Date {
    return this.value;
  }

  advanceMs(delta: number): void {
    this.value = new Date(this.value.getTime() + delta);
  }
}

class SequentialIdGenerator implements IdGenerator {
  private value = 0;

  nextId(): string {
    this.value += 1;
    return `id-${this.value}`;
  }
}

const intakeAnswers = {
  facts: 'timeline and payment facts',
  interpretations: 'different interpretation of missed milestones',
  interests: 'predictability and communication quality',
  constraints: 'time schedule and budget constraints',
  boundaries: 'respectful tone and no threats',
  desired_outcome: 'predictable schedule and clear ownership',
  acceptable_concessions: 'can adjust timeline and milestone size',
  non_negotiables: 'no legal escalation'
} as const;

const completeIntake = async (
  intakeService: IntakeService,
  sessionId: string,
  telegramUserId: string
) => {
  let view = await intakeService.startOrResume(sessionId, telegramUserId);

  for (const field of Object.keys(intakeAnswers) as Array<keyof typeof intakeAnswers>) {
    view = await intakeService.submitFieldAnswer({
      sessionId,
      telegramUserId,
      field,
      rawValue: intakeAnswers[field],
      expectedVersion: view.version
    });
  }

  if (!view.generatedSummary) {
    throw new Error('Expected summary');
  }

  await intakeService.confirmSummary({
    sessionId,
    telegramUserId,
    summary: view.generatedSummary,
    expectedVersion: view.version
  });
};

const setupTransport = async (options?: {
  sendMessageBehavior?: (input: {
    method: string;
    payload: unknown;
    attempt: number;
  }) => { failWith?: Error } | void;
}) => {
  const clock = new MutableClock(new Date('2026-01-12T00:00:00.000Z'));
  const ids = new SequentialIdGenerator();

  const sessionRepo = new InMemorySessionRepository();
  const intakeRepo = new InMemoryIntakeRepository();
  const summaryRepo = new InMemoryMediationSummaryRepository();
  const proposalSetRepo = new InMemoryProposalSetRepository();
  const negotiationRoundRepo = new InMemoryNegotiationRoundRepository();
  const trackingRepo = new InMemoryProtocolTrackingRepository();

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
    negotiationRoundRepo,
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
    clock
  );

  const created = await mediationService.createSession('101');
  const joined = await mediationService.joinSessionByInviteToken(created.inviteToken, '102');
  await mediationService.grantConsent(joined.id, '101');
  await mediationService.grantConsent(joined.id, '102');
  await completeIntake(intakeService, joined.id, '101');
  await completeIntake(intakeService, joined.id, '102');
  await synthesisService.synthesizeCase(joined.id);
  await proposalService.generateLatest(joined.id);

  const sharedLimiter = new InMemoryRateLimiter(clock);
  const bot = buildTelegramBot('test-token', gateway, {
    rate_limiter: sharedLimiter,
    max_send_attempts: 3,
    base_backoff_ms: 1,
    sleep: async () => undefined
  });
  (bot as Bot).botInfo = {
    id: 1,
    is_bot: true,
    first_name: 'Ladno',
    username: 'ladno_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false
  };

  const replies: string[] = [];
  const sentPayloads: Array<{ text: string; reply_markup?: unknown }> = [];
  let sendAttempt = 0;
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === 'sendMessage') {
      sendAttempt += 1;
      const behavior = options?.sendMessageBehavior?.({
        method,
        payload,
        attempt: sendAttempt
      });
      if (behavior?.failWith) {
        throw behavior.failWith;
      }

      const text = (payload as { text?: string }).text ?? '';
      replies.push(text);
      sentPayloads.push({
        text,
        reply_markup: (payload as { reply_markup?: unknown }).reply_markup
      });
      return {
        ok: true,
        result: {
          message_id: replies.length,
          date: 0,
          chat: { id: (payload as { chat_id: number }).chat_id, type: 'private' },
          text
        }
      } as never;
    }

    return prev(method, payload, signal);
  });

  const app = buildHttpServer(gateway, {
    rate_limiter: sharedLimiter,
    clock
  });

  return {
    sessionId: joined.id,
    gateway,
    trackingRepo,
    sessionRepo,
    clock,
    app,
    bot,
    replies,
    sentPayloads,
    negotiationService,
    getSendAttemptCount: () => sendAttempt
  };
};

const setupConsentPendingTransport = async () => {
  const clock = new MutableClock(new Date('2026-01-12T00:00:00.000Z'));
  const ids = new SequentialIdGenerator();
  const sessionRepo = new InMemorySessionRepository();
  const intakeRepo = new InMemoryIntakeRepository();
  const summaryRepo = new InMemoryMediationSummaryRepository();
  const proposalSetRepo = new InMemoryProposalSetRepository();
  const negotiationRoundRepo = new InMemoryNegotiationRoundRepository();
  const trackingRepo = new InMemoryProtocolTrackingRepository();

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
    negotiationRoundRepo,
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
    clock
  );

  const created = await mediationService.createSession('101');
  const joined = await mediationService.joinSessionByInviteToken(created.inviteToken, '102');
  const app = buildHttpServer(gateway, {
    rate_limiter: new InMemoryRateLimiter(clock),
    clock
  });

  return { sessionId: joined.id, app, gateway };
};

const sendTelegramCommand = async (
  bot: Bot,
  updateId: number,
  userId: number,
  text: string
) => {
  const command = text.split(/\s+/)[0] ?? '/';
  await bot.handleUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      text,
      entities: [
        {
          offset: 0,
          length: command.length,
          type: 'bot_command'
        }
      ],
      from: {
        id: userId,
        is_bot: false,
        first_name: 'user'
      },
      chat: {
        id: userId,
        type: 'private'
      }
    }
  } as never);
};

const sendTelegramText = async (
  bot: Bot,
  updateId: number,
  userId: number,
  text: string
) => {
  await bot.handleUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      text,
      from: {
        id: userId,
        is_bot: false,
        first_name: 'user'
      },
      chat: {
        id: userId,
        type: 'private'
      }
    }
  } as never);
};

const sendTelegramCallback = async (
  bot: Bot,
  updateId: number,
  userId: number,
  data: string
) => {
  await bot.handleUpdate({
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: {
        id: userId,
        is_bot: false,
        first_name: 'user'
      },
      chat_instance: `chat-${userId}`,
      data,
      message: {
        message_id: updateId,
        date: 0,
        chat: {
          id: userId,
          type: 'private'
        }
      }
    }
  } as never);
};

describe('transport adapters', () => {
  it('shows guided start menu with actions instead of raw command list', async () => {
    const setup = await setupTransport();

    await sendTelegramCommand(setup.bot, 50, 101, '/start');

    const last = setup.sentPayloads[setup.sentPayloads.length - 1];
    expect(last.text).toContain('Что хочешь сделать?');
    expect(last.reply_markup).toBeTruthy();
  });

  it('supports create -> deep-link join -> consent flow via UX buttons and start payload', async () => {
    const clock = new MutableClock(new Date('2026-01-12T00:00:00.000Z'));
    const ids = new SequentialIdGenerator();

    const sessionRepo = new InMemorySessionRepository();
    const intakeRepo = new InMemoryIntakeRepository();
    const summaryRepo = new InMemoryMediationSummaryRepository();
    const proposalSetRepo = new InMemoryProposalSetRepository();
    const negotiationRoundRepo = new InMemoryNegotiationRoundRepository();
    const trackingRepo = new InMemoryProtocolTrackingRepository();

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
      negotiationRoundRepo,
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
      clock
    );

    const bot = buildTelegramBot('test-token', gateway, {
      rate_limiter: new InMemoryRateLimiter(clock),
      max_send_attempts: 3,
      base_backoff_ms: 1,
      sleep: async () => undefined
    });
    (bot as Bot).botInfo = {
      id: 1,
      is_bot: true,
      first_name: 'Ladno',
      username: 'ladno_bot',
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false
    };

    const replies: string[] = [];
    const sentPayloads: Array<{ text: string; reply_markup?: unknown }> = [];
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (method === 'sendMessage') {
        const text = (payload as { text?: string }).text ?? '';
        replies.push(text);
        sentPayloads.push({
          text,
          reply_markup: (payload as { reply_markup?: unknown }).reply_markup
        });
        return {
          ok: true,
          result: {
            message_id: replies.length,
            date: 0,
            chat: { id: (payload as { chat_id: number }).chat_id, type: 'private' },
            text: (payload as { text?: string }).text ?? ''
          }
        } as never;
      }
      return prev(method, payload, signal);
    });

    await sendTelegramCallback(bot, 60, 101, 'menu:create');
    const creatorReply = replies[replies.length - 1];
    expect(creatorReply).toContain('Договорённость создана');
    const inviteToken = creatorReply.match(/Если ссылка не сработает, отправь этот токен:\n([A-Za-z0-9_-]+)/)?.[1];
    expect(inviteToken).toBeTruthy();
    const session = await sessionRepo.findByInviteTokenHash(mediationService.hashInviteToken(inviteToken!));
    const sessionId = session?.id;
    expect(sessionId).toBeTruthy();

    await sendTelegramCommand(bot, 61, 102, `/start join_${inviteToken}`);
    expect(replies[replies.length - 1]).toContain('Ты подключился к договорённости');

    await sendTelegramCallback(bot, 62, 101, `consent:${sessionId}`);
    expect(replies[replies.length - 1]).toContain('Ты подтвердил участие');

    await sendTelegramCallback(bot, 63, 102, `consent:${sessionId}`);
    expect(replies.some((entry) => entry.includes('Готово. Вы оба подтвердили участие'))).toBe(true);
    expect(replies[replies.length - 1]).toContain('С чем хотите договориться? Опиши коротко');

    await sendTelegramText(bot, 64, 101, 'Хотим договориться о сроках и оплате');
    expect(replies[replies.length - 1]).toContain('Я записал это так:');
    expect(replies[replies.length - 1]).toContain('Всё верно?');

    await sendTelegramCallback(bot, 65, 101, `problem:edit:${sessionId}`);
    expect(replies[replies.length - 1]).toContain('Отправь исправленный вариант.');
    await sendTelegramText(bot, 66, 101, 'Хотим договориться о дедлайнах и оплате');
    expect(replies[replies.length - 1]).toContain('Я записал это так:');
    await sendTelegramCallback(bot, 67, 101, `problem:confirm:${sessionId}`);
    expect(replies[replies.length - 1]).toContain('Ты подтвердил свою формулировку.');
    expect(replies[replies.length - 1]).toContain('Ждём второго человека.');

    await sendTelegramText(bot, 68, 102, 'Нужно договориться о формате и дедлайнах');
    expect(replies[replies.length - 1]).toContain('Я записал это так:');
    await sendTelegramCallback(bot, 69, 102, `problem:confirm:${sessionId}`);
    expect(replies.filter((entry) => entry.includes('Похоже, вы хотите договориться вот о чём:')).length).toBeGreaterThanOrEqual(2);
    expect(replies.filter((entry) => entry.includes('Общее между вашими позициями:')).length).toBeGreaterThanOrEqual(2);
    expect(replies.filter((entry) => entry.includes('Где пока есть расхождение:')).length).toBeGreaterThanOrEqual(2);
    const lastPayload = sentPayloads[sentPayloads.length - 1];
    expect(lastPayload.reply_markup).toBeTruthy();

    const partyAData = await intakeService.getPrivateIntakeData(sessionId!, '101');
    const partyBData = await intakeService.getPrivateIntakeData(sessionId!, '102');
    expect(partyAData.view.fields.facts.rawValue).toContain('дедлайнах и оплате');
    expect(partyBData.view.fields.facts.rawValue).toContain('формате и дедлайнах');
    expect(partyAData.view.fields.facts.rawValue).not.toBe(partyBData.view.fields.facts.rawValue);

    await sendTelegramCallback(bot, 70, 101, `synthesis:clarify:${sessionId}`);
    expect(replies[replies.length - 1]).toContain('Что именно я понял не так?');
    await sendTelegramText(bot, 71, 101, 'Нужно добавить, что важен способ коммуникации');
    expect(replies[replies.length - 1]).toContain('Принял уточнение. Сохранил отдельно.');

    const partyADataAfterClarification = await intakeService.getPrivateIntakeData(sessionId!, '101');
    const partyBDataAfterClarification = await intakeService.getPrivateIntakeData(sessionId!, '102');
    expect(
      partyADataAfterClarification.rawMessages.some((entry) =>
        entry.content.includes('[problem_synthesis_clarification]')
      )
    ).toBe(true);
    expect(
      partyBDataAfterClarification.rawMessages.some((entry) =>
        entry.content.includes('[problem_synthesis_clarification]')
      )
    ).toBe(false);

    const finalSession = await gateway.getSessionStatus(sessionId!, '101');
    expect(finalSession.state).toBe(SessionStates.SIDE_A_INTAKE);
  });

  it('supports guided join via menu and plain token message', async () => {
    const clock = new MutableClock(new Date('2026-01-12T00:00:00.000Z'));
    const ids = new SequentialIdGenerator();
    const sessionRepo = new InMemorySessionRepository();
    const intakeRepo = new InMemoryIntakeRepository();
    const summaryRepo = new InMemoryMediationSummaryRepository();
    const proposalSetRepo = new InMemoryProposalSetRepository();
    const negotiationRoundRepo = new InMemoryNegotiationRoundRepository();
    const trackingRepo = new InMemoryProtocolTrackingRepository();

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
      negotiationRoundRepo,
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
      clock
    );

    const created = await mediationService.createSession('101');

    const bot = buildTelegramBot('test-token', gateway, {
      rate_limiter: new InMemoryRateLimiter(clock),
      max_send_attempts: 3,
      base_backoff_ms: 1,
      sleep: async () => undefined
    });
    (bot as Bot).botInfo = {
      id: 1,
      is_bot: true,
      first_name: 'Ladno',
      username: 'ladno_bot',
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false
    };

    const replies: string[] = [];
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (method === 'sendMessage') {
        replies.push((payload as { text?: string }).text ?? '');
        return {
          ok: true,
          result: {
            message_id: replies.length,
            date: 0,
            chat: { id: (payload as { chat_id: number }).chat_id, type: 'private' },
            text: (payload as { text?: string }).text ?? ''
          }
        } as never;
      }
      return prev(method, payload, signal);
    });

    await sendTelegramCallback(bot, 70, 102, 'menu:join');
    expect(replies[replies.length - 1]).toContain('Отправь ссылку-приглашение или токен');

    await sendTelegramText(bot, 71, 102, created.inviteToken);
    expect(replies[replies.length - 1]).toContain('Ты подключился к договорённости');
  });

  it('deduplicates repeated Telegram delivery by update_id idempotency key', async () => {
    const setup = await setupTransport();

    await sendTelegramCommand(setup.bot, 100, 101, `/select_preferred ${setup.sessionId} BALANCED`);
    await sendTelegramCommand(setup.bot, 100, 101, `/select_preferred ${setup.sessionId} BALANCED`);

    const view = await setup.gateway.getNegotiationStatus(setup.sessionId, '101');
    expect(view.current_round_number).toBe(1);

    const events = await setup.trackingRepo.listProtocolEvents(setup.sessionId);
    const selected = events.filter((event) => event.action_type === 'select_preferred');
    expect(selected.some((event) => event.outcome === 'ACCEPTED')).toBe(true);
    expect(selected.some((event) => event.outcome === 'NO_OP')).toBe(true);
  });

  it('deduplicates rapid retries with different update ids via fingerprint window', async () => {
    const setup = await setupTransport();

    await sendTelegramCommand(setup.bot, 200, 101, `/select_preferred ${setup.sessionId} BALANCED`);
    await sendTelegramCommand(setup.bot, 201, 101, `/select_preferred ${setup.sessionId} BALANCED`);

    const events = await setup.trackingRepo.listProtocolEvents(setup.sessionId);
    const selected = events.filter((event) => event.action_type === 'select_preferred');
    const accepted = selected.filter((event) => event.outcome === 'ACCEPTED');
    expect(accepted).toHaveLength(1);
  });

  it('rejects unauthorized participant actions in both telegram and http', async () => {
    const setup = await setupTransport();

    await sendTelegramCommand(setup.bot, 300, 999, `/select_preferred ${setup.sessionId} BALANCED`);
    const telegramLast = setup.replies[setup.replies.length - 1];
    expect(telegramLast.toLowerCase()).toContain('ты не можешь сделать это сейчас');

    const http = await setup.app.inject({
      method: 'POST',
      url: `/sessions/${setup.sessionId}/negotiation/select-preferred`,
      payload: {
        telegramUserId: 'user-x',
        variantType: 'BALANCED'
      }
    });

    expect(http.statusCode).toBe(403);
    expect(http.json().code).toBe('TRANSPORT_ACCESS_DENIED');
  });

  it('maps invalid state action errors deterministically', async () => {
    const setup = await setupTransport();

    await sendTelegramCommand(setup.bot, 400, 101, `/confirm_summary ${setup.sessionId}`);
    const telegramLast = setup.replies[setup.replies.length - 1];
    expect(telegramLast.toLowerCase()).toContain('ты не можешь сделать это сейчас');

    const http = await setup.app.inject({
      method: 'POST',
      url: `/sessions/${setup.sessionId}/intake/confirm-summary`,
      payload: { telegramUserId: '101' }
    });

    expect(http.statusCode).toBe(409);
  });

  it('creates audit/protocol events for transport-triggered actions', async () => {
    const setup = await setupTransport();

    await setup.app.inject({
      method: 'POST',
      url: `/sessions/${setup.sessionId}/negotiation/select-preferred`,
      headers: { 'x-idempotency-key': 'x-1' },
      payload: {
        telegramUserId: '101',
        variantType: 'BALANCED'
      }
    });

    const events = await setup.trackingRepo.listProtocolEvents(setup.sessionId);
    const last = events[events.length - 1];
    expect(last.action_type).toBe('select_preferred');
    expect(last.idempotency_key).toContain('x-1');
    expect(last.outcome).toBe('ACCEPTED');
  });

  it('does not leak private intake artifacts in telegram rendered views', async () => {
    const setup = await setupTransport();

    await sendTelegramCommand(setup.bot, 500, 101, `/generate_proposals ${setup.sessionId}`);

    const telegramLast = setup.replies[setup.replies.length - 1];
    expect(telegramLast).not.toContain('timeline and payment facts');
    expect(telegramLast).not.toContain('different interpretation of missed milestones');
  });

  it('wires handlers to services correctly for resume_intake command', async () => {
    const clock = new MutableClock(new Date('2026-01-12T00:00:00.000Z'));
    const ids = new SequentialIdGenerator();
    const sessionRepo = new InMemorySessionRepository();
    const intakeRepo = new InMemoryIntakeRepository();
    const summaryRepo = new InMemoryMediationSummaryRepository();
    const proposalSetRepo = new InMemoryProposalSetRepository();
    const negotiationRoundRepo = new InMemoryNegotiationRoundRepository();
    const trackingRepo = new InMemoryProtocolTrackingRepository();

    const mediation = new MediationService(sessionRepo, clock, ids);
    const intake = new IntakeService(
      sessionRepo,
      intakeRepo,
      new DeterministicIntakeNormalizer(),
      ids,
      clock
    );
    const gateway = new ProtocolGatewayService(
      mediation,
      intake,
      new SynthesisService(
        sessionRepo,
        intakeRepo,
        summaryRepo,
        new DeterministicSynthesisMapper(),
        ids,
        clock
      ),
      new ProposalGenerationService(
        sessionRepo,
        summaryRepo,
        proposalSetRepo,
        new DeterministicProposalMapper(),
        ids,
        clock
      ),
      new NegotiationService(sessionRepo, proposalSetRepo, negotiationRoundRepo, ids, clock),
      sessionRepo,
      proposalSetRepo,
      trackingRepo,
      ids,
      clock
    );

    const created = await mediation.createSession('101');
    const joined = await mediation.joinSessionByInviteToken(created.inviteToken, '102');
    await mediation.grantConsent(joined.id, '101');
    await mediation.grantConsent(joined.id, '102');

    const bot = buildTelegramBot('test-token', gateway);
    (bot as Bot).botInfo = {
      id: 1,
      is_bot: true,
      first_name: 'Ladno',
      username: 'ladno_bot',
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false
    };

    const replies: string[] = [];
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (method === 'sendMessage') {
        replies.push((payload as { text?: string }).text ?? '');
        return {
          ok: true,
          result: {
            message_id: replies.length,
            date: 0,
            chat: { id: (payload as { chat_id: number }).chat_id, type: 'private' },
            text: (payload as { text?: string }).text ?? ''
          }
        } as never;
      }
      return prev(method, payload, signal);
    });

    await sendTelegramCommand(bot, 700, 101, `/resume_intake ${joined.id}`);
    expect(replies[replies.length - 1]).toContain('state: IN_PROGRESS');
  });

  it('has HTTP/Telegram parity for select_preferred protocol action', async () => {
    const setupHttp = await setupTransport();
    const setupTg = await setupTransport();

    const httpResp = await setupHttp.app.inject({
      method: 'POST',
      url: `/sessions/${setupHttp.sessionId}/negotiation/select-preferred`,
      payload: {
        telegramUserId: '101',
        variantType: 'BALANCED'
      }
    });

    expect(httpResp.statusCode).toBe(200);
    const httpView = await setupHttp.gateway.getNegotiationStatus(setupHttp.sessionId, '101');

    await sendTelegramCommand(setupTg.bot, 800, 101, `/select_preferred ${setupTg.sessionId} BALANCED`);
    const tgView = await setupTg.gateway.getNegotiationStatus(setupTg.sessionId, '101');

    expect(httpView.current_round_number).toBe(tgView.current_round_number);
    expect(httpView.session_state).toBe(tgView.session_state);
    expect(httpView.proposal_set.version).toBe(tgView.proposal_set.version);
    expect(httpView.round_status).toBe(tgView.round_status);
  });

  it('marks abandoned and exposes terminal outcome view via http', async () => {
    const setup = await setupTransport();
    setup.clock.advanceMs(1000 * 60 * 60 * 25);
    await setup.negotiationService.markAbandonedByInactivity(setup.sessionId, 1000 * 60 * 60 * 24);

    const response = await setup.app.inject({
      method: 'GET',
      url: `/sessions/${setup.sessionId}/outcome?telegramUserId=101`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe(SessionStates.ABANDONED);
  });

  it('handles concurrent Telegram duplicate delivery safely', async () => {
    const setup = await setupTransport();

    await Promise.all([
      sendTelegramCommand(setup.bot, 900, 101, `/select_preferred ${setup.sessionId} BALANCED`),
      sendTelegramCommand(setup.bot, 900, 101, `/select_preferred ${setup.sessionId} BALANCED`)
    ]);

    const view = await setup.gateway.getNegotiationStatus(setup.sessionId, '101');
    expect(view.current_round_number).toBe(1);
  });

  it('keeps protocol mutation single-shot for concurrent same idempotency key HTTP actions', async () => {
    const setup = await setupTransport();

    const [a, b] = await Promise.all([
      setup.app.inject({
        method: 'POST',
        url: `/sessions/${setup.sessionId}/negotiation/select-preferred`,
        headers: { 'x-idempotency-key': 'same-key' },
        payload: { telegramUserId: '101', variantType: 'BALANCED' }
      }),
      setup.app.inject({
        method: 'POST',
        url: `/sessions/${setup.sessionId}/negotiation/select-preferred`,
        headers: { 'x-idempotency-key': 'same-key' },
        payload: { telegramUserId: '101', variantType: 'BALANCED' }
      })
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 200]);

    const events = await setup.trackingRepo.listProtocolEvents(setup.sessionId);
    const selected = events.filter((event) => event.action_type === 'select_preferred');
    expect(selected.some((event) => event.outcome === 'ACCEPTED')).toBe(true);
    expect(selected.some((event) => event.outcome === 'NO_OP')).toBe(true);
  });

  it('recovers when telegram outbound delivery fails after protocol success', async () => {
    let failOutbound = true;
    const setup = await setupTransport({
      sendMessageBehavior: () => (failOutbound ? { failWith: new Error('transient send error') } : undefined)
    });

    await sendTelegramCommand(setup.bot, 950, 101, `/select_preferred ${setup.sessionId} BALANCED`);
    const afterFailedDelivery = await setup.gateway.getNegotiationStatus(setup.sessionId, '101');
    expect(afterFailedDelivery.current_round_number).toBe(1);

    failOutbound = false;
    await sendTelegramCommand(setup.bot, 950, 101, `/select_preferred ${setup.sessionId} BALANCED`);
    const afterReplay = await setup.gateway.getNegotiationStatus(setup.sessionId, '101');
    expect(afterReplay.current_round_number).toBe(1);
    expect(setup.getSendAttemptCount()).toBeGreaterThan(1);
  });

  it('rate-limits repeated invalid join attempts over HTTP', async () => {
    const setup = await setupTransport();
    let rateLimitedSeen = false;

    for (let i = 0; i < 12; i += 1) {
      const response = await setup.app.inject({
        method: 'POST',
        url: '/sessions/join',
        payload: { telegramUserId: '999', inviteToken: `invalid-token-${i}` }
      });
      if (response.statusCode === 429) {
        rateLimitedSeen = true;
        break;
      }
    }

    expect(rateLimitedSeen).toBe(true);
  });

  it('rate-limits repeated invalid commands over Telegram', async () => {
    const setup = await setupTransport();
    for (let i = 0; i < 12; i += 1) {
      await sendTelegramCommand(setup.bot, 1000 + i, 101, '/unknowncmd');
    }
    expect(setup.replies[setup.replies.length - 1].toLowerCase()).toContain('слишком много запросов');
  });

  it('applies correlation ids to HTTP responses and persisted action keys', async () => {
    const setup = await setupTransport();
    const response = await setup.app.inject({
      method: 'POST',
      url: `/sessions/${setup.sessionId}/negotiation/select-preferred`,
      headers: {
        'x-correlation-id': 'corr-42',
        'x-idempotency-key': 'idemp-42'
      },
      payload: { telegramUserId: '101', variantType: 'BALANCED' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-correlation-id']).toBe('corr-42');
    const events = await setup.trackingRepo.listProtocolEvents(setup.sessionId);
    const target = events.find((event) => event.action_type === 'select_preferred');
    expect(target?.idempotency_key).toContain('corr-42');
  });

  it('returns stale/conflict response when same participant submits concurrent negotiation edits', async () => {
    const setup = await setupTransport();
    const proposalView = await setup.app.inject({
      method: 'GET',
      url: `/sessions/${setup.sessionId}/proposals?telegramUserId=101&variantType=BALANCED`
    });
    expect(proposalView.statusCode).toBe(200);
    const clauseId = proposalView.json().clauses[0].clause_id as string;

    const [a, b] = await Promise.all([
      setup.app.inject({
        method: 'POST',
        url: `/sessions/${setup.sessionId}/negotiation/suggest-edit`,
        headers: { 'x-idempotency-key': 'edit-a' },
        payload: {
          telegramUserId: '101',
          variantType: 'BALANCED',
          clauseId,
          operation: 'MODIFY_CLAUSE_TEXT',
          proposedValue: 'change A'
        }
      }),
      setup.app.inject({
        method: 'POST',
        url: `/sessions/${setup.sessionId}/negotiation/suggest-edit`,
        headers: { 'x-idempotency-key': 'edit-b' },
        payload: {
          telegramUserId: '101',
          variantType: 'BALANCED',
          clauseId,
          operation: 'MODIFY_CLAUSE_TEXT',
          proposedValue: 'change B'
        }
      })
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });

  it('finalizes one negotiation round when participants submit simultaneously', async () => {
    const setup = await setupTransport();
    const [a, b] = await Promise.all([
      setup.app.inject({
        method: 'POST',
        url: `/sessions/${setup.sessionId}/negotiation/accept`,
        payload: { telegramUserId: '101', variantType: 'BALANCED' }
      }),
      setup.app.inject({
        method: 'POST',
        url: `/sessions/${setup.sessionId}/negotiation/accept`,
        payload: { telegramUserId: '102', variantType: 'BALANCED' }
      })
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    const view = await setup.gateway.getNegotiationStatus(setup.sessionId, '101');
    expect(view.session_state).toBe('AGREEMENT_REACHED');
  });

  it('handles concurrent session transition attempts deterministically', async () => {
    const setup = await setupConsentPendingTransport();
    const [a, b] = await Promise.all([
      setup.app.inject({
        method: 'POST',
        url: `/sessions/${setup.sessionId}/consent`,
        payload: { telegramUserId: '101' }
      }),
      setup.app.inject({
        method: 'POST',
        url: `/sessions/${setup.sessionId}/consent`,
        payload: { telegramUserId: '101' }
      })
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 200]);
    const session = await setup.gateway.getSessionStatus(setup.sessionId, '101');
    expect(session.state).toBe('CONSENT_PENDING');
    expect(session.participants.filter((participant) => participant.consentGrantedAt).length).toBe(1);
  });
});
