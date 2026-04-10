import { Bot, Context, InlineKeyboard } from 'grammy';
import { SystemClock } from '../../application/ports/Clock.js';
import { AppLogger, createNoopLogger } from '../../application/ports/AppLogger.js';
import {
  ProblemSynthesisView,
  ProtocolGatewayService
} from '../../application/services/ProtocolGatewayService.js';
import { SuggestEditOperations } from '../../domain/negotiation/types.js';
import { ProposalVariantTypes } from '../../domain/proposal/types.js';
import { SessionStates } from '../../domain/session/types.js';
import { DomainError } from '../../domain/session/errors.js';
import { mapTelegramErrorText } from '../transport/errorMapping.js';
import { InMemoryRateLimiter } from '../transport/rateLimiter.js';
import {
  mapIntakeStatusView,
  mapNegotiationRoundStatusView,
  mapProposalListView
} from '../transport/viewMappers.js';

const RATE_LIMIT_WINDOW_MS = 60_000;
const GENERAL_ACTION_LIMIT = 30;
const JOIN_ATTEMPT_LIMIT = 8;
const INVALID_COMMAND_LIMIT = 10;

type PendingInputKind = 'JOIN_TOKEN' | 'CREATE_TOPIC';

const parseArgs = (text: string | undefined): string[] => {
  if (!text) {
    return [];
  }

  const parts = text.trim().split(/\s+/g);
  return parts.slice(1);
};

const userIdFromCtx = (ctx: Context): string => String(ctx.from?.id ?? 'unknown');

const makeCorrelationId = (ctx: Context): string =>
  `tg:${ctx.update.update_id}:${userIdFromCtx(ctx)}`;

const makeKey = (ctx: Context, actionType: string): string =>
  `tg:${ctx.update.update_id}:${userIdFromCtx(ctx)}:${actionType}`;

const variantValues = Object.values(ProposalVariantTypes);
const operationValues = Object.values(SuggestEditOperations);

const renderIntake = (view: ReturnType<typeof mapIntakeStatusView>) =>
  [
    `intake: ${view.intake_id}`,
    `state: ${view.state}`,
    `current_field: ${view.current_field ?? 'none'}`,
    `summary_ready: ${view.has_generated_summary ? 'yes' : 'no'}`,
    `confirmed: ${view.has_confirmed_summary ? 'yes' : 'no'}`,
    `version: ${view.version}`
  ].join('\n');

const renderProposalList = (view: ReturnType<typeof mapProposalListView>) =>
  [
    `case: ${view.case_id}`,
    `proposal_set_version: ${view.proposal_set_version}`,
    ...view.variants.map(
      (variant) => `- ${variant.variant_type}: ${variant.title} | ${variant.summary}`
    )
  ].join('\n');

const renderNegotiation = (view: ReturnType<typeof mapNegotiationRoundStatusView>) =>
  [
    `session: ${view.session_id}`,
    `state: ${view.session_state}`,
    `round: ${view.current_round_number ?? 'pending'}`,
    `proposal_set_version: ${view.proposal_set_version}`,
    `round_status: ${view.round_status ?? 'none'}`
  ].join('\n');

const startKeyboard = () =>
  new InlineKeyboard()
    .text('Создать договорённость', 'menu:create')
    .row()
    .text('Присоединиться по приглашению', 'menu:join')
    .row()
    .text('Посмотреть статус', 'menu:status');

const consentKeyboard = (sessionId: string) =>
  new InlineKeyboard()
    .text('Подтвердить участие', `consent:${sessionId}`)
    .row()
    .text('Посмотреть статус', `status:${sessionId}`);

const createOnlyKeyboard = () =>
  new InlineKeyboard().text('Создать договорённость', 'menu:create');

const extractInviteToken = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const fromStartPayload = trimmed.match(/\/start\s+join_([A-Za-z0-9_-]+)/i);
  if (fromStartPayload) {
    return fromStartPayload[1];
  }

  const fromDeepLink = trimmed.match(/[?&]start=join_([A-Za-z0-9_-]+)/i);
  if (fromDeepLink) {
    return fromDeepLink[1];
  }

  const plainJoinPayload = trimmed.match(/^join_([A-Za-z0-9_-]+)$/i);
  if (plainJoinPayload) {
    return plainJoinPayload[1];
  }

  const plainToken = trimmed.match(/^[A-Za-z0-9_-]{12,}$/);
  if (plainToken) {
    return plainToken[0];
  }

  const tokenFromText = trimmed.match(/([A-Za-z0-9_-]{12,})/);
  if (tokenFromText) {
    return tokenFromText[1];
  }

  return null;
};

const normalizeProblemTopicInput = (value: string): string | null => {
  const plain = value.replace(/\s+/g, ' ').trim();
  if (!plain || plain.length > 120) {
    return null;
  }
  return plain;
};

export interface TelegramBotOptions {
  logger?: AppLogger;
  rate_limiter?: InMemoryRateLimiter;
  max_send_attempts?: number;
  base_backoff_ms?: number;
  sleep?: (ms: number) => Promise<void>;
}

const isTransientTelegramSendError = (error: unknown): boolean => {
  const maybeError = error as { error_code?: number; description?: string } | undefined;
  if (!maybeError) {
    return true;
  }

  if (typeof maybeError.error_code === 'number') {
    if (maybeError.error_code >= 500 || maybeError.error_code === 429) {
      return true;
    }

    return false;
  }

  const description = maybeError.description?.toLowerCase() ?? '';
  return (
    description.includes('timeout') ||
    description.includes('temporarily') ||
    description.includes('network')
  );
};

