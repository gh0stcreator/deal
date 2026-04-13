import { Bot } from 'grammy';
import { mapTelegramErrorText } from '../../transport/errorMapping.js';
import {
  mapIntakeStatusView,
  mapNegotiationRoundStatusView,
  mapProposalListView
} from '../../transport/viewMappers.js';
import { parseArgs, userIdFromCtx, makeCorrelationId, makeKey, variantValues, operationValues, extractInviteToken } from '../helpers.js';
import { GENERAL_ACTION_LIMIT } from '../constants.js';
import { renderIntake, renderProposalList, renderNegotiation } from '../renderers.js';
import { startKeyboard, buildResumeKeyboard } from '../keyboards.js';
import { sendReplyWithRetry, enforceRateLimit, requireArgCount } from '../transport.js';
import { findActiveIntakeState } from '../conversationState.js';
import { joinWithToken, giveConsentFlow } from '../flows/sessionFlow.js';
import { BotDeps } from '../botDeps.js';

export const registerCommandHandlers = (bot: Bot, deps: BotDeps): void => {
  bot.command('start', async (ctx) => {
    const telegramUserId = userIdFromCtx(ctx);
    const args = parseArgs(ctx.message?.text);
    const joinPayload = args[0]?.startsWith('join_') ? args[0].slice(5) : null;

    if (joinPayload) {
      await joinWithToken(ctx, telegramUserId, joinPayload, 'start_join', deps);
      return;
    }

    const hasAnyPendingState =
      deps.pendingInput.has(telegramUserId) ||
      deps.pendingCreateTopicDraft.has(telegramUserId) ||
      deps.pendingMediationIntakeSession.has(telegramUserId) ||
      deps.pendingMediationIntakeDraft.has(telegramUserId) ||
      deps.pendingSynthesisClarificationSession.has(telegramUserId) ||
      deps.pendingIssueChange.has(telegramUserId) ||
      deps.pendingDraftAgreementChange.has(telegramUserId) ||
      deps.lastSessionByUser.has(telegramUserId);
    // Always check DB so we don't miss sessions that only exist there
    const persistentIntake = await findActiveIntakeState(telegramUserId, deps);
    if (hasAnyPendingState || persistentIntake) {
      const rawSessionIds = [
        deps.pendingMediationIntakeSession.get(telegramUserId),
        deps.pendingMediationIntakeDraft.get(telegramUserId)?.sessionId,
        deps.pendingSynthesisClarificationSession.get(telegramUserId),
        deps.pendingIssueChange.get(telegramUserId)?.sessionId,
        deps.pendingDraftAgreementChange.get(telegramUserId)?.sessionId,
        persistentIntake?.sessionId,
        deps.lastSessionByUser.get(telegramUserId),
      ].filter((id): id is string => Boolean(id));
      const uniqueSessionIds = [...new Set(rawSessionIds)];

      const sessionInfos = await Promise.all(
        uniqueSessionIds.map(async (id) => {
          try {
            const session = await deps.gateway.getSessionStatus(id, telegramUserId);
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
        { reply_markup: buildResumeKeyboard(sessionInfos) },
        deps
      );
      return;
    }

    deps.pendingInput.delete(telegramUserId);
    deps.pendingCreateTopicDraft.delete(telegramUserId);
    deps.pendingMediationIntakeSession.delete(telegramUserId);
    deps.pendingMediationIntakeStep.delete(telegramUserId);
    deps.pendingMediationIntakeDraft.delete(telegramUserId);
    deps.pendingIssueChange.delete(telegramUserId);
    deps.pendingDraftAgreementChange.delete(telegramUserId);

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
      { reply_markup: startKeyboard() },
      deps
    );
  });

  bot.command('create_session', async (ctx) => {
    const telegramUserId = userIdFromCtx(ctx);
    deps.pendingInput.set(telegramUserId, 'CREATE_TOPIC');
    deps.pendingCreateTopicDraft.delete(telegramUserId);
    await sendReplyWithRetry(
      ctx,
      'О чём хотите договориться? Опишите коротко.',
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'create_topic_prompt'
      },
      undefined,
      deps
    );
  });

  bot.command('join_session', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    const telegramUserId = userIdFromCtx(ctx);
    if (args.length === 0) {
      deps.pendingInput.set(telegramUserId, 'JOIN_TOKEN');
      await sendReplyWithRetry(
        ctx,
        'Отправьте ссылку-приглашение или токен.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'join_session_prompt'
        },
        undefined,
        deps
      );
      return;
    }

    const inviteToken = extractInviteToken(args[0]);
    if (!inviteToken) {
      await sendReplyWithRetry(ctx, 'Похоже, в приглашении ошибка. Попробуйте ещё раз или откройте ссылку', {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'join_session'
      }, undefined, deps);
      return;
    }

    await joinWithToken(ctx, telegramUserId, inviteToken, 'join_session', deps);
  });

  bot.command('give_consent', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (!(await requireArgCount(ctx, args, 1, 'Usage: /give_consent <session_id>', 'give_consent', deps))) {
      return;
    }

    await giveConsentFlow(ctx, args[0], userIdFromCtx(ctx), 'give_consent', deps);
  });

  bot.command('resume_intake', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (!(await requireArgCount(ctx, args, 1, 'Usage: /resume_intake <session_id>', 'resume_intake', deps))) {
      return;
    }

    const telegramUserId = userIdFromCtx(ctx);
    const correlationId = makeCorrelationId(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:action:${telegramUserId}:${args[0]}`,
        limit: GENERAL_ACTION_LIMIT,
        action_type: 'resume_intake'
      }, deps))
    ) {
      return;
    }

    try {
      const intake = await deps.gateway.resumeIntake(
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
      }, undefined, deps);
    } catch (error) {
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: correlationId,
        action_type: 'resume_intake'
      }, undefined, deps);
    }
  });

  bot.command('confirm_summary', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (!(await requireArgCount(ctx, args, 1, 'Usage: /confirm_summary <session_id>', 'confirm_summary', deps))) {
      return;
    }

    const telegramUserId = userIdFromCtx(ctx);
    const correlationId = makeCorrelationId(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:action:${telegramUserId}:${args[0]}`,
        limit: GENERAL_ACTION_LIMIT,
        action_type: 'confirm_summary'
      }, deps))
    ) {
      return;
    }

    try {
      const intake = await deps.gateway.confirmSummary(
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
      }, undefined, deps);
    } catch (error) {
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: correlationId,
        action_type: 'confirm_summary'
      }, undefined, deps);
    }
  });

  bot.command('reopen_intake', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (!(await requireArgCount(ctx, args, 1, 'Usage: /reopen_intake <session_id>', 'reopen_intake', deps))) {
      return;
    }

    const telegramUserId = userIdFromCtx(ctx);
    const correlationId = makeCorrelationId(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:action:${telegramUserId}:${args[0]}`,
        limit: GENERAL_ACTION_LIMIT,
        action_type: 'reopen_intake'
      }, deps))
    ) {
      return;
    }

    try {
      const intake = await deps.gateway.reopenIntake(
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
      }, undefined, deps);
    } catch (error) {
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: correlationId,
        action_type: 'reopen_intake'
      }, undefined, deps);
    }
  });

  bot.command('generate_proposals', async (ctx) => {
    const args = parseArgs(ctx.message?.text);
    if (
      !(await requireArgCount(ctx, args, 1, 'Usage: /generate_proposals <session_id>', 'generate_proposals', deps))
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
      }, deps))
    ) {
      return;
    }

    try {
      const proposals = await deps.gateway.generateProposals(
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
      }, undefined, deps);
    } catch (error) {
      await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
        correlation_id: correlationId,
        action_type: 'generate_proposals'
      }, undefined, deps);
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
        'select_preferred',
        deps
      ))
    ) {
      return;
    }

    const correlationId = makeCorrelationId(ctx);
    if (!variantValues.includes(args[1] as (typeof variantValues)[number])) {
      await sendReplyWithRetry(
        ctx,
        'Invalid variant type.',
        { correlation_id: correlationId, action_type: 'select_preferred' },
        undefined,
        deps
      );
      return;
    }

    const telegramUserId = userIdFromCtx(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:action:${telegramUserId}:${args[0]}`,
        limit: GENERAL_ACTION_LIMIT,
        action_type: 'select_preferred'
      }, deps))
    ) {
      return;
    }

    try {
      await deps.gateway.selectPreferred(
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

      const status = await deps.gateway.getNegotiationStatus(args[0], telegramUserId);
      await sendReplyWithRetry(ctx, renderNegotiation(mapNegotiationRoundStatusView(status)), {
        correlation_id: correlationId,
        action_type: 'select_preferred'
      }, undefined, deps);
    } catch (error) {
      await sendReplyWithRetry(
        ctx,
        mapTelegramErrorText(error),
        { correlation_id: correlationId, action_type: 'select_preferred' },
        undefined,
        deps
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
        'accept_proposal',
        deps
      ))
    ) {
      return;
    }

    const correlationId = makeCorrelationId(ctx);
    if (!variantValues.includes(args[1] as (typeof variantValues)[number])) {
      await sendReplyWithRetry(
        ctx,
        'Invalid variant type.',
        { correlation_id: correlationId, action_type: 'accept_proposal' },
        undefined,
        deps
      );
      return;
    }

    const telegramUserId = userIdFromCtx(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:action:${telegramUserId}:${args[0]}`,
        limit: GENERAL_ACTION_LIMIT,
        action_type: 'accept_proposal'
      }, deps))
    ) {
      return;
    }

    try {
      await deps.gateway.acceptProposal(
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

      const status = await deps.gateway.getNegotiationStatus(args[0], telegramUserId);
      await sendReplyWithRetry(ctx, renderNegotiation(mapNegotiationRoundStatusView(status)), {
        correlation_id: correlationId,
        action_type: 'accept_proposal'
      }, undefined, deps);
    } catch (error) {
      await sendReplyWithRetry(
        ctx,
        mapTelegramErrorText(error),
        { correlation_id: correlationId, action_type: 'accept_proposal' },
        undefined,
        deps
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
        'reject_proposal',
        deps
      ))
    ) {
      return;
    }

    const correlationId = makeCorrelationId(ctx);
    if (!variantValues.includes(args[1] as (typeof variantValues)[number])) {
      await sendReplyWithRetry(
        ctx,
        'Invalid variant type.',
        { correlation_id: correlationId, action_type: 'reject_proposal' },
        undefined,
        deps
      );
      return;
    }

    const telegramUserId = userIdFromCtx(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:action:${telegramUserId}:${args[0]}`,
        limit: GENERAL_ACTION_LIMIT,
        action_type: 'reject_proposal'
      }, deps))
    ) {
      return;
    }

    try {
      await deps.gateway.rejectProposal(
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

      const status = await deps.gateway.getNegotiationStatus(args[0], telegramUserId);
      await sendReplyWithRetry(ctx, renderNegotiation(mapNegotiationRoundStatusView(status)), {
        correlation_id: correlationId,
        action_type: 'reject_proposal'
      }, undefined, deps);
    } catch (error) {
      await sendReplyWithRetry(
        ctx,
        mapTelegramErrorText(error),
        { correlation_id: correlationId, action_type: 'reject_proposal' },
        undefined,
        deps
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
        'suggest_edit',
        deps
      ))
    ) {
      return;
    }

    const correlationId = makeCorrelationId(ctx);
    if (!variantValues.includes(args[1] as (typeof variantValues)[number])) {
      await sendReplyWithRetry(
        ctx,
        'Invalid variant type.',
        { correlation_id: correlationId, action_type: 'suggest_edit' },
        undefined,
        deps
      );
      return;
    }

    if (!operationValues.includes(args[3] as (typeof operationValues)[number])) {
      await sendReplyWithRetry(
        ctx,
        'Invalid edit operation.',
        { correlation_id: correlationId, action_type: 'suggest_edit' },
        undefined,
        deps
      );
      return;
    }

    const telegramUserId = userIdFromCtx(ctx);
    if (
      !(await enforceRateLimit(ctx, {
        key: `tg:action:${telegramUserId}:${args[0]}`,
        limit: GENERAL_ACTION_LIMIT,
        action_type: 'suggest_edit'
      }, deps))
    ) {
      return;
    }

    const proposedValue = args.slice(4).join(' ') || null;

    try {
      await deps.gateway.suggestEdit(
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

      const status = await deps.gateway.getNegotiationStatus(args[0], telegramUserId);
      await sendReplyWithRetry(ctx, renderNegotiation(mapNegotiationRoundStatusView(status)), {
        correlation_id: correlationId,
        action_type: 'suggest_edit'
      }, undefined, deps);
    } catch (error) {
      await sendReplyWithRetry(
        ctx,
        mapTelegramErrorText(error),
        { correlation_id: correlationId, action_type: 'suggest_edit' },
        undefined,
        deps
      );
    }
  });
};
