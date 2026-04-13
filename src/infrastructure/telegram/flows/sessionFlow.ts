import { Context, InlineKeyboard } from 'grammy';
import { SessionStates, ParticipantRoles } from '../../../domain/session/types.js';
import { DomainError } from '../../../domain/session/errors.js';
import { mapTelegramErrorText } from '../../transport/errorMapping.js';
import { makeCorrelationId, makeKey, userIdFromCtx } from '../helpers.js';
import {
  consentKeyboard,
  statusOnlyKeyboard,
  startKeyboard,
  createTopicDraftKeyboard,
  buildResumeKeyboard,
  mediationIntakeConfirmationKeyboard
} from '../keyboards.js';
import { sendReplyWithRetry, sendDirectWithRetry, enforceRateLimit } from '../transport.js';
import { findActiveIntakeState } from '../conversationState.js';
import { askNextMediationIntakeQuestion } from './intakeFlow.js';
import { BotDeps } from '../botDeps.js';
import { GENERAL_ACTION_LIMIT, JOIN_ATTEMPT_LIMIT } from '../constants.js';

export const describeSessionForUser = async (
  ctx: Context,
  sessionId: string,
  telegramUserId: string,
  deps: BotDeps
): Promise<void> => {
  try {
    const session = await deps.gateway.getSessionStatus(sessionId, telegramUserId);
    deps.lastSessionByUser.set(telegramUserId, sessionId);
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
      showConsentAction ? { reply_markup: consentKeyboard(sessionId) } : undefined,
      deps
    );
  } catch (error) {
    await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
      correlation_id: makeCorrelationId(ctx),
      action_type: 'session_status'
    }, undefined, deps);
  }
};