export const buildTelegramBot = (
  token: string,
  gateway: ProtocolGatewayService,
  options: TelegramBotOptions = {}
) => {
  const logger = options.logger ?? createNoopLogger();
  const rateLimiter = options.rate_limiter ?? new InMemoryRateLimiter(new SystemClock());
  const maxSendAttempts = options.max_send_attempts ?? 3;
  const baseBackoffMs = options.base_backoff_ms ?? 150;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pendingInput = new Map<string, PendingInputKind>();
  const pendingProblemSession = new Map<string, string>();
  const pendingSynthesisClarificationSession = new Map<string, string>();
  const problemConfirmed = new Set<string>();
  const problemSynthesisSent = new Set<string>();
  const lastSessionByUser = new Map<string, string>();
  const lastInviteByUser = new Map<
    string,
    { deepLink: string | null; token: string; topic: string; initiatorName: string }
  >();

  const bot = new Bot(token);

  const sendReplyWithRetry = async (
    ctx: Context,
    text: string,
    metadata: { correlation_id: string; action_type: string },
    extra?: { reply_markup?: InlineKeyboard }
  ): Promise<boolean> => {
    for (let attempt = 1; attempt <= maxSendAttempts; attempt += 1) {
      try {
        await ctx.reply(text, extra);
        logger.info(
          {
            correlation_id: metadata.correlation_id,
            action_type: metadata.action_type,
            attempt
          },
          'telegram.outbound.send.success'
        );
        return true;
      } catch (error) {
        const isTransient = isTransientTelegramSendError(error);
        logger.warn(
          {
            correlation_id: metadata.correlation_id,
            action_type: metadata.action_type,
            attempt,
            transient: isTransient,
            error: error instanceof Error ? error.message : 'unknown'
          },
          'telegram.outbound.send.failed'
        );

        if (!isTransient || attempt >= maxSendAttempts) {
          logger.error(
            {
              correlation_id: metadata.correlation_id,
              action_type: metadata.action_type
            },
            'telegram.outbound.send.give_up'
          );
          return false;
        }

        await sleep(baseBackoffMs * 2 ** (attempt - 1));
      }
    }

    return false;
  };

  const requireArgCount = async (
    ctx: Context,
    args: string[],
    count: number,
    usage: string,
    actionType: string
  ) => {
    if (args.length < count) {
      await sendReplyWithRetry(
        ctx,
        usage,
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: actionType
        }
      );
      return false;
    }

    return true;
  };

  const enforceRateLimit = async (
    ctx: Context,
    config: { key: string; limit: number; action_type: string }
  ): Promise<boolean> => {
    const decision = rateLimiter.consume(config.key, config.limit, RATE_LIMIT_WINDOW_MS);
    if (decision.allowed) {
      return true;
    }

    await sendReplyWithRetry(
      ctx,
      'Слишком много запросов. Попробуй через несколько секунд.',
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: config.action_type
      }
    );

    logger.warn(
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: config.action_type,
        retry_after_seconds: decision.retry_after_seconds,
        participant_id: userIdFromCtx(ctx)
      },
      'telegram.action.rate_limited'
    );

    return false;
  };

  const safeAnswerCallback = async (ctx: Context) => {
    if (!ctx.callbackQuery) {
      return;
    }
    try {
      await ctx.answerCallbackQuery();
    } catch {
      // no-op
    }
  };

  const sendDirectWithRetry = async (
    chatId: string,
    text: string,
    metadata: { correlation_id: string; action_type: string },
    extra?: { reply_markup?: InlineKeyboard }
  ): Promise<boolean> => {
    for (let attempt = 1; attempt <= maxSendAttempts; attempt += 1) {
      try {
        await bot.api.sendMessage(Number(chatId), text, extra);
        logger.info(
          {
            correlation_id: metadata.correlation_id,
            action_type: metadata.action_type,
            attempt
          },
          'telegram.outbound.send.success'
        );
        return true;
      } catch (error) {
        const isTransient = isTransientTelegramSendError(error);
        logger.warn(
          {
            correlation_id: metadata.correlation_id,
            action_type: metadata.action_type,
            attempt,
            transient: isTransient,
            error: error instanceof Error ? error.message : 'unknown'
          },
          'telegram.outbound.send.failed'
        );

        if (!isTransient || attempt >= maxSendAttempts) {
          return false;
        }
        await sleep(baseBackoffMs * 2 ** (attempt - 1));
      }
    }
    return false;
  };

  const askProblemDefinition = async (
    participantTelegramUserId: string,
    sessionId: string,
    source: 'direct' | 'current',
    ctx?: Context
  ) => {
    pendingProblemSession.set(participantTelegramUserId, sessionId);
    const text = 'С чем хотите договориться? Опиши коротко';
    if (source === 'current' && ctx) {
      await sendReplyWithRetry(
        ctx,
        text,
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'problem_prompt'
        }
      );
      return;
    }

    await sendDirectWithRetry(
      participantTelegramUserId,
      text,
      {
        correlation_id: `tg:consent:${sessionId}:${participantTelegramUserId}`,
        action_type: 'problem_prompt'
      }
    );
  };

  const problemConfirmationKeyboard = (sessionId: string) =>
    new InlineKeyboard()
      .text('Да, верно', `problem:confirm:${sessionId}`)
      .row()
      .text('Хочу поправить', `problem:edit:${sessionId}`);

  const synthesisFeedbackKeyboard = (sessionId: string) =>
    new InlineKeyboard()
      .text('Это похоже на правду', `synthesis:ok:${sessionId}`)
      .row()
      .text('Нет, нужно уточнить', `synthesis:clarify:${sessionId}`);

  const renderProblemSynthesis = (view: ProblemSynthesisView): string =>
    [
      'Похоже, вы хотите договориться вот о чём:',
      view.focus,
      '',
      'Общее между вашими позициями:',
      view.shared_points,
      '',
      'Где пока есть расхождение:',
      view.divergence
    ].join('\n');

  const describeSessionForUser = async (
    ctx: Context,
    sessionId: string,
    telegramUserId: string
  ): Promise<void> => {
    try {
      const session = await gateway.getSessionStatus(sessionId, telegramUserId);
      lastSessionByUser.set(telegramUserId, sessionId);
      const self = session.participants.find((participant) => participant.telegramUserId === telegramUserId);
      const consentPending =
        session.state === SessionStates.CONSENT_PENDING && self && !self.consentGrantedAt;
      const consentCount = session.participants.filter((participant) => Boolean(participant.consentGrantedAt)).length;

      const statusLines = ['Текущий статус:'];
      if (session.participants.length === 1) {
        statusLines.push('Пока подключён только один участник.');
        statusLines.push('Дальше: дождись второго человека.');
      } else if (consentCount === 2) {
        statusLines.push('Обе стороны подтвердили участие.');
        statusLines.push('Дальше: переходите к обсуждению решения.');
      } else if (self?.consentGrantedAt) {
        statusLines.push('Ты подтвердил участие.');
        statusLines.push('Ждём второго человека.');
      } else if (consentPending) {
        statusLines.push('Оба участника подключены.');
        statusLines.push('Ожидаем подтверждения.');
        statusLines.push('Дальше: нажми «Подтвердить участие».');
      } else {
        statusLines.push('Оба участника подключены.');
        statusLines.push('Ожидаем подтверждения.');
      }

      await sendReplyWithRetry(
        ctx,
        statusLines.join('\n'),
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'session_status'
        },
        consentPending ? { reply_markup: consentKeyboard(sessionId) } : undefined
      );
    } catch (error) {
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'session_status'
      });
    }
  };

  const joinWithToken = async (
    ctx: Context,
    telegramUserId: string,
    inviteToken: string,
    actionType: string
  ) => {
    const correlationId = makeCorrelationId(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:join:${telegramUserId}`,
        limit: JOIN_ATTEMPT_LIMIT,
        action_type: actionType
      }))
    ) {
      return;
    }

    await sendReplyWithRetry(ctx, 'Проверяю…', {
      correlation_id: correlationId,
      action_type: actionType
    });

    try {
      const result = await gateway.joinSession(
        {
          correlation_id: correlationId,
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'join_session'),
          action_type: 'join_session',
          case_id: null,
          participant_id: telegramUserId,
          payload: { invite_token: inviteToken }
        },
        telegramUserId,
        inviteToken
      );
      pendingInput.delete(telegramUserId);
      lastSessionByUser.set(telegramUserId, result.session_id);

      await sendReplyWithRetry(
        ctx,
        [
          'Ты подключился к договорённости.',
          'Дальше: нажми «Подтвердить участие».'
        ].join('\n'),
        {
          correlation_id: correlationId,
          action_type: actionType
        },
        { reply_markup: consentKeyboard(result.session_id) }
      );
    } catch (error) {
      if (error instanceof DomainError && error.code === 'DUPLICATE_JOIN') {
        await sendReplyWithRetry(
          ctx,
          ['Ты уже подключён.', 'Нужен второй человек. Отправь ему приглашение.'].join('\n'),
          {
            correlation_id: correlationId,
            action_type: actionType
          }
        );
        return;
      }
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: correlationId,
        action_type: actionType
      });
    }
  };

  const createSessionFlow = async (
    ctx: Context,
    telegramUserId: string,
    problemTopic: string,
    initiatorName: string
  ) => {
    const correlationId = makeCorrelationId(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:action:${telegramUserId}`,
        limit: GENERAL_ACTION_LIMIT,
        action_type: 'create_session'
      }))
    ) {
      return;
    }

    try {
      const result = await gateway.createSession(
        {
          correlation_id: correlationId,
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'create_session'),
          action_type: 'create_session',
          case_id: null,
          participant_id: telegramUserId,
          payload: { command: 'create_session', problem_topic: problemTopic }
        },
        telegramUserId,
        problemTopic
      );

      lastSessionByUser.set(telegramUserId, result.session_id);
      const username = bot.botInfo?.username ?? ctx.me;
      const deepLink = username
        ? `https://t.me/${username}?start=join_${result.invite_token}`
        : null;
      lastInviteByUser.set(telegramUserId, {
        deepLink,
        token: result.invite_token,
        topic: problemTopic,
        initiatorName
      });

      const keyboard = new InlineKeyboard();
      keyboard
        .text('Пригласить человека', 'invite:send')
        .row()
        .text('Если ссылка не сработает', 'invite:details')
        .row()
        .text('Подтвердить участие', `consent:${result.session_id}`)
        .row()
        .text('Посмотреть статус', `status:${result.session_id}`);

      const text = [
        'Договорённость создана.',
        'Нажми «Пригласить человека», чтобы отправить приглашение второму человеку.',
        '',
        `${initiatorName} хочет обсудить с вами:`,
        `«${problemTopic}»`,
        '',
        'Я помогу вам спокойно договориться.',
        '',
        'Дальше: отправь приглашение и дождись второго человека.'
      ].join('\n');

      await sendReplyWithRetry(
        ctx,
        text,
        { correlation_id: correlationId, action_type: 'create_session' },
        { reply_markup: keyboard }
      );
    } catch (error) {
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: correlationId,
        action_type: 'create_session'
      });
    }
  };

  const giveConsentFlow = async (ctx: Context, sessionId: string, telegramUserId: string, actionType: string) => {
    const correlationId = makeCorrelationId(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:action:${telegramUserId}:${sessionId}`,
        limit: GENERAL_ACTION_LIMIT,
        action_type: 'give_consent'
      }))
    ) {
      return;
    }

    await sendReplyWithRetry(ctx, 'Обрабатываю…', {
      correlation_id: correlationId,
      action_type: actionType
    });

    try {
      const result = await gateway.giveConsent(
        {
          correlation_id: correlationId,
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'give_consent'),
          action_type: 'give_consent',
          case_id: sessionId,
          participant_id: telegramUserId,
          payload: { session_id: sessionId }
        },
        sessionId,
        telegramUserId
      );
      lastSessionByUser.set(telegramUserId, sessionId);
      const feedback =
        result.state === SessionStates.CONSENTED
          ? ['Готово. Вы оба подтвердили участие.', 'Дальше: переходите к обсуждению решения.'].join('\n')
          : ['Ты подтвердил участие.', 'Ждём второго человека.'].join('\n');

      await sendReplyWithRetry(
        ctx,
        feedback,
        {
          correlation_id: correlationId,
          action_type: actionType
        },
        { reply_markup: new InlineKeyboard().text('Посмотреть статус', `status:${sessionId}`) }
      );

      if (result.state === SessionStates.CONSENTED) {
        const session = await gateway.getSessionStatus(sessionId, telegramUserId);
        problemSynthesisSent.delete(sessionId);
        for (const participant of session.participants) {
          problemConfirmed.delete(`${sessionId}:${participant.telegramUserId}`);
          if (participant.telegramUserId === telegramUserId) {
            await askProblemDefinition(participant.telegramUserId, sessionId, 'current', ctx);
          } else {
            await askProblemDefinition(participant.telegramUserId, sessionId, 'direct');
          }
        }
      }
    } catch (error) {
      if (error instanceof DomainError && error.code === 'CONSENT_ALREADY_GRANTED') {
        const session = await gateway.getSessionStatus(sessionId, telegramUserId);
        const consentCount = session.participants.filter((participant) => Boolean(participant.consentGrantedAt)).length;
        const text =
          consentCount < 2
            ? ['Ты уже подтвердил участие.', 'Нужен второй человек. Отправь ему приглашение.'].join('\n')
            : 'Ты уже подтвердил участие.';
        await sendReplyWithRetry(
          ctx,
          text,
          {
            correlation_id: correlationId,
            action_type: actionType
          },
          { reply_markup: new InlineKeyboard().text('Посмотреть статус', `status:${sessionId}`) }
        );
        return;
      }
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: correlationId,
        action_type: actionType
      });
    }
  };

  bot.command('start', async (ctx) => {
    const telegramUserId = userIdFromCtx(ctx);
    const args = parseArgs(ctx.message?.text);
    const joinPayload = args[0]?.startsWith('join_') ? args[0].slice(5) : null;

    if (joinPayload) {
      await joinWithToken(ctx, telegramUserId, joinPayload, 'start_join');
      return;
    }

    pendingInput.delete(telegramUserId);
    await sendReplyWithRetry(
      ctx,
      ['Помогу спокойно договориться и зафиксировать результат.', '', 'Что хочешь сделать?'].join('\n'),
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'start'
      },
      { reply_markup: startKeyboard() }
    );
  });

  bot.command('create_session', async (ctx) => {
    const telegramUserId = userIdFromCtx(ctx);
    pendingInput.set(telegramUserId, 'CREATE_TOPIC');
    await sendReplyWithRetry(
      ctx,
      'О чём хотите договориться? Опиши коротко.',
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'create_topic_prompt'
      }
    );
  });

  bot.command('join_session', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    const telegramUserId = userIdFromCtx(ctx);
    if (args.length === 0) {
      pendingInput.set(telegramUserId, 'JOIN_TOKEN');
      await sendReplyWithRetry(
        ctx,
        'Отправь ссылку-приглашение или токен.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'join_session_prompt'
        }
      );
      return;
    }

    const inviteToken = extractInviteToken(args[0]);
    if (!inviteToken) {
      await sendReplyWithRetry(ctx, 'Похоже, в приглашении ошибка. Попробуй ещё раз или открой ссылку', {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'join_session'
      });
      return;
    }

    await joinWithToken(ctx, telegramUserId, inviteToken, 'join_session');
  });

  bot.command('give_consent', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (!(await requireArgCount(ctx, args, 1, 'Usage: /give_consent <session_id>', 'give_consent'))) {
      return;
    }

    await giveConsentFlow(ctx, args[0], userIdFromCtx(ctx), 'give_consent');
  });

  bot.command('resume_intake', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (!(await requireArgCount(ctx, args, 1, 'Usage: /resume_intake <session_id>', 'resume_intake'))) {
      return;
    }

    const telegramUserId = userIdFromCtx(ctx);
    const correlationId = makeCorrelationId(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:action:${telegramUserId}:${args[0]}`,
        limit: GENERAL_ACTION_LIMIT,
        action_type: 'resume_intake'
      }))
    ) {
      return;
    }

    try {
      const intake = await gateway.resumeIntake(
        {
          correlation_id: correlationId,
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'resume_intake'),
          action_type: 'resume_intake',
          case_id: args[0],
          participant_id: telegramUserId,
          payload: { session_id: args[0] }
        },
        args[0],
        telegramUserId
      );

      await sendReplyWithRetry(ctx, renderIntake(mapIntakeStatusView(intake)), {
        correlation_id: correlationId,
        action_type: 'resume_intake'
      });
    } catch (error) {
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: correlationId,
        action_type: 'resume_intake'
      });
    }
  });

  bot.command('confirm_summary', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (!(await requireArgCount(ctx, args, 1, 'Usage: /confirm_summary <session_id>', 'confirm_summary'))) {
      return;
    }

    const telegramUserId = userIdFromCtx(ctx);
    const correlationId = makeCorrelationId(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:action:${telegramUserId}:${args[0]}`,
        limit: GENERAL_ACTION_LIMIT,
        action_type: 'confirm_summary'
      }))
    ) {
      return;
    }

    try {
      const intake = await gateway.confirmSummary(
        {
          correlation_id: correlationId,
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'confirm_summary'),
          action_type: 'confirm_summary',
          case_id: args[0],
          participant_id: telegramUserId,
          payload: { session_id: args[0] }
        },
        args[0],
        telegramUserId
      );

      await sendReplyWithRetry(ctx, renderIntake(mapIntakeStatusView(intake)), {
        correlation_id: correlationId,
        action_type: 'confirm_summary'
      });
    } catch (error) {
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: correlationId,
        action_type: 'confirm_summary'
      });
    }
  });

  bot.command('reopen_intake', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (!(await requireArgCount(ctx, args, 1, 'Usage: /reopen_intake <session_id>', 'reopen_intake'))) {
      return;
    }

    const telegramUserId = userIdFromCtx(ctx);
    const correlationId = makeCorrelationId(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:action:${telegramUserId}:${args[0]}`,
        limit: GENERAL_ACTION_LIMIT,
        action_type: 'reopen_intake'
      }))
    ) {
      return;
    }

    try {
      const intake = await gateway.reopenIntake(
        {
          correlation_id: correlationId,
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'reopen_intake'),
          action_type: 'reopen_intake',
          case_id: args[0],
          participant_id: telegramUserId,
          payload: { session_id: args[0] }
        },
        args[0],
        telegramUserId
      );

      await sendReplyWithRetry(ctx, renderIntake(mapIntakeStatusView(intake)), {
        correlation_id: correlationId,
        action_type: 'reopen_intake'
      });
    } catch (error) {
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: correlationId,
        action_type: 'reopen_intake'
      });
    }
  });

  bot.command('generate_proposals', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (
      !(await requireArgCount(ctx, args, 1, 'Usage: /generate_proposals <session_id>', 'generate_proposals'))
    ) {
      return;
    }

    const telegramUserId = userIdFromCtx(ctx);
    const correlationId = makeCorrelationId(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:action:${telegramUserId}:${args[0]}`,
        limit: GENERAL_ACTION_LIMIT,
        action_type: 'generate_proposals'
      }))
    ) {
      return;
    }

    try {
      const proposals = await gateway.generateProposals(
        {
          correlation_id: correlationId,
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'generate_proposals'),
          action_type: 'generate_proposals',
          case_id: args[0],
          participant_id: telegramUserId,
          payload: { session_id: args[0] }
        },
        args[0],
        telegramUserId
      );

      await sendReplyWithRetry(ctx, renderProposalList(mapProposalListView(proposals)), {
        correlation_id: correlationId,
        action_type: 'generate_proposals'
      });
    } catch (error) {
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: correlationId,
        action_type: 'generate_proposals'
      });
    }
  });

  bot.command('select_preferred', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (
      !(await requireArgCount(
        ctx,
        args,
        2,
        'Usage: /select_preferred <session_id> <BALANCED|A_LEANING|B_LEANING>',
        'select_preferred'
      ))
    ) {
      return;
    }

    const correlationId = makeCorrelationId(ctx);
    if (!variantValues.includes(args[1] as (typeof variantValues)[number])) {
      await sendReplyWithRetry(
        ctx,
        'Invalid variant type.',
        { correlation_id: correlationId, action_type: 'select_preferred' }
      );
      return;
    }

    const telegramUserId = userIdFromCtx(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:action:${telegramUserId}:${args[0]}`,
        limit: GENERAL_ACTION_LIMIT,
        action_type: 'select_preferred'
      }))
    ) {
      return;
    }

    try {
      await gateway.selectPreferred(
        {
          correlation_id: correlationId,
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'select_preferred'),
          action_type: 'select_preferred',
          case_id: args[0],
          participant_id: telegramUserId,
          payload: { session_id: args[0], variant_type: args[1] }
        },
        args[0],
        telegramUserId,
        args[1] as (typeof variantValues)[number]
      );

      const status = await gateway.getNegotiationStatus(args[0], telegramUserId);
      await sendReplyWithRetry(ctx, renderNegotiation(mapNegotiationRoundStatusView(status)), {
        correlation_id: correlationId,
        action_type: 'select_preferred'
      });
    } catch (error) {
      await sendReplyWithRetry(
        ctx,
        mapTelegramErrorText(error),
        { correlation_id: correlationId, action_type: 'select_preferred' }
      );
    }
  });

  bot.command('accept_proposal', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (
      !(await requireArgCount(
        ctx,
        args,
        2,
        'Usage: /accept_proposal <session_id> <BALANCED|A_LEANING|B_LEANING>',
        'accept_proposal'
      ))
    ) {
      return;
    }

    const correlationId = makeCorrelationId(ctx);
    if (!variantValues.includes(args[1] as (typeof variantValues)[number])) {
      await sendReplyWithRetry(
        ctx,
        'Invalid variant type.',
        { correlation_id: correlationId, action_type: 'accept_proposal' }
      );
      return;
    }

    const telegramUserId = userIdFromCtx(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:action:${telegramUserId}:${args[0]}`,
        limit: GENERAL_ACTION_LIMIT,
        action_type: 'accept_proposal'
      }))
    ) {
      return;
    }

    try {
      await gateway.acceptProposal(
        {
          correlation_id: correlationId,
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'accept_proposal'),
          action_type: 'accept_proposal',
          case_id: args[0],
          participant_id: telegramUserId,
          payload: { session_id: args[0], variant_type: args[1] }
        },
        args[0],
        telegramUserId,
        args[1] as (typeof variantValues)[number]
      );

      const status = await gateway.getNegotiationStatus(args[0], telegramUserId);
      await sendReplyWithRetry(ctx, renderNegotiation(mapNegotiationRoundStatusView(status)), {
        correlation_id: correlationId,
        action_type: 'accept_proposal'
      });
    } catch (error) {
      await sendReplyWithRetry(
        ctx,
        mapTelegramErrorText(error),
        { correlation_id: correlationId, action_type: 'accept_proposal' }
      );
    }
  });

  bot.command('reject_proposal', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (
      !(await requireArgCount(
        ctx,
        args,
        2,
        'Usage: /reject_proposal <session_id> <BALANCED|A_LEANING|B_LEANING>',
        'reject_proposal'
      ))
    ) {
      return;
    }

    const correlationId = makeCorrelationId(ctx);
    if (!variantValues.includes(args[1] as (typeof variantValues)[number])) {
      await sendReplyWithRetry(
        ctx,
        'Invalid variant type.',
        { correlation_id: correlationId, action_type: 'reject_proposal' }
      );
      return;
    }

    const telegramUserId = userIdFromCtx(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:action:${telegramUserId}:${args[0]}`,
        limit: GENERAL_ACTION_LIMIT,
        action_type: 'reject_proposal'
      }))
    ) {
      return;
    }

    try {
      await gateway.rejectProposal(
        {
          correlation_id: correlationId,
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'reject_proposal'),
          action_type: 'reject_proposal',
          case_id: args[0],
          participant_id: telegramUserId,
          payload: { session_id: args[0], variant_type: args[1] }
        },
        args[0],
        telegramUserId,
        args[1] as (typeof variantValues)[number]
      );

      const status = await gateway.getNegotiationStatus(args[0], telegramUserId);
      await sendReplyWithRetry(ctx, renderNegotiation(mapNegotiationRoundStatusView(status)), {
        correlation_id: correlationId,
        action_type: 'reject_proposal'
      });
    } catch (error) {
      await sendReplyWithRetry(
        ctx,
        mapTelegramErrorText(error),
        { correlation_id: correlationId, action_type: 'reject_proposal' }
      );
    }
  });

  bot.command('suggest_edit', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (
      !(await requireArgCount(
        ctx,
        args,
        4,
        'Usage: /suggest_edit <session_id> <variant> <clause_id> <operation> [proposed_value]',
        'suggest_edit'
      ))
    ) {
      return;
    }

    const correlationId = makeCorrelationId(ctx);
    if (!variantValues.includes(args[1] as (typeof variantValues)[number])) {
      await sendReplyWithRetry(
        ctx,
        'Invalid variant type.',
        { correlation_id: correlationId, action_type: 'suggest_edit' }
      );
      return;
    }

    if (!operationValues.includes(args[3] as (typeof operationValues)[number])) {
      await sendReplyWithRetry(
        ctx,
        'Invalid edit operation.',
        { correlation_id: correlationId, action_type: 'suggest_edit' }
      );
      return;
    }

    const telegramUserId = userIdFromCtx(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:action:${telegramUserId}:${args[0]}`,
        limit: GENERAL_ACTION_LIMIT,
        action_type: 'suggest_edit'
      }))
    ) {
      return;
    }

    const proposedValue = args.slice(4).join(' ') || null;

    try {
      await gateway.suggestEdit(
        {
          correlation_id: correlationId,
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'suggest_edit'),
          action_type: 'suggest_edit',
          case_id: args[0],
          participant_id: telegramUserId,
          payload: {
            session_id: args[0],
            variant_type: args[1],
            clause_id: args[2],
            operation: args[3],
            proposed_value: proposedValue
          }
        },
        {
          session_id: args[0],
          telegram_user_id: telegramUserId,
          variant_type: args[1] as (typeof variantValues)[number],
          clause_id: args[2],
          operation: args[3] as (typeof operationValues)[number],
          proposed_value: proposedValue
        }
      );

      const status = await gateway.getNegotiationStatus(args[0], telegramUserId);
      await sendReplyWithRetry(ctx, renderNegotiation(mapNegotiationRoundStatusView(status)), {
        correlation_id: correlationId,
        action_type: 'suggest_edit'
      });
    } catch (error) {
      await sendReplyWithRetry(
        ctx,
        mapTelegramErrorText(error),
        { correlation_id: correlationId, action_type: 'suggest_edit' }
      );
    }
  });

  bot.callbackQuery(/^menu:(create|join|status)$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    const telegramUserId = userIdFromCtx(ctx);
    const action = ctx.match[1];

    if (action === 'create') {
      pendingInput.set(telegramUserId, 'CREATE_TOPIC');
      await sendReplyWithRetry(
        ctx,
        'О чём хотите договориться? Опиши коротко.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'create_topic_prompt'
        }
      );
      return;
    }

    if (action === 'join') {
      pendingInput.set(telegramUserId, 'JOIN_TOKEN');
      await sendReplyWithRetry(
        ctx,
        'Отправь ссылку-приглашение или токен.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'join_prompt'
        }
      );
      return;
    }

    const lastSession = lastSessionByUser.get(telegramUserId);
    if (lastSession) {
      await describeSessionForUser(ctx, lastSession, telegramUserId);
      return;
    }

    await sendReplyWithRetry(
      ctx,
      'У тебя пока нет активной договорённости',
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'status_prompt'
      },
      { reply_markup: createOnlyKeyboard() }
    );
  });

  bot.callbackQuery(/^consent:([A-Za-z0-9_-]{3,})$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    await giveConsentFlow(ctx, ctx.match[1], userIdFromCtx(ctx), 'give_consent_button');
  });

  bot.callbackQuery(/^problem:edit:([A-Za-z0-9_-]{3,})$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    const sessionId = ctx.match[1];
    const telegramUserId = userIdFromCtx(ctx);
    pendingProblemSession.set(telegramUserId, sessionId);
    problemConfirmed.delete(`${sessionId}:${telegramUserId}`);
    problemSynthesisSent.delete(sessionId);
    await sendReplyWithRetry(
      ctx,
      'Отправь исправленный вариант.',
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'problem_edit_prompt'
      }
    );
  });

  bot.callbackQuery(/^problem:confirm:([A-Za-z0-9_-]{3,})$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    const sessionId = ctx.match[1];
    const telegramUserId = userIdFromCtx(ctx);
    problemConfirmed.add(`${sessionId}:${telegramUserId}`);

    if (problemSynthesisSent.has(sessionId)) {
      await sendReplyWithRetry(
        ctx,
        'Ты уже подтвердил свою формулировку.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'problem_confirm'
        }
      );
      return;
    }

    const session = await gateway.getSessionStatus(sessionId, telegramUserId);
    const bothConfirmed = session.participants.every((participant) =>
      problemConfirmed.has(`${sessionId}:${participant.telegramUserId}`)
    );

    if (bothConfirmed) {
      const synthesisEnvelope = await gateway.buildProblemSynthesis(
        {
          correlation_id: makeCorrelationId(ctx),
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'problem_synthesis'),
          action_type: 'problem_synthesis',
          case_id: sessionId,
          participant_id: telegramUserId,
          payload: { session_id: sessionId }
        },
        sessionId,
        telegramUserId
      );
      const synthesisText = renderProblemSynthesis(synthesisEnvelope.synthesis);
      problemSynthesisSent.add(sessionId);
      for (const participant of session.participants) {
        if (participant.telegramUserId === telegramUserId) {
          await sendReplyWithRetry(
            ctx,
            synthesisText,
            {
              correlation_id: makeCorrelationId(ctx),
              action_type: 'problem_both_confirmed'
            },
            { reply_markup: synthesisFeedbackKeyboard(sessionId) }
          );
        } else {
          await sendDirectWithRetry(
            participant.telegramUserId,
            synthesisText,
            {
              correlation_id: `tg:problem:${sessionId}:${participant.telegramUserId}`,
              action_type: 'problem_both_confirmed'
            },
            { reply_markup: synthesisFeedbackKeyboard(sessionId) }
          );
        }
      }
      return;
    }

    await sendReplyWithRetry(
      ctx,
      ['Ты подтвердил свою формулировку.', 'Ждём второго человека.'].join('\n'),
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'problem_confirm'
      }
    );
  });

  bot.callbackQuery(/^synthesis:ok:([A-Za-z0-9_-]{3,})$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    try {
      const sessionId = ctx.match[1];
      const telegramUserId = userIdFromCtx(ctx);
      await gateway.recordProblemSynthesisReaction(
        {
          correlation_id: makeCorrelationId(ctx),
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'synthesis_confirm'),
          action_type: 'synthesis_confirm',
          case_id: sessionId,
          participant_id: telegramUserId,
          payload: { session_id: sessionId, reaction: 'confirm' }
        },
        sessionId,
        telegramUserId,
        'confirm'
      );
      await sendReplyWithRetry(
        ctx,
        'Спасибо. Зафиксировал.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'synthesis_ack'
        }
      );
    } catch (error) {
      await sendReplyWithRetry(
        ctx,
        mapTelegramErrorText(error),
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'synthesis_ack'
        }
      );
    }
  });

  bot.callbackQuery(/^synthesis:clarify:([A-Za-z0-9_-]{3,})$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    try {
      const sessionId = ctx.match[1];
      const telegramUserId = userIdFromCtx(ctx);
      await gateway.recordProblemSynthesisReaction(
        {
          correlation_id: makeCorrelationId(ctx),
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'synthesis_clarify_reaction'),
          action_type: 'synthesis_clarify_reaction',
          case_id: sessionId,
          participant_id: telegramUserId,
          payload: { session_id: sessionId, reaction: 'clarify' }
        },
        sessionId,
        telegramUserId,
        'clarify'
      );
      pendingSynthesisClarificationSession.set(telegramUserId, sessionId);
      await sendReplyWithRetry(
        ctx,
        'Что именно я понял не так?',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'synthesis_clarify_prompt'
        }
      );
    } catch (error) {
      await sendReplyWithRetry(
        ctx,
        mapTelegramErrorText(error),
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'synthesis_clarify_prompt'
        }
      );
    }
  });

  bot.callbackQuery('invite:send', async (ctx) => {
    await safeAnswerCallback(ctx);
    const telegramUserId = userIdFromCtx(ctx);
    const invite = lastInviteByUser.get(telegramUserId);
    if (!invite) {
      await sendReplyWithRetry(ctx, 'Сначала создай договорённость, чтобы получить приглашение.', {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'invite_send'
      });
      return;
    }

    await sendReplyWithRetry(
      ctx,
      [
        'Отправь это приглашение второму человеку:',
        '',
        `${invite.initiatorName} хочет обсудить с вами:`,
        `«${invite.topic}»`,
        '',
        'Я помогу вам спокойно договориться.',
        '',
        invite.deepLink ?? 'Не получилось создать ссылку в этом чате.'
      ].join('\n'),
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'invite_send'
      }
    );
  });

  bot.callbackQuery(/^invite:(details|copy)$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    const telegramUserId = userIdFromCtx(ctx);
    const invite = lastInviteByUser.get(telegramUserId);
    if (!invite) {
      await sendReplyWithRetry(ctx, 'Сначала создай договорённость, чтобы получить приглашение.', {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'invite_details'
      });
      return;
    }

    await sendReplyWithRetry(
      ctx,
      [
        invite.deepLink
          ? ['Ссылка для приглашения:', invite.deepLink].join('\n')
          : 'Не получилось создать ссылку в этом чате.',
        'Если ссылка не сработает, отправь этот токен:',
        invite.token
      ].join('\n'),
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'invite_details'
      }
    );
  });

  bot.callbackQuery(/^status:([A-Za-z0-9_-]{3,})$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    const sessionId = ctx.match[1];
    const telegramUserId = userIdFromCtx(ctx);
    await describeSessionForUser(ctx, sessionId, telegramUserId);
  });

  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text;
    if (!text || text.startsWith('/')) {
      return next();
    }

    const telegramUserId = userIdFromCtx(ctx);
    const pendingClarificationForSession = pendingSynthesisClarificationSession.get(telegramUserId);
    if (pendingClarificationForSession) {
      const input = text.trim();
      if (!input) {
        await sendReplyWithRetry(
          ctx,
          'Что именно я понял не так?',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'synthesis_clarify'
          }
        );
        return;
      }

      try {
        await gateway.submitProblemSynthesisClarification(
          {
            correlation_id: makeCorrelationId(ctx),
            channel: 'TELEGRAM',
            idempotency_key: makeKey(ctx, 'synthesis_clarify'),
            action_type: 'synthesis_clarify',
            case_id: pendingClarificationForSession,
            participant_id: telegramUserId,
            payload: { session_id: pendingClarificationForSession, text: input }
          },
          pendingClarificationForSession,
          telegramUserId,
          input
        );
        pendingSynthesisClarificationSession.delete(telegramUserId);
        await sendReplyWithRetry(
          ctx,
          'Принял уточнение. Сохранил отдельно.',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'synthesis_clarify'
          }
        );
        return;
      } catch (error) {
        await sendReplyWithRetry(
          ctx,
          mapTelegramErrorText(error),
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'synthesis_clarify'
          }
        );
        return;
      }
    }

    const pendingProblemForSession = pendingProblemSession.get(telegramUserId);
    if (pendingProblemForSession) {
      const input = text.trim();
      if (!input) {
        await sendReplyWithRetry(
          ctx,
          'С чем хотите договориться? Опиши коротко',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'problem_definition'
          }
        );
        return;
      }

      try {
        const result = await gateway.submitProblemDefinition(
          {
            correlation_id: makeCorrelationId(ctx),
            channel: 'TELEGRAM',
            idempotency_key: makeKey(ctx, 'problem_definition'),
            action_type: 'problem_definition',
            case_id: pendingProblemForSession,
            participant_id: telegramUserId,
            payload: { session_id: pendingProblemForSession, text: input }
          },
          pendingProblemForSession,
          telegramUserId,
          input
        );
        problemConfirmed.delete(`${pendingProblemForSession}:${telegramUserId}`);
        problemSynthesisSent.delete(pendingProblemForSession);
        await sendReplyWithRetry(
          ctx,
          ['Я записал это так:', result.recorded_text, 'Всё верно?'].join('\n'),
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'problem_definition'
          },
          { reply_markup: problemConfirmationKeyboard(pendingProblemForSession) }
        );
        pendingProblemSession.delete(telegramUserId);
        return;
      } catch (error) {
        await sendReplyWithRetry(
          ctx,
          mapTelegramErrorText(error),
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'problem_definition'
          }
        );
        return;
      }
    }

    const waiting = pendingInput.get(telegramUserId);
    if (!waiting) {
      return next();
    }

    if (waiting === 'CREATE_TOPIC') {
      const topic = normalizeProblemTopicInput(text);
      if (!topic) {
        await sendReplyWithRetry(
          ctx,
          'Тема должна быть короткой: до 120 символов. Попробуй ещё раз.',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'create_topic_validate'
          }
        );
        return;
      }

      pendingInput.delete(telegramUserId);
      const initiatorName = (ctx.from?.first_name ?? 'Кто-то').replace(/\s+/g, ' ').trim();
      await createSessionFlow(ctx, telegramUserId, topic, initiatorName || 'Кто-то');
      return;
    }

    if (waiting === 'JOIN_TOKEN') {
      const tokenValue = extractInviteToken(text);
      if (!tokenValue) {
        await sendReplyWithRetry(ctx, 'Похоже, в приглашении ошибка. Попробуй ещё раз или открой ссылку', {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'join_token_parse'
        });
        return;
      }
      await joinWithToken(ctx, telegramUserId, tokenValue, 'join_session_text');
      return;
    }
    return next();
  });

  bot.hears(
    /^\/(?!start$|create_session$|join_session$|give_consent$|resume_intake$|confirm_summary$|reopen_intake$|generate_proposals$|select_preferred$|accept_proposal$|reject_proposal$|suggest_edit$)[a-z_]+$/,
    async (ctx) => {
      const participantId = userIdFromCtx(ctx);
      if (
        !(await enforceRateLimit(ctx, {
          key: `tg:invalid:${participantId}`,
          limit: INVALID_COMMAND_LIMIT,
          action_type: 'invalid_command'
        }))
      ) {
        return;
      }

      await sendReplyWithRetry(ctx, 'Неизвестная команда. Нажми /start и выбери действие.', {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'invalid_command'
      });
    }
  );

  return bot;
};
