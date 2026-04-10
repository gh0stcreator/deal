import { Bot, Context } from 'grammy';
import { SystemClock } from '../../application/ports/Clock.js';
import { AppLogger, createNoopLogger } from '../../application/ports/AppLogger.js';
import { ProtocolGatewayService } from '../../application/services/ProtocolGatewayService.js';
import { SuggestEditOperations } from '../../domain/negotiation/types.js';
import { ProposalVariantTypes } from '../../domain/proposal/types.js';
import { mapTelegramErrorText } from '../transport/errorMapping.js';
import { InMemoryRateLimiter } from '../transport/rateLimiter.js';
import {
  mapIntakeStatusView,
  mapNegotiationRoundStatusView,
  mapProposalListView,
  mapSessionStatusView
} from '../transport/viewMappers.js';

const RATE_LIMIT_WINDOW_MS = 60_000;
const GENERAL_ACTION_LIMIT = 30;
const JOIN_ATTEMPT_LIMIT = 8;
const INVALID_COMMAND_LIMIT = 10;

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

const renderSession = (session: ReturnType<typeof mapSessionStatusView>) =>
  [
    `session: ${session.session_id}`,
    `state: ${session.state}`,
    `participants: ${session.participant_count}/2`,
    `consents: ${session.consent_count}/2`
  ].join('\n');

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
  return description.includes('timeout') || description.includes('temporarily') || description.includes('network');
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
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const sendReplyWithRetry = async (
    ctx: Context,
    text: string,
    metadata: { correlation_id: string; action_type: string }
  ): Promise<boolean> => {
    for (let attempt = 1; attempt <= maxSendAttempts; attempt += 1) {
      try {
        await ctx.reply(text);
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
      await sendReplyWithRetry(ctx, usage, {
        correlation_id: makeCorrelationId(ctx),
        action_type: actionType
      });
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
      `Rate limit exceeded. Retry in ~${decision.retry_after_seconds}s.`,
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

  const bot = new Bot(token);

  bot.command('start', async (ctx) => {
    await sendReplyWithRetry(
      ctx,
      [
        'Ladno protocol commands:',
        '/create_session',
        '/join_session <invite_token>',
        '/give_consent <session_id>',
        '/resume_intake <session_id>',
        '/confirm_summary <session_id>',
        '/reopen_intake <session_id>',
        '/generate_proposals <session_id>',
        '/select_preferred <session_id> <BALANCED|A_LEANING|B_LEANING>',
        '/accept_proposal <session_id> <BALANCED|A_LEANING|B_LEANING>',
        '/reject_proposal <session_id> <BALANCED|A_LEANING|B_LEANING>',
        '/suggest_edit <session_id> <variant> <clause_id> <operation> [proposed_value]'
      ].join('\n'),
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'start'
      }
    );
  });

  bot.command('create_session', async (ctx) => {
    const telegramUserId = userIdFromCtx(ctx);
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
          payload: { command: 'create_session' }
        },
        telegramUserId
      );

      await sendReplyWithRetry(
        ctx,
        `Session created: ${result.session_id}\nstate: ${result.state}\ninvite_token: ${result.invite_token}`,
        { correlation_id: correlationId, action_type: 'create_session' }
      );
    } catch (error) {
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: correlationId,
        action_type: 'create_session'
      });
    }
  });

  bot.command('join_session', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (!(await requireArgCount(ctx, args, 1, 'Usage: /join_session <invite_token>', 'join_session'))) {
      return;
    }

    const telegramUserId = userIdFromCtx(ctx);
    const correlationId = makeCorrelationId(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:join:${telegramUserId}`,
        limit: JOIN_ATTEMPT_LIMIT,
        action_type: 'join_session'
      }))
    ) {
      return;
    }

    try {
      const result = await gateway.joinSession(
        {
          correlation_id: correlationId,
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'join_session'),
          action_type: 'join_session',
          case_id: null,
          participant_id: telegramUserId,
          payload: { invite_token: args[0] }
        },
        telegramUserId,
        args[0]
      );

      await sendReplyWithRetry(ctx, `Joined session ${result.session_id}\nstate: ${result.state}`, {
        correlation_id: correlationId,
        action_type: 'join_session'
      });
    } catch (error) {
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: correlationId,
        action_type: 'join_session'
      });
    }
  });

  bot.command('give_consent', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (!(await requireArgCount(ctx, args, 1, 'Usage: /give_consent <session_id>', 'give_consent'))) {
      return;
    }

    const telegramUserId = userIdFromCtx(ctx);
    const correlationId = makeCorrelationId(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:action:${telegramUserId}:${args[0]}`,
        limit: GENERAL_ACTION_LIMIT,
        action_type: 'give_consent'
      }))
    ) {
      return;
    }

    try {
      const result = await gateway.giveConsent(
        {
          correlation_id: correlationId,
          channel: 'TELEGRAM',
          idempotency_key: makeKey(ctx, 'give_consent'),
          action_type: 'give_consent',
          case_id: args[0],
          participant_id: telegramUserId,
          payload: { session_id: args[0] }
        },
        args[0],
        telegramUserId
      );

      const session = await gateway.getSessionStatus(args[0], telegramUserId);
      await sendReplyWithRetry(
        ctx,
        [`consent: ${result.state}`, renderSession(mapSessionStatusView(session))].join('\n'),
        { correlation_id: correlationId, action_type: 'give_consent' }
      );
    } catch (error) {
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: correlationId,
        action_type: 'give_consent'
      });
    }
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
      await sendReplyWithRetry(ctx, 'Invalid variant type.', {
        correlation_id: correlationId,
        action_type: 'select_preferred'
      });
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
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: correlationId,
        action_type: 'select_preferred'
      });
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
      await sendReplyWithRetry(ctx, 'Invalid variant type.', {
        correlation_id: correlationId,
        action_type: 'accept_proposal'
      });
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
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: correlationId,
        action_type: 'accept_proposal'
      });
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
      await sendReplyWithRetry(ctx, 'Invalid variant type.', {
        correlation_id: correlationId,
        action_type: 'reject_proposal'
      });
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
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: correlationId,
        action_type: 'reject_proposal'
      });
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
      await sendReplyWithRetry(ctx, 'Invalid variant type.', {
        correlation_id: correlationId,
        action_type: 'suggest_edit'
      });
      return;
    }

    if (!operationValues.includes(args[3] as (typeof operationValues)[number])) {
      await sendReplyWithRetry(ctx, 'Invalid edit operation.', {
        correlation_id: correlationId,
        action_type: 'suggest_edit'
      });
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
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: correlationId,
        action_type: 'suggest_edit'
      });
    }
  });

  bot.hears(/^\/(?!start$|create_session$|join_session$|give_consent$|resume_intake$|confirm_summary$|reopen_intake$|generate_proposals$|select_preferred$|accept_proposal$|reject_proposal$|suggest_edit$)[a-z_]+$/, async (ctx) => {
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

    await sendReplyWithRetry(ctx, 'Unknown command. Use /start to see supported commands.', {
      correlation_id: makeCorrelationId(ctx),
      action_type: 'invalid_command'
    });
  });

  return bot;
};