export const resumeActiveScenario = async (
  ctx: Context,
  telegramUserId: string,
  deps: BotDeps,
  targetSessionId?: string
): Promise<boolean> => {
  const pendingJoin = deps.pendingInput.get(telegramUserId) === 'JOIN_TOKEN';
  if (pendingJoin) {
    await sendReplyWithRetry(
      ctx,
      ['У вас уже есть активный сценарий.', 'Отправьте ссылку-приглашение или токен.'].join('\n'),
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'start_resume'
      },
      undefined,
      deps
    );
    return true;
  }

  const pendingTopic = deps.pendingInput.get(telegramUserId) === 'CREATE_TOPIC';
  if (pendingTopic) {
    await sendReplyWithRetry(
      ctx,
      ['У вас уже есть активный сценарий.', 'О чём хотите договориться? Опишите коротко.'].join('\n'),
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'start_resume'
      },
      undefined,
      deps
    );
    return true;
  }

  const draftTopic = deps.pendingCreateTopicDraft.get(telegramUserId);
  if (draftTopic) {
    await sendReplyWithRetry(
      ctx,
      ['Продолжаем с текущего шага.', 'Проверьте формулировку и подтвердите или поправьте.'].join('\n'),
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'start_resume'
      },
      { reply_markup: createTopicDraftKeyboard() },
      deps
    );
    return true;
  }

  const tryGetSessionTopic = async (sessionId: string): Promise<string | null> => {
    try {
      const session = await deps.gateway.getSessionStatus(sessionId, telegramUserId);
      return session.problemTopic ?? null;
    } catch {
      return null;
    }
  };

  const persistentIntake = await (async () => {
    const state = await findActiveIntakeState(telegramUserId, deps);
    if (!state) return null;
    // If a specific session was requested, only resume that one
    if (targetSessionId && state.sessionId !== targetSessionId) return null;
    return state;
  })();
  if (persistentIntake) {
    const topic = await tryGetSessionTopic(persistentIntake.sessionId);
    const resumeText = topic ? `Продолжаем — тема «${topic}».` : 'Продолжаем с того места, где остановились.';
    await sendReplyWithRetry(
      ctx,
      resumeText,
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'start_resume'
      },
      undefined,
      deps
    );
    await askNextMediationIntakeQuestion(telegramUserId, persistentIntake.sessionId, 'current', deps, ctx);
    return true;
  }

  const pendingSessionId = deps.pendingMediationIntakeSession.get(telegramUserId);
  if (pendingSessionId) {
    const topic = await tryGetSessionTopic(pendingSessionId);
    const resumeText = topic ? `Продолжаем — тема «${topic}».` : 'Продолжаем с того места, где остановились.';
    await sendReplyWithRetry(
      ctx,
      resumeText,
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'start_resume'
      },
      undefined,
      deps
    );
    await askNextMediationIntakeQuestion(telegramUserId, pendingSessionId, 'current', deps, ctx);
    return true;
  }

  const intakeDraft = deps.pendingMediationIntakeDraft.get(telegramUserId);
  if (intakeDraft) {
    const topic = await tryGetSessionTopic(intakeDraft.sessionId);
    const contextPrefix = topic ? `Тема: «${topic}»` : null;
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
      { reply_markup: mediationIntakeConfirmationKeyboard(intakeDraft.sessionId, intakeDraft.stepId) },
      deps
    );
    return true;
  }

  const pendingClarificationSessionId = deps.pendingSynthesisClarificationSession.get(telegramUserId);
  if (pendingClarificationSessionId) {
    await sendReplyWithRetry(
      ctx,
      'Мы здесь остановились. Напишите что именно нужно поправить.',
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'start_resume'
      },
      undefined,
      deps
    );
    return true;
  }

  const pendingIssueEdit = deps.pendingIssueChange.get(telegramUserId);
  if (pendingIssueEdit) {
    await sendReplyWithRetry(
      ctx,
      ['У вас уже есть активный шаг редактирования варианта.', 'Что именно в этом варианте нужно изменить?'].join('\n'),
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'start_resume'
      },
      undefined,
      deps
    );
    return true;
  }

  const pendingDraftEdit = deps.pendingDraftAgreementChange.get(telegramUserId);
  if (pendingDraftEdit) {
    await sendReplyWithRetry(
      ctx,
      ['У вас уже есть активный шаг изменения договорённости.', 'Что именно нужно изменить?'].join('\n'),
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'start_resume'
      },
      undefined,
      deps
    );
    return true;
  }

  const lastSession = deps.lastSessionByUser.get(telegramUserId);
  if (lastSession) {
    await sendReplyWithRetry(
      ctx,
      'У вас уже есть активный сценарий. Показываю текущий статус.',
      {
        correlation_id: makeCorrelationId(ctx),
        action_type: 'start_resume'
      },
      undefined,
      deps
    );
    await describeSessionForUser(ctx, lastSession, telegramUserId, deps);
    return true;
  }

  // Last resort: find any conversation state in DB to recover session after restart
  const anyState = await deps.conversationStateRepository.findActiveByUser(telegramUserId);
  if (anyState && (!targetSessionId || anyState.sessionId === targetSessionId)) {
    await describeSessionForUser(ctx, anyState.sessionId, telegramUserId, deps);
    return true;
  }

  return false;
};

export const joinWithToken = async (
  ctx: Context,
  telegramUserId: string,
  inviteToken: string,
  actionType: string,
  deps: BotDeps
): Promise<void> => {
  const correlationId = makeCorrelationId(ctx);
  if (
    !(await enforceRateLimit(ctx, {
      key: `tg:join:${telegramUserId}`,
      limit: JOIN_ATTEMPT_LIMIT,
      action_type: actionType
    }, deps))
  ) {
    return;
  }

  await sendReplyWithRetry(ctx, 'Проверяю…', {
    correlation_id: correlationId,
    action_type: actionType
  }, undefined, deps);

  try {
    const result = await deps.gateway.joinSession(
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
    deps.pendingInput.delete(telegramUserId);
    deps.lastSessionByUser.set(telegramUserId, result.session_id);

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
      { reply_markup: consentKeyboard(result.session_id) },
      deps
    );

    if (result.state === SessionStates.CONSENT_PENDING) {
      const session = await deps.gateway.getSessionStatus(result.session_id, telegramUserId);
      const creator = session.participants.find((participant) => participant.role === ParticipantRoles.PARTY_A);
      if (creator) {
        try {
          await deps.gateway.giveConsent(
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
          { reply_markup: statusOnlyKeyboard(result.session_id) },
          deps
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
        },
        undefined,
        deps
      );
      return;
    }
    await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
      correlation_id: correlationId,
      action_type: actionType
    }, undefined, deps);
  }
};

