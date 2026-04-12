import { createHash } from 'node:crypto';
import { Bot, Context, InlineKeyboard } from 'grammy';
import { SystemClock } from '../../application/ports/Clock.js';
import { AppLogger, createNoopLogger } from '../../application/ports/AppLogger.js';
import { ConversationStateRepository } from '../../application/ports/ConversationStateRepository.js';
import {
  ProblemSynthesisView,
  ProtocolGatewayService,
  StructuredIntakeAnswerInput
} from '../../application/services/ProtocolGatewayService.js';
import {
  ConversationExpectedInputTypes,
  ConversationStages,
  ParticipantConversationState
} from '../../domain/conversation/types.js';
import { IntakeField } from '../../domain/intake/types.js';
import { IssueReactionTypes } from '../../domain/issue/types.js';
import { SuggestEditOperations } from '../../domain/negotiation/types.js';
import { ProposalVariantTypes } from '../../domain/proposal/types.js';
import { ParticipantRoles, SessionStates } from '../../domain/session/types.js';
import { DomainError } from '../../domain/session/errors.js';
import { mapTelegramErrorText } from '../transport/errorMapping.js';
import { InMemoryRateLimiter } from '../transport/rateLimiter.js';
import { InMemoryConversationStateRepository } from '../repositories/InMemoryConversationStateRepository.js';
import { IntakeDialogManager, ConversationTurn } from '../../application/ports/IntakeDialogManager.js';
import { DeterministicIntakeDialogManager } from '../llm/DeterministicIntakeDialogManager.js';
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
type TelegramEventType = 'message' | 'callback' | 'command' | 'other';

type MediationIntakeStepId =
  | 'situation_facts'
  | 'tension_point'
  | 'important_need_or_interest'
  | 'hard_constraint'
  | 'desired_outcome'
  | 'acceptable_flexibility';

interface MediationIntakeStepDefinition {
  id: MediationIntakeStepId;
  question: string;
  writes: IntakeField[];
}

const mediationIntakeSteps: MediationIntakeStepDefinition[] = [
  {
    id: 'situation_facts',
    question: 'Чтобы зафиксировать базу: что конкретно сейчас происходит?',
    writes: ['facts']
  },
  {
    id: 'tension_point',
    question: 'Что в этой ситуации задевает вас сильнее всего?',
    writes: ['interpretations']
  },
  {
    id: 'important_need_or_interest',
    question: 'Что для вас здесь важнее всего?',
    writes: ['interests']
  },
  {
    id: 'hard_constraint',
    question: 'Что для вас в таком решении точно неприемлемо?',
    writes: ['constraints', 'boundaries']
  },
  {
    id: 'desired_outcome',
    question: 'Какой результат для вас был бы рабочим?',
    writes: ['desired_outcome']
  },
  {
    id: 'acceptable_flexibility',
    question: 'Где вы готовы быть гибкими, если это поможет договориться?',
    writes: ['acceptable_concessions']
  }
];

const mediationStepById = new Map(mediationIntakeSteps.map((step) => [step.id, step]));

const intakeFieldToConversationKey: Record<IntakeField, string> = {
  facts: 'situation_facts',
  interpretations: 'tension_point',
  interests: 'important_need_or_interest',
  constraints: 'hard_constraint',
  boundaries: 'hard_constraint',
  desired_outcome: 'desired_outcome',
  acceptable_concessions: 'acceptable_flexibility',
  non_negotiables: 'hard_constraint'
};

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

const makeStableIntakeConfirmKey = (
  sessionId: string,
  telegramUserId: string,
  stepId: MediationIntakeStepId,
  text: string
): string => {
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 12);
  return `tg:intake_confirm:${sessionId}:${telegramUserId}:${stepId}:${digest}`;
};

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

const statusOnlyKeyboard = (sessionId: string) =>
  new InlineKeyboard().text('Посмотреть статус', `status:${sessionId}`);

const createOnlyKeyboard = () =>
  new InlineKeyboard().text('Создать договорённость', 'menu:create');

const truncateTopicLabel = (topic: string, max = 28): string =>
  topic.length > max ? `${topic.slice(0, max - 1)}…` : topic;

