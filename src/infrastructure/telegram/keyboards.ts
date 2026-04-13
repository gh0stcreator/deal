import { InlineKeyboard } from 'grammy';
import { MediationIntakeStepId } from './constants.js';

export const startKeyboard = () =>
  new InlineKeyboard()
    .text('Мои договорённости', 'menu:my-sessions')
    .row()
    .text('Создать новую', 'menu:create')
    .row()
    .text('Напомнить собеседнику', 'menu:remind');

export const consentKeyboard = (sessionId: string) =>
  new InlineKeyboard()
    .text('Подтвердить участие', `consent:${sessionId}`)
    .row()
    .text('Посмотреть статус', `status:${sessionId}`);

export const statusOnlyKeyboard = (sessionId: string) =>
  new InlineKeyboard().text('Посмотреть статус', `status:${sessionId}`);

export const createOnlyKeyboard = () =>
  new InlineKeyboard().text('Создать договорённость', 'menu:create');

export const truncateTopicLabel = (topic: string, max = 28): string =>
  topic.length > max ? `${topic.slice(0, max - 1)}…` : topic;

export const buildResumeKeyboard = (
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
  kb.text('Начать новую', 'menu:new').row();
  kb.text('Мои договорённости', 'menu:my-sessions');
  return kb;
};

export const createTopicDraftKeyboard = () =>
  new InlineKeyboard()
    .text('Да, верно', 'create_topic:confirm_draft')
    .row()
    .text('Хочу переформулировать', 'create_topic:rephrase');

export const synthesisFeedbackKeyboard = (sessionId: string) =>
  new InlineKeyboard()
    .text('Это похоже на правду', `synthesis:ok:${sessionId}`)
    .row()
    .text('Нет, нужно уточнить', `synthesis:clarify:${sessionId}`);

export const mediationIntakeConfirmationKeyboard = (
  sessionId: string,
  stepId: MediationIntakeStepId
) =>
  new InlineKeyboard()
    .text('Да, верно', `intake:confirm:${sessionId}:${stepId}`)
    .row()
    .text('Хочу поправить', `intake:edit:${sessionId}:${stepId}`);

export const issueOptionKeyboard = (sessionId: string, loopVersion: number, optionId: string) =>
  new InlineKeyboard()
    .text('Подходит', `issue:react:${sessionId}:${loopVersion}:${optionId}:accept`)
    .row()
    .text('Не подходит', `issue:react:${sessionId}:${loopVersion}:${optionId}:reject`)
    .row()
    .text('Хочу изменить', `issue:react:${sessionId}:${loopVersion}:${optionId}:edit`);

export const draftAgreementKeyboard = (sessionId: string, draftVersion: number) =>
  new InlineKeyboard()
    .text('Подтверждаю', `agreement:respond:${sessionId}:${draftVersion}:confirm`)
    .row()
    .text('Хочу изменить', `agreement:respond:${sessionId}:${draftVersion}:edit`)
    .row()
    .text('Не подходит', `agreement:respond:${sessionId}:${draftVersion}:reject`);