export const createSessionFlow = async (
  ctx: Context,
  telegramUserId: string,
  problemTopic: string,
  initiatorName: string,
  deps: BotDeps
): Promise<boolean> => {
  const correlationId = makeCorrelationId(ctx);
  if (
    !(await enforceRateLimit(ctx, {
      key: `tg:action:${telegramUserId}`,
      limit: GENERAL_ACTION_LIMIT,
      action_type: 'create_session'
    }, deps))
  ) {
    return false;
  }

  try {
    const result = await deps.gateway.createSession(
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

    deps.lastSessionByUser.set(telegramUserId, result.session_id);
    const username = deps.bot.botInfo?.username ?? ctx.me;
    const deepLink = username
      ? `https://t.me/${username}?start=join_${result.invite_token}`
      : null;
    deps.lastInviteByUser.set(telegramUserId, {
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
      { correlation_id: correlationId, action_type: 'create_session_instruction' },
      undefined,
      deps
    );
    await sendReplyWithRetry(
      ctx,
      inviteText,
      { correlation_id: correlationId, action_type: 'create_session' },
      { reply_markup: keyboard },
      deps
    );
    return true;
  } catch (error) {
    await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
      correlation_id: correlationId,
      action_type: 'create_session'
    }, undefined, deps);
    return false;
  }
};

export const giveConsentFlow = async (
  ctx: Context,
  sessionId: string,
  telegramUserId: string,
  actionType: string,
  deps: BotDeps
): Promise<void> => {
  const correlationId = makeCorrelationId(ctx);
  if (
    !(await enforceRateLimit(ctx, {
      key: `tg:action:${telegramUserId}:${sessionId}`,
      limit: GENERAL_ACTION_LIMIT,
      action_type: 'give_consent'
    }, deps))
  ) {
    return;
  }

  await sendReplyWithRetry(ctx, 'Обрабатываю…', {
    correlation_id: correlationId,
    action_type: actionType
  }, undefined, deps);

  try {
    const result = await deps.gateway.giveConsent(
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
    deps.lastSessionByUser.set(telegramUserId, sessionId);
    const feedback =
      result.state === SessionStates.CONSENTED
        ? ['Готово. Вы оба подтвердили участие.', 'Дальше каждый расскажет о ситуации отдельно — своими словами.'].join('\n')
        : ['Вы подтвердили участие.', 'Ждём второго человека.'].join('\n');

    await sendReplyWithRetry(
      ctx,
      feedback,
      {
        correlation_id: correlationId,
        action_type: actionType
      },
      { reply_markup: new InlineKeyboard().text('Посмотреть статус', `status:${sessionId}`) },
      deps
    );

    if (result.state === SessionStates.CONSENTED) {
      const session = await deps.gateway.getSessionStatus(sessionId, telegramUserId);
      deps.problemSynthesisSent.delete(sessionId);
      for (const participant of session.participants) {
        if (participant.telegramUserId === telegramUserId) {
          await askNextMediationIntakeQuestion(participant.telegramUserId, sessionId, 'current', deps, ctx);
        } else {
          await askNextMediationIntakeQuestion(participant.telegramUserId, sessionId, 'direct', deps);
        }
      }
    }
  } catch (error) {
    if (error instanceof DomainError && error.code === 'CONSENT_ALREADY_GRANTED') {
      const session = await deps.gateway.getSessionStatus(sessionId, telegramUserId);
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
        { reply_markup: new InlineKeyboard().text('Посмотреть статус', `status:${sessionId}`) },
        deps
      );
      return;
    }
    await sendReplyWithRetry(ctx, mapTelegramErrorText(error), {
      correlation_id: correlationId,
      action_type: actionType
    }, undefined, deps);
  }
};