const buildResumeKeyboard = (
  sessions: Array<{ id: string; topic: string | null }>
): InlineKeyboard => {
  const kb = new InlineKeyboard();
  if (sessions.length <= 1) {
    kb.text('Продолжить', 'menu:resume').row();
  } else {
    for (const { id, topic } of sessions) {
      const label = topic ? `Продолжить «${truncateTopicLabel(topic)}»` : 'Продолжить';
      kb.text(label, `menu:resume:${id}`).row();
    }
  }
  kb.text('Начать новую', 'menu:new');
  return kb;
};

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
  render_safe_mode?: boolean;
  conversation_state_repository?: ConversationStateRepository;
  intake_dialog_manager?: IntakeDialogManager;
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
  const renderSafeMode = options.render_safe_mode ?? false;
  const maxTelegramMessageLength = renderSafeMode ? 3500 : 3900;
  const conversationStateRepository =
    options.conversation_state_repository ?? new InMemoryConversationStateRepository();
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const dialogManager = options.intake_dialog_manager ?? new DeterministicIntakeDialogManager();
  const intakeConversationHistory = new Map<string, ConversationTurn[]>();
  const pendingInput = new Map<string, PendingInputKind>();
  const pendingCreateTopicDraft = new Map<string, { topic: string }>();
  const pendingMediationIntakeSession = new Map<string, string>();
  const pendingMediationIntakeStep = new Map<string, MediationIntakeStepId>();
  const pendingMediationIntakeDraft = new Map<
    string,
    { sessionId: string; stepId: MediationIntakeStepId; text: string; reflection: string }
  >();
  const pendingSynthesisClarificationSession = new Map<string, string>();
  const problemSynthesisSent = new Set<string>();
  const issueLoopSent = new Set<string>();
  const draftAgreementSent = new Set<string>();
  const pendingIssueChange = new Map<
    string,
    { sessionId: string; loopVersion: number; optionId: string }
  >();
  const pendingDraftAgreementChange = new Map<
    string,
    { sessionId: string; draftVersion: number }
  >();
  const eventErrorCodeByCorrelation = new Map<string, string | null>();
  const lastSessionByUser = new Map<string, string>();
  const lastInviteByUser = new Map<
    string,
    { deepLink: string | null; token: string; topic: string; initiatorName: string }
  >();

  const bot = new Bot(token);

  const sanitizeTelegramText = (value: string): string => {
    const normalized = value
      .normalize('NFKC')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/\uFFFD+/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return normalized || ' ';
  };

  const splitTelegramText = (text: string): string[] => {
    if (text.length <= maxTelegramMessageLength) {
      return [text];
    }

    const chunks: string[] = [];
    let rest = text;
    while (rest.length > maxTelegramMessageLength) {
      const candidate = rest.slice(0, maxTelegramMessageLength);
      const splitAt = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf(' '));
      const index = splitAt > maxTelegramMessageLength * 0.6 ? splitAt : maxTelegramMessageLength;
      chunks.push(rest.slice(0, index).trim());
      rest = rest.slice(index).trimStart();
    }
    if (rest.length > 0) {
      chunks.push(rest);
    }
    return chunks.length > 0 ? chunks : [' '];
  };

  const prepareOutboundPayload = (text: string) => {
    const rawText = text ?? '';
    const sanitized = sanitizeTelegramText(rawText);
    const chunks = splitTelegramText(sanitized);
    return { rawText, chunks };
  };

  const detectCurrentUxStep = (telegramUserId: string): string => {
    if (pendingSynthesisClarificationSession.has(telegramUserId)) {
      return 'SYNTHESIS_CLARIFICATION_INPUT';
    }
    if (pendingIssueChange.has(telegramUserId)) {
      return 'ISSUE_OPTION_EDIT_INPUT';
    }
    if (pendingDraftAgreementChange.has(telegramUserId)) {
      return 'DRAFT_AGREEMENT_EDIT_INPUT';
    }
    if (pendingMediationIntakeDraft.has(telegramUserId)) {
      return 'INTAKE_CONFIRMATION_PENDING';
    }
    if (pendingMediationIntakeSession.has(telegramUserId)) {
      return 'INTAKE_QUESTION_PENDING';
    }
    if (pendingCreateTopicDraft.has(telegramUserId)) {
      return 'CREATE_TOPIC_CONFIRMATION_PENDING';
    }
    const pending = pendingInput.get(telegramUserId);
    if (pending === 'CREATE_TOPIC') {
      return 'CREATE_TOPIC_INPUT_PENDING';
    }
    if (pending === 'JOIN_TOKEN') {
      return 'JOIN_TOKEN_INPUT_PENDING';
    }
    if (lastSessionByUser.has(telegramUserId)) {
      return 'SESSION_ACTIVE';
    }
    return 'IDLE';
  };

  const extractSessionIdFromCallbackData = (data: string | undefined): string | null => {
    if (!data) {
      return null;
    }
    const patterns = [
      /^consent:([A-Za-z0-9_-]{3,})$/,
      /^status:([A-Za-z0-9_-]{3,})$/,
      /^intake:(?:edit|confirm):([A-Za-z0-9_-]{3,}):[a-z_]+$/,
      /^synthesis:(?:ok|clarify):([A-Za-z0-9_-]{3,})$/,
      /^issue:react:([A-Za-z0-9_-]{3,}):\d+:[A-Z0-9_]+:(?:accept|reject|edit)$/,
      /^agreement:respond:([A-Za-z0-9_-]{3,}):\d+:(?:confirm|edit|reject)$/
    ];
    for (const pattern of patterns) {
      const match = data.match(pattern);
      if (match) {
        return match[1];
      }
    }
    return null;
  };

  const detectEventType = (ctx: Context): TelegramEventType => {
    if (ctx.callbackQuery) {
      return 'callback';
    }
    const text = ctx.message?.text;
    if (!text) {
      return 'other';
    }
    if (text.startsWith('/')) {
      return 'command';
    }
    return 'message';
  };

  const detectCommandName = (ctx: Context): string | null => {
    const text = ctx.message?.text?.trim();
    if (!text || !text.startsWith('/')) {
      return null;
    }
    return text.split(/\s+/)[0] ?? null;
  };

  const resolveSessionContext = async (ctx: Context, telegramUserId: string) => {
    const callbackSessionId = extractSessionIdFromCallbackData(ctx.callbackQuery?.data);
    const sessionId = callbackSessionId ?? pendingMediationIntakeSession.get(telegramUserId) ?? lastSessionByUser.get(telegramUserId) ?? null;
    if (!sessionId) {
      return {
        session_id: null as string | null,
        protocol_state: null as string | null,
        role: null as string | null
      };
    }
    try {
      const session = await gateway.getSessionStatus(sessionId, telegramUserId);
      const self = session.participants.find((entry) => entry.telegramUserId === telegramUserId);
      return {
        session_id: sessionId,
        protocol_state: session.state,
        role: self?.role ?? null
      };
    } catch {
      return {
        session_id: sessionId,
        protocol_state: null,
        role: null
      };
    }
  };

  const logInboundEvent = async (ctx: Context, handler: string) => {
    const telegramUserId = userIdFromCtx(ctx);
    const context = await resolveSessionContext(ctx, telegramUserId);
    logger.info(
      {
        correlation_id: makeCorrelationId(ctx),
        handler,
        event_type: detectEventType(ctx),
        command: detectCommandName(ctx),
        callback_data: ctx.callbackQuery?.data ?? null,
        telegram_user_id: telegramUserId,
        session_id: context.session_id,
        role: context.role,
        current_ux_step: detectCurrentUxStep(telegramUserId),
        current_protocol_state: context.protocol_state
      },
      'telegram.ux.event.received'
    );
  };

  const logTransition = async (
    ctx: Context,
    handler: string,
    result: 'success' | 'error',
    errorCode?: string | null
  ) => {
    const telegramUserId = userIdFromCtx(ctx);
    const context = await resolveSessionContext(ctx, telegramUserId);
    logger.info(
      {
        correlation_id: makeCorrelationId(ctx),
        handler,
        result,
        error_code: errorCode ?? null,
        telegram_user_id: telegramUserId,
        session_id: context.session_id,
        role: context.role,
        next_ux_step: detectCurrentUxStep(telegramUserId),
        next_protocol_state: context.protocol_state
      },
      'telegram.ux.event.transition'
    );
  };

  const replyWithMappedError = async (
    ctx: Context,
    error: unknown,
    actionType: string,
    handler: string
  ) => {
    const domainCode = error instanceof DomainError ? error.code : null;
    eventErrorCodeByCorrelation.set(makeCorrelationId(ctx), domainCode);
    logger.warn(
      {
        correlation_id: makeCorrelationId(ctx),
        handler,
        action_type: actionType,
        error_code: domainCode,
        error_message: error instanceof Error ? error.message : String(error)
      },
      'telegram.handler.error'
    );
    await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
      correlation_id: makeCorrelationId(ctx),
      action_type: actionType
    });
    await logTransition(ctx, handler, 'error', domainCode);
  };

  const sendReplyWithRetry = async (
    ctx: Context,
    text: string,
    metadata: { correlation_id: string; action_type: string },
    extra?: { reply_markup?: InlineKeyboard }
  ): Promise<boolean> => {
    const payload = prepareOutboundPayload(text);
    for (let index = 0; index < payload.chunks.length; index += 1) {
      const chunk = payload.chunks[index];
      const isLastChunk = index === payload.chunks.length - 1;
      const chunkExtra = isLastChunk ? extra : undefined;
      logger.info(
        {
          correlation_id: metadata.correlation_id,
          action_type: metadata.action_type,
          chunk_index: index + 1,
          chunk_count: payload.chunks.length,
          raw_text: payload.rawText,
          text: chunk,
          length: chunk.length,
          parse_mode: null,
          buttons_attached: Boolean(chunkExtra?.reply_markup),
          buttons_payload: chunkExtra?.reply_markup ? JSON.stringify(chunkExtra.reply_markup) : null
        },
        'telegram.outbound.payload'
      );

      let delivered = false;
      for (let attempt = 1; attempt <= maxSendAttempts; attempt += 1) {
        try {
          await ctx.reply(chunk, chunkExtra);
          logger.info(
            {
              correlation_id: metadata.correlation_id,
              action_type: metadata.action_type,
              attempt,
              chunk_index: index + 1
            },
            'telegram.outbound.send.success'
          );
          delivered = true;
          break;
        } catch (error) {
          const isTransient = isTransientTelegramSendError(error);
          logger.warn(
            {
              correlation_id: metadata.correlation_id,
              action_type: metadata.action_type,
              attempt,
              chunk_index: index + 1,
              transient: isTransient,
              error: error instanceof Error ? error.message : 'unknown'
            },
            'telegram.outbound.send.failed'
          );

          if (!isTransient || attempt >= maxSendAttempts) {
            logger.error(
              {
                correlation_id: metadata.correlation_id,
                action_type: metadata.action_type,
                chunk_index: index + 1
              },
              'telegram.outbound.send.give_up'
            );
            return false;
          }
          await sleep(baseBackoffMs * 2 ** (attempt - 1));
        }
      }

      if (!delivered) {
        return false;
      }
    }

    return true;
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
      'Слишком много запросов. Попробуйте через несколько секунд.',
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

  bot.use(async (ctx, next) => {
    const correlationId = makeCorrelationId(ctx);
    await logInboundEvent(ctx, 'middleware');
    await next();
    const errorCode = eventErrorCodeByCorrelation.get(correlationId) ?? null;
    eventErrorCodeByCorrelation.delete(correlationId);
    await logTransition(ctx, 'middleware', errorCode ? 'error' : 'success', errorCode);
  });

  const sendDirectWithRetry = async (
    chatId: string,
    text: string,
    metadata: { correlation_id: string; action_type: string },
    extra?: { reply_markup?: InlineKeyboard }
  ): Promise<boolean> => {
    const payload = prepareOutboundPayload(text);
    for (let index = 0; index < payload.chunks.length; index += 1) {
      const chunk = payload.chunks[index];
      const isLastChunk = index === payload.chunks.length - 1;
      const chunkExtra = isLastChunk ? extra : undefined;
      logger.info(
        {
          correlation_id: metadata.correlation_id,
          action_type: metadata.action_type,
          chat_id: chatId,
          chunk_index: index + 1,
          chunk_count: payload.chunks.length,
          raw_text: payload.rawText,
          text: chunk,
          length: chunk.length,
          parse_mode: null,
          buttons_attached: Boolean(chunkExtra?.reply_markup),
          buttons_payload: chunkExtra?.reply_markup ? JSON.stringify(chunkExtra.reply_markup) : null
        },
        'telegram.outbound.payload'
      );

      let delivered = false;
      for (let attempt = 1; attempt <= maxSendAttempts; attempt += 1) {
        try {
          await bot.api.sendMessage(Number(chatId), chunk, chunkExtra);
          logger.info(
            {
              correlation_id: metadata.correlation_id,
              action_type: metadata.action_type,
              attempt,
              chunk_index: index + 1
            },
            'telegram.outbound.send.success'
          );
          delivered = true;
          break;
        } catch (error) {
          const isTransient = isTransientTelegramSendError(error);
          logger.warn(
            {
              correlation_id: metadata.correlation_id,
              action_type: metadata.action_type,
              attempt,
              chunk_index: index + 1,
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

      if (!delivered) {
        return false;
      }
    }
    return true;
  };

  const mediationIntakeConfirmationKeyboard = (
    sessionId: string,
    stepId: MediationIntakeStepId
  ) =>
    new InlineKeyboard()
      .text('Да, верно', `intake:confirm:${sessionId}:${stepId}`)
      .row()
      .text('Хочу поправить', `intake:edit:${sessionId}:${stepId}`);

  const findNextMediationIntakeStep = (
    fields: Awaited<ReturnType<ProtocolGatewayService['getIntakeProgress']>>['fields']
  ): MediationIntakeStepDefinition | null => {
    for (const step of mediationIntakeSteps) {
      const completed = step.writes.every((field) => {
        const entry = fields[field];
        return Boolean(entry.rawValue && entry.normalizedValue);
      });
      if (!completed) {
        return step;
      }
    }
    return null;
  };

  const committedConversationFields = (
    fields: Awaited<ReturnType<ProtocolGatewayService['getIntakeProgress']>>['fields']
  ): string[] => {
    const committed = new Set<string>();
    for (const [field, entry] of Object.entries(fields) as Array<[IntakeField, { rawValue: string | null; normalizedValue: string | null }]>) {
      if (entry.rawValue && entry.normalizedValue) {
        committed.add(intakeFieldToConversationKey[field]);
      }
    }
    return [...committed];
  };

  const upsertConversationState = async (input: {
    sessionId: string;
    telegramUserId: string;
    currentStage: ParticipantConversationState['currentStage'];
    currentQuestionKey: string | null;
    expectedInputType: ParticipantConversationState['expectedInputType'];
    currentDraft: string | null;
    committedFields: string[];
    pendingAction: string | null;
    lastEventId: number | null;
    lastErrorCode?: string | null;
    lastInboundEvent?: string | null;
    lastOutboundAction?: string | null;
  }) => {
    await conversationStateRepository.upsert({
      sessionId: input.sessionId,
      telegramUserId: input.telegramUserId,
      currentStage: input.currentStage,
      currentQuestionKey: input.currentQuestionKey,
      expectedInputType: input.expectedInputType,
      currentDraft: input.currentDraft,
      committedFields: input.committedFields,
      pendingAction: input.pendingAction,
      lastEventId: input.lastEventId,
      lastErrorCode: input.lastErrorCode ?? null,
      lastInboundEvent: input.lastInboundEvent ?? null,
      lastOutboundAction: input.lastOutboundAction ?? null
    });
  };

  const findActiveIntakeState = async (telegramUserId: string) => {
    const state = await conversationStateRepository.findActiveByUser(telegramUserId);
    if (!state || state.currentStage !== ConversationStages.INTAKE) {
      return null;
    }
    return state;
  };

  const resolveIntakeReflection = async (
    sessionId: string,
    telegramUserId: string,
    stepId: MediationIntakeStepId,
    text: string
  ): Promise<string> => {
    const step = mediationStepById.get(stepId);
    if (!step) {
      return 'Слышу вас. Я правильно понял суть?';
    }

    try {
      const preview = await gateway.previewIntakeReflection(
        sessionId,
        telegramUserId,
        step.writes[0] ?? 'facts',
        text,
        step.question
      );
      const reflection = preview.reflection?.trim();
      return reflection || 'Слышу вас. Я правильно понял суть?';
    } catch (error) {
      logger.warn(
        {
          correlation_id: `tg:intake_reflection:${sessionId}:${telegramUserId}`,
          action_type: 'mediation_intake_reflection',
          code: error instanceof DomainError ? error.code : 'INTAKE_REFLECTION_FAILED'
        },
        'telegram.intake.reflection.failed'
      );
      return 'Слышу вас. Я правильно понял суть?';
    }
  };

  const askNextMediationIntakeQuestion = async (
    participantTelegramUserId: string,
    sessionId: string,
    source: 'direct' | 'current',
    ctx?: Context
  ) => {
    let view = await gateway.getIntakeProgress(sessionId, participantTelegramUserId);
    if (view.state === 'SUMMARY_PENDING_CONFIRMATION' && view.generatedSummary) {
      view = await gateway.confirmSummary(
        {
          correlation_id:
            source === 'current' && ctx
              ? makeCorrelationId(ctx)
              : `tg:intake_auto_confirm:${sessionId}:${participantTelegramUserId}`,
          channel: 'TELEGRAM',
          idempotency_key: `tg:intake_auto_confirm:${sessionId}:${participantTelegramUserId}:${view.version}`,
          action_type: 'intake_auto_confirm',
          case_id: sessionId,
          participant_id: participantTelegramUserId,
          payload: { session_id: sessionId, source: 'telegram_guided_intake' }
        },
        sessionId,
        participantTelegramUserId
      );
    }
    const nextStep = findNextMediationIntakeStep(view.fields);
    if (!nextStep) {
      pendingMediationIntakeSession.delete(participantTelegramUserId);
      pendingMediationIntakeStep.delete(participantTelegramUserId);
      pendingMediationIntakeDraft.delete(participantTelegramUserId);
      // Clear intake conversation history for this participant in this session
      const historyKeyToDelete = `${sessionId}:${participantTelegramUserId}`;
      intakeConversationHistory.delete(historyKeyToDelete);
      await upsertConversationState({
        sessionId,
        telegramUserId: participantTelegramUserId,
        currentStage: ConversationStages.COMPLETED,
        currentQuestionKey: null,
        expectedInputType: ConversationExpectedInputTypes.NONE,
        currentDraft: null,
        committedFields: committedConversationFields(view.fields),
        pendingAction: null,
        lastEventId: ctx?.update.update_id ?? null,
        lastInboundEvent: source === 'current' ? 'intake_transition' : 'intake_direct_transition',
        lastOutboundAction: 'mediation_intake_completed'
      });

      const session = await gateway.getSessionStatus(sessionId, participantTelegramUserId);
      const allCompleted = session.state === SessionStates.READY_FOR_SYNTHESIS;
      if (!allCompleted) {
        const waitText = [
          'Готово. Я услышал вас.',
          'Как только второй участник завершит свою часть — мы пойдём дальше.'
        ].join('\n');
        if (source === 'current' && ctx) {
          await sendReplyWithRetry(ctx, waitText, {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'mediation_intake_completed'
          });
          return;
        }
        await sendDirectWithRetry(
          participantTelegramUserId,
          waitText,
          {
            correlation_id: `tg:intake:${sessionId}:${participantTelegramUserId}`,
            action_type: 'mediation_intake_completed'
          }
        );
        return;
      }

      if (problemSynthesisSent.has(sessionId)) {
        const alreadySentText = 'Сводная картина уже готова. Проверьте последнее сообщение.';
        if (source === 'current' && ctx) {
          await sendReplyWithRetry(
            ctx,
            alreadySentText,
            {
              correlation_id: makeCorrelationId(ctx),
              action_type: 'problem_synthesis_ready'
            }
          );
          return;
        }
        await sendDirectWithRetry(
          participantTelegramUserId,
          alreadySentText,
          {
            correlation_id: `tg:synthesis:${sessionId}:${participantTelegramUserId}`,
            action_type: 'problem_synthesis_ready'
          }
        );
        return;
      }

      try {
        problemSynthesisSent.add(sessionId);
        const synthesis = await gateway.buildProblemSynthesis(
          {
            correlation_id:
              source === 'current' && ctx
                ? makeCorrelationId(ctx)
                : `tg:problem_synthesis:${sessionId}:${participantTelegramUserId}`,
            channel: 'TELEGRAM',
            idempotency_key: `tg:problem_synthesis:${sessionId}:${participantTelegramUserId}`,
            action_type: 'problem_synthesis',
            case_id: sessionId,
            participant_id: participantTelegramUserId,
            payload: { session_id: sessionId }
          },
          sessionId,
          participantTelegramUserId
        );
        const synthesisText = renderProblemSynthesis(synthesis.synthesis);
        for (const participant of session.participants) {
          await sendDirectWithRetry(
            participant.telegramUserId,
            synthesisText,
            {
              correlation_id: `tg:problem_synthesis_send:${sessionId}:${participant.telegramUserId}`,
              action_type: 'problem_synthesis_send'
            },
            { reply_markup: synthesisFeedbackKeyboard(sessionId) }
          );
        }
        return;
      } catch (error) {
        problemSynthesisSent.delete(sessionId);
        const errorText = mapTelegramErrorText(error);
        if (source === 'current' && ctx) {
          await sendReplyWithRetry(
            ctx,
            errorText,
            {
              correlation_id: makeCorrelationId(ctx),
              action_type: 'problem_synthesis_send'
            }
          );
          return;
        }
        await sendDirectWithRetry(
          participantTelegramUserId,
          errorText,
          {
            correlation_id: `tg:problem_synthesis_error:${sessionId}:${participantTelegramUserId}`,
            action_type: 'problem_synthesis_send'
          }
        );
        return;
      }
    }

    pendingMediationIntakeSession.set(participantTelegramUserId, sessionId);
    pendingMediationIntakeStep.set(participantTelegramUserId, nextStep.id);
    await upsertConversationState({
      sessionId,
      telegramUserId: participantTelegramUserId,
      currentStage: ConversationStages.INTAKE,
      currentQuestionKey: nextStep.id,
      expectedInputType: ConversationExpectedInputTypes.TEXT,
      currentDraft: null,
      committedFields: committedConversationFields(view.fields),
      pendingAction: null,
      lastEventId: ctx?.update.update_id ?? null,
      lastInboundEvent: source === 'current' ? 'intake_transition' : 'intake_direct_transition',
      lastOutboundAction: 'mediation_intake_question'
    });
    const text =
      nextStep.id === 'situation_facts'
        ? 'Расскажите, что происходит. Как вы это видите?'
        : nextStep.question;
    if (source === 'current' && ctx) {
      await sendReplyWithRetry(
        ctx,
        text,
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'mediation_intake_question'
        }
      );
      if (nextStep.id === 'situation_facts') {
        const historyKey = `${sessionId}:${participantTelegramUserId}`;
        const history = intakeConversationHistory.get(historyKey) ?? [];
        if (history.length === 0) {
          history.push({ role: 'assistant', text });
          intakeConversationHistory.set(historyKey, history);
        }
      }
      return;
    }

    await sendDirectWithRetry(
      participantTelegramUserId,
      text,
      {
        correlation_id: `tg:consent:${sessionId}:${participantTelegramUserId}`,
        action_type: 'mediation_intake_question'
      }
    );
    if (nextStep.id === 'situation_facts') {
      const historyKey = `${sessionId}:${participantTelegramUserId}`;
      const history = intakeConversationHistory.get(historyKey) ?? [];
      if (history.length === 0) {
        history.push({ role: 'assistant', text });
        intakeConversationHistory.set(historyKey, history);
      }
    }
  };

  const createTopicDraftKeyboard = () =>
    new InlineKeyboard()
      .text('Да, верно', 'create_topic:confirm_draft')
      .row()
      .text('Хочу переформулировать', 'create_topic:rephrase');

  const synthesisFeedbackKeyboard = (sessionId: string) =>
    new InlineKeyboard()
      .text('Это похоже на правду', `synthesis:ok:${sessionId}`)
      .row()
      .text('Нет, нужно уточнить', `synthesis:clarify:${sessionId}`);

  const renderProblemSynthesis = (view: ProblemSynthesisView): string =>
    [
      'Похоже, вы оба хотите...',
      view.shared_goal,
      '',
      'У вас уже есть общее в том, что...',
      `- ${view.agreement_points.join('\n- ')}`,
      '',
      'Главная точка напряжения сейчас...',
      view.primary_tension_point,
      '',
      'Похоже, рабочее поле для договорённости может быть таким...',
      view.possible_zone_of_agreement
    ].join('\n');

  const issueOptionKeyboard = (sessionId: string, loopVersion: number, optionId: string) =>
    new InlineKeyboard()
      .text('Подходит', `issue:react:${sessionId}:${loopVersion}:${optionId}:accept`)
      .row()
      .text('Не подходит', `issue:react:${sessionId}:${loopVersion}:${optionId}:reject`)
      .row()
      .text('Хочу изменить', `issue:react:${sessionId}:${loopVersion}:${optionId}:edit`);

  const renderIssueFraming = (
    loop: Awaited<ReturnType<ProtocolGatewayService['generateIssueResolutionLoop']>>
  ): string =>
    [
      'Похоже, основной вопрос сейчас такой:',
      loop.issue_title,
      '',
      'С одной стороны важно...',
      loop.side_a_priority,
      '',
      'С другой стороны важно...',
      loop.side_b_priority
    ].join('\n');

  const renderIssueOption = (
    option: Awaited<ReturnType<ProtocolGatewayService['generateIssueResolutionLoop']>>['options'][number]
  ): string =>
    [
      option.description,
      '',
      `Что придётся учесть: ${option.tradeoff_note}`
    ].join('\n');

  const draftAgreementKeyboard = (sessionId: string, draftVersion: number) =>
    new InlineKeyboard()
      .text('Подтверждаю', `agreement:respond:${sessionId}:${draftVersion}:confirm`)
      .row()
      .text('Хочу изменить', `agreement:respond:${sessionId}:${draftVersion}:edit`)
      .row()
      .text('Не подходит', `agreement:respond:${sessionId}:${draftVersion}:reject`);

  const renderDraftAgreement = (
    draft: Awaited<ReturnType<ProtocolGatewayService['generateDraftAgreement']>>
  ): string =>
    [
      'Похоже, вы пришли к такому варианту:',
      '',
      ...draft.agreed_actions.map((action) => `— ${action}`),
      '',
      'Границы:',
      ...draft.boundaries.map((entry) => `— ${entry}`),
      '',
      'Если что-то пойдёт не так:',
      `— ${draft.fallback_rule}`,
      '',
      'Можно пересмотреть:',
      `— ${draft.review_point}`,
      '',
      'Подтверждаем договорённость?'
    ].join('\n');

  const maybeStartIssueLoop = async (
    sessionId: string,
    triggerTelegramUserId: string,
    source: 'current' | 'direct',
    ctx?: Context
  ) => {
    if (issueLoopSent.has(sessionId)) {
      return;
    }

    const review = await gateway.getProblemSynthesisDogfoodExport(sessionId, triggerTelegramUserId);
    if (review.confirm_count + review.clarify_count < 2) {
      return;
    }

    issueLoopSent.add(sessionId);
    try {
      const loop = await gateway.generateIssueResolutionLoop(
        {
          correlation_id:
            source === 'current' && ctx
              ? makeCorrelationId(ctx)
              : `tg:issue_loop:${sessionId}:${triggerTelegramUserId}`,
          channel: 'TELEGRAM',
          idempotency_key: `tg:issue_loop:${sessionId}`,
          action_type: 'issue_loop_generate',
          case_id: sessionId,
          participant_id: triggerTelegramUserId,
          payload: { session_id: sessionId }
        },
        sessionId,
        triggerTelegramUserId
      );

      const session = await gateway.getSessionStatus(sessionId, triggerTelegramUserId);
      for (const participant of session.participants) {
        await sendDirectWithRetry(
          participant.telegramUserId,
          renderIssueFraming(loop),
          {
            correlation_id: `tg:issue_loop_framing:${sessionId}:${participant.telegramUserId}`,
            action_type: 'issue_loop_framing'
          }
        );
        await sendDirectWithRetry(
          participant.telegramUserId,
          'Вот варианты, которые могут сработать:',
          {
            correlation_id: `tg:issue_loop_intro:${sessionId}:${participant.telegramUserId}`,
            action_type: 'issue_loop_options'
          }
        );
        for (const option of loop.options) {
          await sendDirectWithRetry(
            participant.telegramUserId,
            renderIssueOption(option),
            {
              correlation_id: `tg:issue_loop_option:${sessionId}:${participant.telegramUserId}:${option.option_id}`,
              action_type: 'issue_loop_option'
            },
            {
              reply_markup: issueOptionKeyboard(sessionId, loop.loop_version, option.option_id)
            }
          );
        }
      }
    } catch (error) {
      issueLoopSent.delete(sessionId);
      if (source === 'current' && ctx) {
        await sendReplyWithRetry(
          ctx,
          mapTelegramErrorText(error),
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'issue_loop_generate'
          }
        );
      }
    }
  };

  const maybeStartDraftAgreement = async (
    sessionId: string,
    triggerTelegramUserId: string
  ) => {
    if (draftAgreementSent.has(sessionId)) {
      return;
    }

    const summary = await gateway.getIssueResolutionSummary(sessionId, triggerTelegramUserId);
    if (summary.status !== 'WORKABLE_PATH_FOUND') {
      return;
    }

    draftAgreementSent.add(sessionId);
    try {
      const draft = await gateway.generateDraftAgreement(
        {
          correlation_id: `tg:draft:${sessionId}:${triggerTelegramUserId}`,
          channel: 'TELEGRAM',
          idempotency_key: `tg:draft:${sessionId}`,
          action_type: 'draft_agreement_generate',
          case_id: sessionId,
          participant_id: triggerTelegramUserId,
          payload: { session_id: sessionId }
        },
        sessionId,
        triggerTelegramUserId
      );
      const session = await gateway.getSessionStatus(sessionId, triggerTelegramUserId);
      for (const participant of session.participants) {
        await sendDirectWithRetry(
          participant.telegramUserId,
          renderDraftAgreement(draft),
          {
            correlation_id: `tg:draft:${sessionId}:${participant.telegramUserId}`,
            action_type: 'draft_agreement'
          },
          { reply_markup: draftAgreementKeyboard(sessionId, draft.draft_version) }
        );
      }
    } catch {
      draftAgreementSent.delete(sessionId);
    }
  };

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
      const isCreator = self?.role === ParticipantRoles.PARTY_A;
      const showConsentAction = consentPending && !isCreator;

      const statusLines = ['Текущий статус:'];
      if (session.participants.length === 1) {
        statusLines.push('Пока подключён только один участник.');
        statusLines.push('Дальше: дождитесь второго человека.');
      } else if (
        session.state === SessionStates.SIDE_A_INTAKE ||
        session.state === SessionStates.SIDE_B_INTAKE ||
        session.state === SessionStates.CONSENTED
      ) {
        statusLines.push('Сейчас каждый отвечает на вопросы отдельно.');
        statusLines.push('Дальше: завершите ответы, чтобы можно было собрать общую картину.');
      } else if (consentCount === 2) {
        statusLines.push('Обе стороны подтвердили участие.');
        statusLines.push('Дальше: переходите к обсуждению решения.');
      } else if (isCreator) {
        statusLines.push('Второй человек подключился.');
        statusLines.push('Ждём, пока он подтвердит участие.');
      } else if (self?.consentGrantedAt) {
        statusLines.push('Вы подтвердили участие.');
        statusLines.push('Ждём второго человека.');
      } else if (consentPending) {
        statusLines.push('Оба участника подключены.');
        statusLines.push('Ожидаем подтверждения.');
        statusLines.push('Дальше: нажмите «Подтвердить участие».');
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
        showConsentAction ? { reply_markup: consentKeyboard(sessionId) } : undefined
      );
    } catch (error) {
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'session_status'
      });
    }
  };

  const resumeActiveScenario = async (ctx: Context, telegramUserId: string, targetSessionId?: string): Promise<boolean> => {
    const pendingJoin = pendingInput.get(telegramUserId) === 'JOIN_TOKEN';
    if (pendingJoin) {
      await sendReplyWithRetry(
        ctx,
        ['У вас уже есть активный сценарий.', 'Отправьте ссылку-приглашение или токен.'].join('\n'),
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'start_resume'
        }
      );
      return true;
    }

    const pendingTopic = pendingInput.get(telegramUserId) === 'CREATE_TOPIC';
    if (pendingTopic) {
      await sendReplyWithRetry(
        ctx,
        ['У вас уже есть активный сценарий.', 'О чём хотите договориться? Опишите коротко.'].join('\n'),
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'start_resume'
        }
      );
      return true;
    }

    const draftTopic = pendingCreateTopicDraft.get(telegramUserId);
    if (draftTopic) {
      await sendReplyWithRetry(
        ctx,
        ['Продолжаем с текущего шага.', 'Проверьте формулировку и подтвердите или поправьте.'].join('\n'),
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'start_resume'
        },
        { reply_markup: createTopicDraftKeyboard() }
      );
      return true;
    }

    const tryGetSessionTopic = async (sessionId: string): Promise<string | null> => {
      try {
        const session = await gateway.getSessionStatus(sessionId, telegramUserId);
        return session.problemTopic ?? null;
      } catch {
        return null;
      }
    };

    const stepProgressLine = (stepId: string | null): string | null => {
      if (!stepId) return null;
      const idx = mediationIntakeSteps.findIndex((s) => s.id === stepId);
      if (idx === -1) return null;
      return `Вопрос ${idx + 1} из ${mediationIntakeSteps.length}`;
    };

    const persistentIntake = await (async () => {
      const state = await findActiveIntakeState(telegramUserId);
      if (!state) return null;
      // If a specific session was requested, only resume that one
      if (targetSessionId && state.sessionId !== targetSessionId) return null;
      return state;
    })();
    if (persistentIntake) {
      const step = persistentIntake.currentQuestionKey
        ? mediationStepById.get(persistentIntake.currentQuestionKey as MediationIntakeStepId)
        : null;
      const topic = await tryGetSessionTopic(persistentIntake.sessionId);
      const progress = stepProgressLine(persistentIntake.currentQuestionKey);
      const contextPrefix = [topic ? `Тема: «${topic}»` : null, progress]
        .filter(Boolean)
        .join(' · ');
      // Always resume by asking the actual next question based on real intake progress.
      // (Ignore stale CONFIRM state from old code — no longer used.)
      await sendReplyWithRetry(
        ctx,
        contextPrefix ? `Продолжаем. ${contextPrefix}.` : 'Продолжаем с текущего вопроса.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'start_resume'
        }
      );
      await askNextMediationIntakeQuestion(telegramUserId, persistentIntake.sessionId, 'current', ctx);
      return true;
    }

    const pendingSessionId = pendingMediationIntakeSession.get(telegramUserId);
    if (pendingSessionId) {
      const topic = await tryGetSessionTopic(pendingSessionId);
      const currentStepId = pendingMediationIntakeStep.get(telegramUserId) ?? null;
      const progress = stepProgressLine(currentStepId);
      const contextPrefix = [topic ? `Тема: «${topic}»` : null, progress]
        .filter(Boolean)
        .join(' · ');
      await sendReplyWithRetry(
        ctx,
        contextPrefix ? `Продолжаем. ${contextPrefix}.` : 'Продолжаем с текущего вопроса.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'start_resume'
        }
      );
      await askNextMediationIntakeQuestion(telegramUserId, pendingSessionId, 'current', ctx);
      return true;
    }

    const intakeDraft = pendingMediationIntakeDraft.get(telegramUserId);
    if (intakeDraft) {
      const topic = await tryGetSessionTopic(intakeDraft.sessionId);
      const progress = stepProgressLine(intakeDraft.stepId);
      const contextPrefix = [topic ? `Тема: «${topic}»` : null, progress]
        .filter(Boolean)
        .join(' · ');
      const headerLine = contextPrefix
        ? `Продолжаем. ${contextPrefix}.`
        : 'Вы уже на этом шаге. Подтвердите или поправьте формулировку.';
      await sendReplyWithRetry(
        ctx,
        [headerLine, intakeDraft.reflection].join('\n\n'),
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'start_resume'
        },
        { reply_markup: mediationIntakeConfirmationKeyboard(intakeDraft.sessionId, intakeDraft.stepId) }
      );
      return true;
    }

    const pendingClarificationSessionId = pendingSynthesisClarificationSession.get(telegramUserId);
    if (pendingClarificationSessionId) {
      await sendReplyWithRetry(
        ctx,
        'Мы здесь остановились. Напишите что именно нужно поправить.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'start_resume'
        }
      );
      return true;
    }

    const pendingIssueEdit = pendingIssueChange.get(telegramUserId);
    if (pendingIssueEdit) {
      await sendReplyWithRetry(
        ctx,
        ['У вас уже есть активный шаг редактирования варианта.', 'Что именно в этом варианте нужно изменить?'].join('\n'),
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'start_resume'
        }
      );
      return true;
    }

    const pendingDraftEdit = pendingDraftAgreementChange.get(telegramUserId);
    if (pendingDraftEdit) {
      await sendReplyWithRetry(
        ctx,
        ['У вас уже есть активный шаг изменения договорённости.', 'Что именно нужно изменить?'].join('\n'),
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'start_resume'
        }
      );
      return true;
    }

    const lastSession = lastSessionByUser.get(telegramUserId);
    if (lastSession) {
      await sendReplyWithRetry(
        ctx,
        'У вас уже есть активный сценарий. Показываю текущий статус.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'start_resume'
        }
      );
      await describeSessionForUser(ctx, lastSession, telegramUserId);
      return true;
    }

    // Last resort: find any conversation state in DB to recover session after restart
    const anyState = await conversationStateRepository.findActiveByUser(telegramUserId);
    if (anyState && (!targetSessionId || anyState.sessionId === targetSessionId)) {
      await describeSessionForUser(ctx, anyState.sessionId, telegramUserId);
      return true;
    }

    return false;
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
          'Вы подключились к договорённости.',
          'Дальше: нажмите «Подтвердить участие».'
        ].join('\n'),
        {
          correlation_id: correlationId,
          action_type: actionType
        },
        { reply_markup: consentKeyboard(result.session_id) }
      );

      if (result.state === SessionStates.CONSENT_PENDING) {
        const session = await gateway.getSessionStatus(result.session_id, telegramUserId);
        const creator = session.participants.find((participant) => participant.role === ParticipantRoles.PARTY_A);
        if (creator) {
          try {
            await gateway.giveConsent(
              {
                correlation_id: `tg:auto_consent:${result.session_id}:${creator.telegramUserId}`,
                channel: 'TELEGRAM',
                idempotency_key: `tg:auto_consent:${result.session_id}:${creator.telegramUserId}`,
                action_type: 'auto_give_consent_creator',
                case_id: result.session_id,
                participant_id: creator.telegramUserId,
                payload: { session_id: result.session_id, actor: 'creator_auto' }
              },
              result.session_id,
              creator.telegramUserId
            );
          } catch (error) {
            if (!(error instanceof DomainError && error.code === 'CONSENT_ALREADY_GRANTED')) {
              throw error;
            }
          }
        }
        for (const participant of session.participants) {
          if (participant.telegramUserId === telegramUserId) {
            continue;
          }
          await sendDirectWithRetry(
            participant.telegramUserId,
            ['Второй человек подключился.', 'Ждём, пока он подтвердит участие.'].join('\n'),
            {
              correlation_id: `tg:join_notify:${result.session_id}:${participant.telegramUserId}`,
              action_type: 'join_notify_creator'
            },
            { reply_markup: statusOnlyKeyboard(result.session_id) }
          );
        }
      }
    } catch (error) {
      if (error instanceof DomainError && error.code === 'DUPLICATE_JOIN') {
        await sendReplyWithRetry(
          ctx,
          ['Вы уже подключены.', 'Нужен второй человек. Отправьте ему приглашение.'].join('\n'),
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
  ): Promise<boolean> => {
    const correlationId = makeCorrelationId(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:action:${telegramUserId}`,
        limit: GENERAL_ACTION_LIMIT,
        action_type: 'create_session'
      }))
    ) {
      return false;
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
        .text('Если ссылка не сработает', 'invite:details')
        .row()
        .text('Посмотреть статус', `status:${result.session_id}`);

      const instructionText = ['Готово.', '', 'Отправьте следующее сообщение второму человеку 👇'].join('\n');
      const inviteText = [
        `${initiatorName} хочет обсудить с вами:`,
        `«${problemTopic}»`,
        '',
        'Нажмите на ссылку, чтобы подключиться:',
        deepLink ?? 'Не получилось создать ссылку в этом чате.'
      ].join('\n');

      await sendReplyWithRetry(
        ctx,
        instructionText,
        { correlation_id: correlationId, action_type: 'create_session_instruction' }
      );
      await sendReplyWithRetry(
        ctx,
        inviteText,
        { correlation_id: correlationId, action_type: 'create_session' },
        { reply_markup: keyboard }
      );
      return true;
    } catch (error) {
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: correlationId,
        action_type: 'create_session'
      });
      return false;
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
          ? ['Готово. Вы оба подтвердили участие.', 'Дальше: ответьте на несколько коротких вопросов отдельно.'].join('\n')
          : ['Вы подтвердили участие.', 'Ждём второго человека.'].join('\n');

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
          if (participant.telegramUserId === telegramUserId) {
            await askNextMediationIntakeQuestion(participant.telegramUserId, sessionId, 'current', ctx);
          } else {
            await askNextMediationIntakeQuestion(participant.telegramUserId, sessionId, 'direct');
          }
        }
      }
    } catch (error) {
      if (error instanceof DomainError && error.code === 'CONSENT_ALREADY_GRANTED') {
        const session = await gateway.getSessionStatus(sessionId, telegramUserId);
        const consentCount = session.participants.filter((participant) => Boolean(participant.consentGrantedAt)).length;
        const text =
          consentCount < 2
            ? ['Вы уже подтвердили участие.', 'Нужен второй человек. Отправьте ему приглашение.'].join('\n')
            : 'Вы уже подтвердили участие.';
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
    await logInboundEvent(ctx, 'command:start');
    const telegramUserId = userIdFromCtx(ctx);
    const args = parseArgs(ctx.message?.text);
    const joinPayload = args[0]?.startsWith('join_') ? args[0].slice(5) : null;

    if (joinPayload) {
      await joinWithToken(ctx, telegramUserId, joinPayload, 'start_join');
      return;
    }

    const hasAnyPendingState =
      pendingInput.has(telegramUserId) ||
      pendingCreateTopicDraft.has(telegramUserId) ||
      pendingMediationIntakeSession.has(telegramUserId) ||
      pendingMediationIntakeDraft.has(telegramUserId) ||
      pendingSynthesisClarificationSession.has(telegramUserId) ||
      pendingIssueChange.has(telegramUserId) ||
      pendingDraftAgreementChange.has(telegramUserId) ||
      lastSessionByUser.has(telegramUserId);
    // Always check DB so we don't miss sessions that only exist there
    const persistentIntake = await findActiveIntakeState(telegramUserId);
    if (hasAnyPendingState || persistentIntake) {
      const rawSessionIds = [
        pendingMediationIntakeSession.get(telegramUserId),
        pendingMediationIntakeDraft.get(telegramUserId)?.sessionId,
        pendingSynthesisClarificationSession.get(telegramUserId),
        pendingIssueChange.get(telegramUserId)?.sessionId,
        pendingDraftAgreementChange.get(telegramUserId)?.sessionId,
        persistentIntake?.sessionId,
        lastSessionByUser.get(telegramUserId),
      ].filter((id): id is string => Boolean(id));
      const uniqueSessionIds = [...new Set(rawSessionIds)];

      const sessionInfos = await Promise.all(
        uniqueSessionIds.map(async (id) => {
          try {
            const session = await gateway.getSessionStatus(id, telegramUserId);
            return { id, topic: session.problemTopic ?? null };
          } catch {
            return { id, topic: null };
          }
        })
      );

      const messageText =
        sessionInfos.length === 1 && sessionInfos[0].topic
          ? `Есть незавершённая договорённость:\n«${sessionInfos[0].topic}»`
          : sessionInfos.length > 1
            ? 'Есть несколько незавершённых договорённостей.'
            : 'Есть незавершённая договорённость.';

      await sendReplyWithRetry(
        ctx,
        messageText,
        { correlation_id: makeCorrelationId(ctx), action_type: 'start_resume_prompt' },
        { reply_markup: buildResumeKeyboard(sessionInfos) }
      );
      return;
    }

    pendingInput.delete(telegramUserId);
    pendingCreateTopicDraft.delete(telegramUserId);
    pendingMediationIntakeSession.delete(telegramUserId);
    pendingMediationIntakeStep.delete(telegramUserId);
    pendingMediationIntakeDraft.delete(telegramUserId);
    pendingIssueChange.delete(telegramUserId);
    pendingDraftAgreementChange.delete(telegramUserId);
    await sendReplyWithRetry(
      ctx,
      [
        'Привет.',
        '',
        'Я помогаю двум людям спокойно договориться, если обсуждать напрямую сложно.',
        '',
        'Как это работает:',
        '— каждый из вас сначала пишет свою версию отдельно',
        '— я собираю общую картину',
        '— помогаю вам найти решение',
        '',
        'Ваши сообщения не пересылаются друг другу напрямую.'
      ].join('\n'),
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
    pendingCreateTopicDraft.delete(telegramUserId);
    await sendReplyWithRetry(
      ctx,
      'О чём хотите договориться? Опишите коротко.',
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
        'Отправьте ссылку-приглашение или токен.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'join_session_prompt'
        }
      );
      return;
    }

    const inviteToken = extractInviteToken(args[0]);
    if (!inviteToken) {
      await sendReplyWithRetry(ctx, 'Похоже, в приглашении ошибка. Попробуйте ещё раз или откройте ссылку', {
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

  bot.callbackQuery(/^menu:(begin|create|join|status)$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    const telegramUserId = userIdFromCtx(ctx);
    const action = ctx.match[1];

    if (action === 'begin') {
      await sendReplyWithRetry(
        ctx,
        'Что вы хотите сделать?',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'menu_begin'
        },
        { reply_markup: startKeyboard() }
      );
      return;
    }

    if (action === 'create') {
      pendingInput.set(telegramUserId, 'CREATE_TOPIC');
      pendingCreateTopicDraft.delete(telegramUserId);
      await sendReplyWithRetry(
        ctx,
        'О чём хотите договориться? Опишите коротко.',
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
        'Отправьте ссылку-приглашение или токен.',
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
      'У вас пока нет активной договорённости',
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'status_prompt'
      },
      { reply_markup: createOnlyKeyboard() }
    );
  });

  bot.callbackQuery(/^menu:resume(?::([A-Za-z0-9_-]+))?$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    const telegramUserId = userIdFromCtx(ctx);
    const targetSessionId = ctx.match[1] ?? undefined;
    try {
      if (!(await resumeActiveScenario(ctx, telegramUserId, targetSessionId))) {
        await sendReplyWithRetry(
          ctx,
          [
            'Привет.',
            '',
            'Я помогаю двум людям спокойно договориться, если обсуждать напрямую сложно.',
            '',
            'Как это работает:',
            '— каждый из вас сначала пишет свою версию отдельно',
            '— я собираю общую картину',
            '— помогаю вам найти решение',
            '',
            'Ваши сообщения не пересылаются друг другу напрямую.'
          ].join('\n'),
          { correlation_id: makeCorrelationId(ctx), action_type: 'start' },
          { reply_markup: startKeyboard() }
        );
      }
    } catch (error) {
      await replyWithMappedError(ctx, error, 'start_resume', 'menu:resume');
    }
  });

  bot.callbackQuery('menu:new', async (ctx) => {
    await safeAnswerCallback(ctx);
    const telegramUserId = userIdFromCtx(ctx);
    pendingInput.delete(telegramUserId);
    pendingCreateTopicDraft.delete(telegramUserId);
    pendingMediationIntakeSession.delete(telegramUserId);
    pendingMediationIntakeStep.delete(telegramUserId);
    pendingMediationIntakeDraft.delete(telegramUserId);
    pendingIssueChange.delete(telegramUserId);
    pendingDraftAgreementChange.delete(telegramUserId);
    lastSessionByUser.delete(telegramUserId);
    // Clear any intake conversation history for this user
    for (const key of intakeConversationHistory.keys()) {
      if (key.endsWith(`:${telegramUserId}`)) {
        intakeConversationHistory.delete(key);
      }
    }
    pendingInput.set(telegramUserId, 'CREATE_TOPIC');
    await sendReplyWithRetry(
      ctx,
      'О чём хотите договориться? Опишите коротко.',
      { correlation_id: makeCorrelationId(ctx), action_type: 'create_topic_prompt' }
    );
  });

  bot.callbackQuery(/^consent:([A-Za-z0-9_-]{3,})$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    await giveConsentFlow(ctx, ctx.match[1], userIdFromCtx(ctx), 'give_consent_button');
  });

  bot.callbackQuery(/^intake:edit:([A-Za-z0-9_-]{3,}):([a-z_]+)$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    const sessionId = ctx.match[1];
    const stepId = ctx.match[2] as MediationIntakeStepId;
    const telegramUserId = userIdFromCtx(ctx);
    if (!mediationStepById.has(stepId)) {
      await sendReplyWithRetry(ctx, 'Не могу найти этот шаг. Отправьте ответ ещё раз.', {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'mediation_intake_edit'
      });
      return;
    }
    pendingMediationIntakeSession.set(telegramUserId, sessionId);
    pendingMediationIntakeStep.set(telegramUserId, stepId);
    pendingMediationIntakeDraft.delete(telegramUserId);
    const progress = await gateway.getIntakeProgress(sessionId, telegramUserId);
    await upsertConversationState({
      sessionId,
      telegramUserId,
      currentStage: ConversationStages.INTAKE,
      currentQuestionKey: stepId,
      expectedInputType: ConversationExpectedInputTypes.TEXT,
      currentDraft: null,
      committedFields: committedConversationFields(progress.fields),
      pendingAction: null,
      lastEventId: ctx.update.update_id,
      lastInboundEvent: 'intake_edit',
      lastOutboundAction: 'mediation_intake_edit'
    });
    await sendReplyWithRetry(
      ctx,
      'Отправьте исправленный вариант.',
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'mediation_intake_edit'
      }
    );
  });

  bot.callbackQuery(/^intake:confirm:([A-Za-z0-9_-]{3,}):([a-z_]+)$/, async (ctx) => {
    await logInboundEvent(ctx, 'callback:intake_confirm');
    await safeAnswerCallback(ctx);
    const sessionId = ctx.match[1];
    const stepId = ctx.match[2] as MediationIntakeStepId;
    const telegramUserId = userIdFromCtx(ctx);
    const step = mediationStepById.get(stepId);
    const persistedConversationState = await conversationStateRepository.findBySessionAndUser(
      sessionId,
      telegramUserId
    );
    const currentIntakeSession = pendingMediationIntakeSession.get(telegramUserId) ?? null;
    const currentIntakeStep = pendingMediationIntakeStep.get(telegramUserId) ?? null;
    const draftFromMemory = pendingMediationIntakeDraft.get(telegramUserId);
    const sessionContext = await resolveSessionContext(ctx, telegramUserId);
    if (!step) {
      await sendReplyWithRetry(ctx, 'Не могу найти этот шаг. Отправьте ответ ещё раз.', {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'mediation_intake_confirm'
      });
      return;
    }

    const draftFromMemoryIsValid =
      Boolean(draftFromMemory) &&
      draftFromMemory?.sessionId === sessionId &&
      draftFromMemory?.stepId === stepId;
    const primaryField = step.writes[0] ?? 'facts';
    let beforeProgress: Awaited<ReturnType<ProtocolGatewayService['getIntakeProgress']>> | null = null;
    try {
      beforeProgress = await gateway.getIntakeProgress(sessionId, telegramUserId);
    } catch {
      beforeProgress = null;
    }

    const persistedStepBefore = beforeProgress ? findNextMediationIntakeStep(beforeProgress.fields)?.id ?? null : null;
    let draftValue: string | null = draftFromMemoryIsValid ? draftFromMemory!.text : null;
    if (!draftValue) {
      try {
        draftValue = await gateway.getLatestIntakeDraft(sessionId, telegramUserId, primaryField);
      } catch {
        draftValue = null;
      }
    }

    logger.info(
      {
        correlation_id: makeCorrelationId(ctx),
        session_id: sessionId,
        telegram_user_id: telegramUserId,
        role: sessionContext.role,
        current_ux_step: detectCurrentUxStep(telegramUserId),
        current_protocol_state: sessionContext.protocol_state,
        intake_step: stepId,
        current_intake_session: currentIntakeSession,
        current_intake_step: currentIntakeStep,
        persisted_conversation_stage: persistedConversationState?.currentStage ?? null,
        persisted_expected_input_type: persistedConversationState?.expectedInputType ?? null,
        persisted_current_question_key: persistedConversationState?.currentQuestionKey ?? null,
        draft_present: Boolean(draftValue),
        draft_value: draftValue,
        persisted_intake_step_before: persistedStepBefore,
        persisted_step_completed_before: beforeProgress
          ? step.writes.every((field) => {
              const entry = beforeProgress!.fields[field];
              return Boolean(entry.rawValue && entry.normalizedValue);
            })
          : null,
        next_step_attempted: null,
        branch: draftFromMemoryIsValid ? 'memory_draft' : 'persisted_draft_lookup',
        error_code: null
      },
      'telegram.intake.confirm.trace'
    );

    if (
      persistedConversationState &&
      (persistedConversationState.currentStage !== ConversationStages.INTAKE ||
        persistedConversationState.expectedInputType !== ConversationExpectedInputTypes.CONFIRM ||
        persistedConversationState.currentQuestionKey !== stepId)
    ) {
      const progress = await gateway.getIntakeProgress(sessionId, telegramUserId);
      const liveStep = findNextMediationIntakeStep(progress.fields);
      if (liveStep) {
        await upsertConversationState({
          sessionId,
          telegramUserId,
          currentStage: ConversationStages.INTAKE,
          currentQuestionKey: liveStep.id,
          expectedInputType: ConversationExpectedInputTypes.TEXT,
          currentDraft: null,
          committedFields: committedConversationFields(progress.fields),
          pendingAction: null,
          lastEventId: ctx.update.update_id,
          lastErrorCode: 'STALE_CONFIRM_CALLBACK',
          lastInboundEvent: 'intake_confirm',
          lastOutboundAction: 'mediation_intake_question'
        });
      }
      await sendReplyWithRetry(
        ctx,
        'Это старое подтверждение. Продолжаем с актуального шага.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'mediation_intake_confirm'
        }
      );
      await askNextMediationIntakeQuestion(telegramUserId, sessionId, 'current', ctx);
      return;
    }

    if (!draftValue) {
      const alreadyCompleted = beforeProgress
        ? step.writes.every((field) => {
            const entry = beforeProgress!.fields[field];
            return Boolean(entry.rawValue && entry.normalizedValue);
          })
        : false;
      if (alreadyCompleted) {
        await sendReplyWithRetry(
          ctx,
          'Этот ответ уже подтверждён.',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'mediation_intake_confirm'
          }
        );
        await askNextMediationIntakeQuestion(telegramUserId, sessionId, 'current', ctx);
        return;
      }
      pendingMediationIntakeSession.set(telegramUserId, sessionId);
      pendingMediationIntakeStep.set(telegramUserId, stepId);
      pendingMediationIntakeDraft.delete(telegramUserId);
      await upsertConversationState({
        sessionId,
        telegramUserId,
        currentStage: ConversationStages.INTAKE,
        currentQuestionKey: stepId,
        expectedInputType: ConversationExpectedInputTypes.TEXT,
        currentDraft: null,
        committedFields: beforeProgress ? committedConversationFields(beforeProgress.fields) : [],
        pendingAction: null,
        lastEventId: ctx.update.update_id,
        lastErrorCode: 'DRAFT_MISSING',
        lastInboundEvent: 'intake_confirm',
        lastOutboundAction: 'mediation_intake_question'
      });
      await sendReplyWithRetry(
        ctx,
        'Кажется, шаг сбился. Давайте продолжим.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'mediation_intake_confirm'
        }
      );
      await sendReplyWithRetry(
        ctx,
        step.question,
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'mediation_intake_confirm'
        }
      );
      return;
    }

    try {
      const answers: StructuredIntakeAnswerInput[] = step.writes.map((field) => ({
        field,
        value: draftValue!
      }));
      if (step.id === 'acceptable_flexibility') {
        const progress = await gateway.getIntakeProgress(sessionId, telegramUserId);
        const hardConstraint = progress.fields.constraints.rawValue?.trim();
        if (hardConstraint) {
          answers.push({
            field: 'non_negotiables',
            value: hardConstraint
          });
        }
      }

      await gateway.submitIntakeAnswers(
        {
          correlation_id: makeCorrelationId(ctx),
          channel: 'TELEGRAM',
          idempotency_key: makeStableIntakeConfirmKey(sessionId, telegramUserId, step.id, draftValue!),
          action_type: 'mediation_intake_confirm',
          case_id: sessionId,
          participant_id: telegramUserId,
          payload: { session_id: sessionId, step_id: step.id, text: draftValue! }
        },
        sessionId,
        telegramUserId,
        answers
      );
      pendingMediationIntakeDraft.delete(telegramUserId);
      const afterProgress = await gateway.getIntakeProgress(sessionId, telegramUserId);
      const persistedStepAfter = findNextMediationIntakeStep(afterProgress.fields)?.id ?? null;
      logger.info(
        {
          correlation_id: makeCorrelationId(ctx),
          session_id: sessionId,
          telegram_user_id: telegramUserId,
          current_ux_step: detectCurrentUxStep(telegramUserId),
          current_protocol_state: sessionContext.protocol_state,
          intake_step: stepId,
          persisted_intake_step_before: persistedStepBefore,
          persisted_intake_step_after: persistedStepAfter,
          persisted_step_completed_after: step.writes.every((field) => {
            const entry = afterProgress.fields[field];
            return Boolean(entry.rawValue && entry.normalizedValue);
          }),
          draft_present: true,
          draft_value: draftValue!,
          next_step_attempted: persistedStepAfter,
          branch: 'confirm_committed',
          error_code: null
        },
        'telegram.intake.confirm.trace'
      );
      await askNextMediationIntakeQuestion(telegramUserId, sessionId, 'current', ctx);
    } catch (error) {
      const domainCode = error instanceof DomainError ? error.code : 'INTAKE_CONFIRM_FAILED';
      logger.warn(
        {
          correlation_id: makeCorrelationId(ctx),
          session_id: sessionId,
          telegram_user_id: telegramUserId,
          current_ux_step: detectCurrentUxStep(telegramUserId),
          current_protocol_state: sessionContext.protocol_state,
          intake_step: stepId,
          persisted_intake_step_before: persistedStepBefore,
          draft_present: Boolean(draftValue),
          draft_value: draftValue,
          next_step_attempted: null,
          branch: 'confirm_error',
          error_code: domainCode
        },
        'telegram.intake.confirm.trace'
      );
      pendingMediationIntakeSession.set(telegramUserId, sessionId);
      pendingMediationIntakeStep.set(telegramUserId, stepId);
      pendingMediationIntakeDraft.delete(telegramUserId);
      await upsertConversationState({
        sessionId,
        telegramUserId,
        currentStage: ConversationStages.INTAKE,
        currentQuestionKey: stepId,
        expectedInputType: ConversationExpectedInputTypes.TEXT,
        currentDraft: null,
        committedFields: beforeProgress ? committedConversationFields(beforeProgress.fields) : [],
        pendingAction: null,
        lastEventId: ctx.update.update_id,
        lastErrorCode: domainCode,
        lastInboundEvent: 'intake_confirm',
        lastOutboundAction: 'mediation_intake_question'
      });
      if (domainCode === 'INTAKE_VALIDATION_ERROR' && error instanceof Error && error.message) {
        await sendReplyWithRetry(
          ctx,
          error.message,
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'mediation_intake_confirm'
          }
        );
        await sendReplyWithRetry(
          ctx,
          step.question,
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'mediation_intake_confirm'
          }
        );
      } else {
        await sendReplyWithRetry(
          ctx,
          'Не получилось сохранить этот шаг. Давайте продолжим.',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'mediation_intake_confirm'
          }
        );
        await sendReplyWithRetry(
          ctx,
          step.question,
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'mediation_intake_confirm'
          }
        );
      }
    }
  });

  bot.callbackQuery(/^create_topic:(confirm_draft|rephrase)$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    const telegramUserId = userIdFromCtx(ctx);
    const action = ctx.match[1];
    const draft = pendingCreateTopicDraft.get(telegramUserId);

    if (!draft) {
      pendingInput.set(telegramUserId, 'CREATE_TOPIC');
      await sendReplyWithRetry(
        ctx,
        'О чём хотите договориться? Опишите коротко.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'create_topic_prompt'
        }
      );
      return;
    }

    if (action === 'rephrase') {
      pendingCreateTopicDraft.delete(telegramUserId);
      pendingInput.set(telegramUserId, 'CREATE_TOPIC');
      await sendReplyWithRetry(
        ctx,
        'Отправьте формулировку ещё раз.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'create_topic_rephrase'
        }
      );
      return;
    }

    const initiatorName = (ctx.from?.first_name ?? 'Кто-то').replace(/\s+/g, ' ').trim();
    const created = await createSessionFlow(ctx, telegramUserId, draft.topic, initiatorName || 'Кто-то');
    if (created) {
      pendingInput.delete(telegramUserId);
      pendingCreateTopicDraft.delete(telegramUserId);
    }
  });

  // Backward-compatible guard for stale callbacks from older UX versions.
  bot.callbackQuery(/^problem:(confirm|edit):([A-Za-z0-9_-]{3,})$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    const sessionId = ctx.match[2];
    const telegramUserId = userIdFromCtx(ctx);
    pendingMediationIntakeSession.set(telegramUserId, sessionId);
    pendingMediationIntakeStep.delete(telegramUserId);
    pendingMediationIntakeDraft.delete(telegramUserId);
    await sendReplyWithRetry(
      ctx,
      'Этот шаг устарел. Продолжаем по текущему сценарию.',
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'legacy_problem_callback'
      }
    );
    await askNextMediationIntakeQuestion(telegramUserId, sessionId, 'current', ctx);
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
        'Принял. Двигаемся к решению.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'synthesis_ack'
        }
      );
      await maybeStartIssueLoop(sessionId, telegramUserId, 'current', ctx);
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
      await maybeStartIssueLoop(sessionId, telegramUserId, 'current', ctx);
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
        'Отправьте это приглашение второму человеку:',
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

  bot.callbackQuery(
    /^issue:react:([A-Za-z0-9_-]{3,}):(\d+):([A-Z0-9_]+):(accept|reject|edit)$/,
    async (ctx) => {
      await safeAnswerCallback(ctx);
      const sessionId = ctx.match[1];
      const loopVersion = Number(ctx.match[2]);
      const optionId = ctx.match[3];
      const action = ctx.match[4];
      const telegramUserId = userIdFromCtx(ctx);

      if (action === 'edit') {
        pendingIssueChange.set(telegramUserId, { sessionId, loopVersion, optionId });
        await sendReplyWithRetry(
          ctx,
          'Что именно в этом варианте нужно изменить?',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'issue_reaction_edit_prompt'
          }
        );
        return;
      }

      const reactionType =
        action === 'accept' ? IssueReactionTypes.ACCEPT : IssueReactionTypes.REJECT;
      try {
        const summary = await gateway.submitIssueOptionReaction(
          {
            correlation_id: makeCorrelationId(ctx),
            channel: 'TELEGRAM',
            idempotency_key: makeKey(ctx, `issue_react_${loopVersion}_${optionId}_${action}`),
            action_type: 'issue_option_reaction',
            case_id: sessionId,
            participant_id: telegramUserId,
            payload: {
              session_id: sessionId,
              loop_version: loopVersion,
              option_id: optionId,
              reaction_type: reactionType
            }
          },
          {
            session_id: sessionId,
            telegram_user_id: telegramUserId,
            loop_version: loopVersion,
            option_id: optionId,
            reaction_type: reactionType
          }
        );

        const feedback =
          summary.status === 'WORKABLE_PATH_FOUND'
            ? 'Похоже, есть рабочий вариант. Зафиксировал реакцию.'
            : summary.status === 'NO_WORKABLE_PATH'
              ? 'Пока рабочий вариант не найден. Зафиксировал реакцию.'
              : 'Реакцию зафиксировал. Дальше ждём ответ второй стороны.';
        await sendReplyWithRetry(
          ctx,
          feedback,
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'issue_option_reaction'
          }
        );
        await maybeStartDraftAgreement(sessionId, telegramUserId);
      } catch (error) {
        await sendReplyWithRetry(
          ctx,
          mapTelegramErrorText(error),
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'issue_option_reaction'
          }
        );
      }
    }
  );

  bot.callbackQuery(
    /^agreement:respond:([A-Za-z0-9_-]{3,}):(\d+):(confirm|edit|reject)$/,
    async (ctx) => {
      await safeAnswerCallback(ctx);
      const sessionId = ctx.match[1];
      const draftVersion = Number(ctx.match[2]);
      const action = ctx.match[3];
      const telegramUserId = userIdFromCtx(ctx);

      if (action === 'edit') {
        pendingDraftAgreementChange.set(telegramUserId, { sessionId, draftVersion });
        await sendReplyWithRetry(
          ctx,
          'Что именно нужно изменить?',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'draft_agreement_edit_prompt'
          }
        );
        return;
      }

      const responseType =
        action === 'confirm' ? 'CONFIRM' : 'REJECT';

      try {
        const decision = await gateway.submitDraftAgreementResponse(
          {
            correlation_id: makeCorrelationId(ctx),
            channel: 'TELEGRAM',
            idempotency_key: makeKey(ctx, `draft_response_${draftVersion}_${action}`),
            action_type: 'draft_agreement_response',
            case_id: sessionId,
            participant_id: telegramUserId,
            payload: { session_id: sessionId, draft_version: draftVersion, action }
          },
          {
            session_id: sessionId,
            telegram_user_id: telegramUserId,
            draft_version: draftVersion,
            response_type: responseType
          }
        );

        const feedback =
          decision.outcome === 'AGREEMENT'
            ? 'Готово. Договорённость подтверждена обеими сторонами.'
            : decision.outcome === 'DEADLOCK'
              ? 'Пока договорённость не получилась. Зафиксировал, что стороны не пришли к варианту.'
              : decision.outcome === 'PARTIAL_AGREEMENT'
                ? 'Зафиксировал частичное согласие. Нужны уточнения по оставшимся пунктам.'
                : 'Зафиксировал ответ. Ждём вторую сторону.';
        await sendReplyWithRetry(
          ctx,
          feedback,
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'draft_agreement_response'
          }
        );
      } catch (error) {
        await sendReplyWithRetry(
          ctx,
          mapTelegramErrorText(error),
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'draft_agreement_response'
          }
        );
      }
    }
  );

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
        await maybeStartIssueLoop(pendingClarificationForSession, telegramUserId, 'current', ctx);
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

    const pendingIssueEdit = pendingIssueChange.get(telegramUserId);
    if (pendingIssueEdit) {
      const input = text.trim();
      if (!input) {
        await sendReplyWithRetry(
          ctx,
          'Что именно в этом варианте нужно изменить?',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'issue_reaction_edit'
          }
        );
        return;
      }
      try {
        const summary = await gateway.submitIssueOptionReaction(
          {
            correlation_id: makeCorrelationId(ctx),
            channel: 'TELEGRAM',
            idempotency_key: makeKey(
              ctx,
              `issue_react_edit_${pendingIssueEdit.loopVersion}_${pendingIssueEdit.optionId}`
            ),
            action_type: 'issue_option_reaction',
            case_id: pendingIssueEdit.sessionId,
            participant_id: telegramUserId,
            payload: {
              session_id: pendingIssueEdit.sessionId,
              loop_version: pendingIssueEdit.loopVersion,
              option_id: pendingIssueEdit.optionId,
              reaction_type: IssueReactionTypes.REQUEST_CHANGE
            }
          },
          {
            session_id: pendingIssueEdit.sessionId,
            telegram_user_id: telegramUserId,
            loop_version: pendingIssueEdit.loopVersion,
            option_id: pendingIssueEdit.optionId,
            reaction_type: IssueReactionTypes.REQUEST_CHANGE,
            change_request: input
          }
        );
        pendingIssueChange.delete(telegramUserId);
        const feedback =
          summary.status === 'WORKABLE_PATH_FOUND'
            ? 'Изменение зафиксировал. Похоже, рабочий вариант уже есть.'
            : 'Изменение зафиксировал. Ждём реакцию второй стороны.';
        await sendReplyWithRetry(
          ctx,
          feedback,
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'issue_reaction_edit'
          }
        );
        await maybeStartDraftAgreement(pendingIssueEdit.sessionId, telegramUserId);
      } catch (error) {
        await sendReplyWithRetry(
          ctx,
          mapTelegramErrorText(error),
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'issue_reaction_edit'
          }
        );
      }
      return;
    }

    const pendingDraftChange = pendingDraftAgreementChange.get(telegramUserId);
    if (pendingDraftChange) {
      const input = text.trim();
      if (!input) {
        await sendReplyWithRetry(
          ctx,
          'Что именно нужно изменить?',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'draft_agreement_edit'
          }
        );
        return;
      }

      try {
        await gateway.submitDraftAgreementResponse(
          {
            correlation_id: makeCorrelationId(ctx),
            channel: 'TELEGRAM',
            idempotency_key: makeKey(
              ctx,
              `draft_edit_${pendingDraftChange.draftVersion}`
            ),
            action_type: 'draft_agreement_response',
            case_id: pendingDraftChange.sessionId,
            participant_id: telegramUserId,
            payload: {
              session_id: pendingDraftChange.sessionId,
              draft_version: pendingDraftChange.draftVersion,
              response_type: 'REQUEST_CHANGE'
            }
          },
          {
            session_id: pendingDraftChange.sessionId,
            telegram_user_id: telegramUserId,
            draft_version: pendingDraftChange.draftVersion,
            response_type: 'REQUEST_CHANGE',
            change_request: input
          }
        );
        pendingDraftAgreementChange.delete(telegramUserId);

        const regenerated = await gateway.regenerateDraftAgreement(
          {
            correlation_id: makeCorrelationId(ctx),
            channel: 'TELEGRAM',
            idempotency_key: makeKey(
              ctx,
              `draft_regenerate_${pendingDraftChange.sessionId}`
            ),
            action_type: 'draft_agreement_regenerate',
            case_id: pendingDraftChange.sessionId,
            participant_id: telegramUserId,
            payload: { session_id: pendingDraftChange.sessionId }
          },
          pendingDraftChange.sessionId,
          telegramUserId
        );
        const session = await gateway.getSessionStatus(pendingDraftChange.sessionId, telegramUserId);
        for (const participant of session.participants) {
          await sendDirectWithRetry(
            participant.telegramUserId,
            renderDraftAgreement(regenerated),
            {
              correlation_id: `tg:draft_regenerated:${pendingDraftChange.sessionId}:${participant.telegramUserId}`,
              action_type: 'draft_agreement'
            },
            {
              reply_markup: draftAgreementKeyboard(
                pendingDraftChange.sessionId,
                regenerated.draft_version
              )
            }
          );
        }
      } catch (error) {
        await sendReplyWithRetry(
          ctx,
          mapTelegramErrorText(error),
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'draft_agreement_edit'
          }
        );
      }
      return;
    }

    const activeIntakeState = await findActiveIntakeState(telegramUserId);
    const pendingMediationSession = activeIntakeState?.sessionId ?? pendingMediationIntakeSession.get(telegramUserId);
    if (pendingMediationSession) {
      // If user types new text while in CONFIRM state, treat it as a corrected answer
      // and let it fall through to normal intake text processing below.
      const input = text.trim();
      if (!input) {
        const stepId =
          (activeIntakeState?.currentQuestionKey as MediationIntakeStepId | undefined) ??
          pendingMediationIntakeStep.get(telegramUserId);
        const question = stepId ? mediationStepById.get(stepId)?.question : null;
        await sendReplyWithRetry(
          ctx,
          question ?? 'Ответьте, пожалуйста, коротко на текущий вопрос.',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'mediation_intake_answer'
          }
        );
        return;
      }

      try {
        let stepId =
          (activeIntakeState?.currentQuestionKey as MediationIntakeStepId | undefined) ??
          pendingMediationIntakeStep.get(telegramUserId);
        if (!stepId) {
          const view = await gateway.getIntakeProgress(pendingMediationSession, telegramUserId);
          stepId = findNextMediationIntakeStep(view.fields)?.id;
        }

        if (!stepId) {
          await sendReplyWithRetry(
            ctx,
            'Готово. Я услышал вас.\nКак только второй участник завершит свою часть — мы пойдём дальше.',
            {
              correlation_id: makeCorrelationId(ctx),
              action_type: 'mediation_intake_answer'
            }
          );
          pendingMediationIntakeSession.delete(telegramUserId);
          pendingMediationIntakeStep.delete(telegramUserId);
          pendingMediationIntakeDraft.delete(telegramUserId);
          return;
        }

        // Conversational intake dialog
        const historyKey = `${pendingMediationSession}:${telegramUserId}`;
        const history = intakeConversationHistory.get(historyKey) ?? [];

        const intakeProgress = await gateway.getIntakeProgress(pendingMediationSession, telegramUserId);
        const collectedFields: Partial<Record<string, string>> = {};
        for (const [field, entry] of Object.entries(intakeProgress.fields)) {
          if ((entry as { rawValue: string | null }).rawValue) {
            collectedFields[field] = (entry as { rawValue: string }).rawValue;
          }
        }

        let topic = 'Договорённость';
        try {
          const sessionStatus = await gateway.getSessionStatus(pendingMediationSession, telegramUserId);
          topic = sessionStatus.problemTopic ?? topic;
        } catch { /* ignore */ }

        const dialogResult = await dialogManager.processTurn({
          topic,
          history,
          collectedFields,
          latestUserMessage: input
        });

        // Update history
        history.push({ role: 'user', text: input });
        history.push({ role: 'assistant', text: dialogResult.reply });
        intakeConversationHistory.set(historyKey, history);

        // Submit extracted fields
        if (Object.keys(dialogResult.extractedFields).length > 0) {
          const answers: StructuredIntakeAnswerInput[] = [];
          for (const [field, value] of Object.entries(dialogResult.extractedFields)) {
            if (value) answers.push({ field: field as IntakeField, value });
          }
          // Derive boundaries from constraints if not explicitly extracted
          if (dialogResult.extractedFields.constraints && !dialogResult.extractedFields.boundaries) {
            answers.push({ field: 'boundaries', value: dialogResult.extractedFields.constraints });
          }
          // Derive non_negotiables when complete
          if (dialogResult.isComplete) {
            const constraintVal = dialogResult.extractedFields.constraints
              ?? intakeProgress.fields.constraints?.rawValue?.trim()
              ?? null;
            if (constraintVal) {
              answers.push({ field: 'non_negotiables', value: constraintVal });
            }
          }
          const idempotencyKey = `tg:dialog_intake:${pendingMediationSession}:${telegramUserId}:${history.length}`;
          await gateway.submitIntakeAnswers(
            {
              correlation_id: makeCorrelationId(ctx),
              channel: 'TELEGRAM',
              idempotency_key: idempotencyKey,
              action_type: 'mediation_intake_confirm',
              case_id: pendingMediationSession,
              participant_id: telegramUserId,
              payload: { session_id: pendingMediationSession, text: input }
            },
            pendingMediationSession,
            telegramUserId,
            answers
          );
        }

        pendingMediationIntakeDraft.delete(telegramUserId);

        // Send dialog reply
        await sendReplyWithRetry(ctx, dialogResult.reply, {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'mediation_intake_answer'
        });

        // If complete, trigger completion check; otherwise update conversation state
        if (dialogResult.isComplete) {
          intakeConversationHistory.delete(historyKey);
          await askNextMediationIntakeQuestion(telegramUserId, pendingMediationSession, 'current', ctx);
        } else {
          // Update conversation state to reflect next expected step
          const updatedProgress = await gateway.getIntakeProgress(pendingMediationSession, telegramUserId);
          const nextStep = findNextMediationIntakeStep(updatedProgress.fields);
          if (nextStep) {
            pendingMediationIntakeSession.set(telegramUserId, pendingMediationSession);
            pendingMediationIntakeStep.set(telegramUserId, nextStep.id);
            await upsertConversationState({
              sessionId: pendingMediationSession,
              telegramUserId,
              currentStage: ConversationStages.INTAKE,
              currentQuestionKey: nextStep.id,
              expectedInputType: ConversationExpectedInputTypes.TEXT,
              currentDraft: null,
              committedFields: committedConversationFields(updatedProgress.fields),
              pendingAction: null,
              lastEventId: ctx.update.update_id,
              lastInboundEvent: 'intake_answer',
              lastOutboundAction: 'mediation_intake_answer'
            });
          }
        }
        return;
      } catch (error) {
        const validationMessage =
          error instanceof DomainError && error.code === 'INTAKE_VALIDATION_ERROR'
            ? 'Опишите чуть подробнее, что происходит'
            : mapTelegramErrorText(error);
        await sendReplyWithRetry(
          ctx,
          validationMessage,
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'mediation_intake_answer'
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
          'Тема должна быть короткой: до 120 символов. Попробуйте ещё раз.',
          {
            correlation_id: makeCorrelationId(ctx),
            action_type: 'create_topic_validate'
          }
        );
        return;
      }

      const initiatorName = (ctx.from?.first_name ?? 'Кто-то').replace(/\s+/g, ' ').trim();
      const created = await createSessionFlow(ctx, telegramUserId, topic, initiatorName || 'Кто-то');
      if (created) {
        pendingInput.delete(telegramUserId);
        pendingCreateTopicDraft.delete(telegramUserId);
      }
      return;
    }

    if (waiting === 'JOIN_TOKEN') {
      const tokenValue = extractInviteToken(text);
      if (!tokenValue) {
        await sendReplyWithRetry(ctx, 'Похоже, в приглашении ошибка. Попробуйте ещё раз или откройте ссылку', {
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

      await sendReplyWithRetry(ctx, 'Неизвестная команда. Нажмите /start и выберите действие.', {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'invalid_command'
      });
    }
  );

  bot.catch(async (err) => {
    const ctx = err.ctx;
    logger.error(
      {
        error: err.error instanceof Error ? err.error.message : String(err.error),
        update_id: ctx.update.update_id,
        telegram_user_id: userIdFromCtx(ctx)
      },
      'telegram.unhandled.error'
    );
    try {
      await ctx.reply('Что-то пошло не так. Нажмите /start, чтобы продолжить.');
    } catch {
      // ignore send failure
    }
  });

  return bot;
};
