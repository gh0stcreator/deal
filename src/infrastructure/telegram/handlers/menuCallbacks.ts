import { Bot, InlineKeyboard } from 'grammy';
import { userIdFromCtx, makeCorrelationId } from '../helpers.js';
import { startKeyboard, createOnlyKeyboard, truncateTopicLabel } from '../keyboards.js';
import { sendReplyWithRetry, safeAnswerCallback, replyWithMappedError } from '../transport.js';
import { describeSessionForUser, resumeActiveScenario } from '../flows/sessionFlow.js';
import { BotDeps } from '../botDeps.js';

const sessionStateLabel = (state: string): string => {
  switch (state) {
    case 'CREATED':
    case 'INVITED':
    case 'BOTH_JOINED':
    case 'CONSENT_PENDING':
      return 'ждём второго участника';
    case 'CONSENTED':
    case 'SIDE_A_INTAKE':
    case 'SIDE_B_INTAKE':
      return 'собираем информацию';
    case 'READY_FOR_SYNTHESIS':
    case 'SYNTHESIS_COMPLETED':
      return 'анализируем';
    case 'READY_FOR_PROPOSAL':
    case 'PROPOSALS_GENERATED':
    case 'NEGOTIATION_IN_PROGRESS':
    case 'AGREEMENT_REACHED':
      return 'переговоры';
    case 'PROPOSAL_READY':
    case 'NEGOTIATION':
    case 'AGREEMENT':
    case 'PARTIAL_AGREEMENT':
      return 'договорились';
    case 'DEADLOCK':
      return 'зашли в тупик';
    case 'ABANDONED':
      return 'прервана';
    default:
      return 'в процессе';
  }
};

export const registerMenuCallbacks = (bot: Bot, deps: BotDeps): void => {
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
        { reply_markup: startKeyboard() },
        deps
      );
      return;
    }

    if (action === 'create') {
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
      return;
    }

    if (action === 'join') {
      deps.pendingInput.set(telegramUserId, 'JOIN_TOKEN');
      await sendReplyWithRetry(
        ctx,
        'Отправьте ссылку-приглашение или токен.',
        {
          correlation_id: makeCorrelationId(ctx),
          action_type: 'join_prompt'
        },
        undefined,
        deps
      );
      return;
    }

    const lastSession = deps.lastSessionByUser.get(telegramUserId);
    if (lastSession) {
      await describeSessionForUser(ctx, lastSession, telegramUserId, deps);
      return;
    }

    await sendReplyWithRetry(
      ctx,
      'У вас пока нет активной договорённости',
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'status_prompt'
      },
      { reply_markup: createOnlyKeyboard() },
      deps
    );
  });

  bot.callbackQuery(/^menu:resume(?::([A-Za-z0-9_-]+))?$/, async (ctx) => {
    await safeAnswerCallback(ctx);
    const telegramUserId = userIdFromCtx(ctx);
    const targetSessionId = ctx.match[1] ?? undefined;
    try {
      if (!(await resumeActiveScenario(ctx, telegramUserId, deps, targetSessionId))) {
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
          { reply_markup: startKeyboard() },
          deps
        );
      }
    } catch (error) {
      await replyWithMappedError(ctx, error, 'start_resume', 'menu:resume', deps);
    }
  });

  bot.callbackQuery('menu:my-sessions', async (ctx) => {
    await safeAnswerCallback(ctx);
    const telegramUserId = userIdFromCtx(ctx);
    try {
      const sessions = await deps.gateway.getUserSessions(telegramUserId);
      if (sessions.length === 0) {
        await sendReplyWithRetry(
          ctx,
          'У вас пока нет договорённостей.',
          { correlation_id: makeCorrelationId(ctx), action_type: 'my_sessions' },
          { reply_markup: new InlineKeyboard().text('Создать новую', 'menu:create') },
          deps
        );
        return;
      }
      const lines = sessions.map((s, i) => {
        const topic = s.topic ? `«${truncateTopicLabel(s.topic, 40)}»` : 'без темы';
        const status = sessionStateLabel(s.state);
        return `${i + 1}. ${topic} — ${status}`;
      });
      await sendReplyWithRetry(
        ctx,
        ['Ваши договорённости:', '', ...lines].join('\n'),
        { correlation_id: makeCorrelationId(ctx), action_type: 'my_sessions' },
        undefined,
        deps
      );
    } catch (error) {
      await replyWithMappedError(ctx, error, 'my_sessions', 'menu:my-sessions', deps);
    }
  });

  bot.callbackQuery('menu:new', async (ctx) => {
    await safeAnswerCallback(ctx);
    const telegramUserId = userIdFromCtx(ctx);
    deps.pendingInput.delete(telegramUserId);
    deps.pendingCreateTopicDraft.delete(telegramUserId);
    deps.pendingMediationIntakeSession.delete(telegramUserId);
    deps.pendingMediationIntakeStep.delete(telegramUserId);
    deps.pendingMediationIntakeDraft.delete(telegramUserId);
    deps.pendingIssueChange.delete(telegramUserId);
    deps.pendingDraftAgreementChange.delete(telegramUserId);
    deps.lastSessionByUser.delete(telegramUserId);
    // Clear any intake conversation history for this user
    for (const key of deps.intakeConversationHistory.keys()) {
      if (key.endsWith(`:${telegramUserId}`)) {
        deps.intakeConversationHistory.delete(key);
      }
    }
    deps.pendingInput.set(telegramUserId, 'CREATE_TOPIC');
    await sendReplyWithRetry(
      ctx,
      'О чём хотите договориться? Опишите коротко.',
      { correlation_id: makeCorrelationId(ctx), action_type: 'create_topic_prompt' },
      undefined,
      deps
    );
  });
};
