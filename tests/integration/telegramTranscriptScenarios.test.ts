import { describe, expect, it } from 'vitest';
import { loadTranscriptFromFile } from './support/replayTranscriptFromFile.js';
import {
  createTelegramTranscriptHarness,
  TelegramTranscriptHarness
} from './support/telegramTranscriptHarness.js';

const parseSessionId = (harness: TelegramTranscriptHarness): string => {
  for (let i = harness.sentMessages.length - 1; i >= 0; i -= 1) {
    const match = harness.sentMessages[i].replyMarkupJson.match(/status:([A-Za-z0-9_-]{3,})/);
    if (match) {
      return match[1];
    }
  }
  throw new Error('Session id not found in sent messages');
};

const completeTopicAndJoin = async (
  harness: TelegramTranscriptHarness
): Promise<{ sessionId: string; inviteToken: string }> => {
  await harness.runStep(
    { type: 'command', updateId: 1, userId: 101, text: '/start' },
    { textIncludes: ['Привет.', 'Готовы начать?'] }
  );
  await harness.runStep(
    { type: 'callback', updateId: 2, userId: 101, data: 'menu:begin' },
    { textIncludes: ['Что вы хотите сделать?'] }
  );
  await harness.runStep(
    { type: 'callback', updateId: 3, userId: 101, data: 'menu:create' },
    { textIncludes: ['О чём хотите договориться?'], uxStep: 'CREATE_TOPIC_INPUT_PENDING' }
  );
  await harness.runStep(
    { type: 'text', updateId: 4, userId: 101, text: 'График утренней ванной' },
    { textIncludes: ['Я понял так:', 'Это то, что вы хотите обсудить?'], uxStep: 'CREATE_TOPIC_CONFIRMATION_PENDING' }
  );
  await harness.runStep(
    { type: 'callback', updateId: 5, userId: 101, data: 'create_topic:confirm_draft' },
    { textIncludes: ['Нажмите на ссылку, чтобы подключиться:'], buttonsInclude: ['invite:details', 'status:'] }
  );

  const inviteToken = harness.extractLastInviteToken();
  await harness.runStep(
    { type: 'command', updateId: 6, userId: 102, text: `/start join_${inviteToken}` },
    { textIncludes: ['Вы подключились к договорённости.'] }
  );

  return { sessionId: parseSessionId(harness), inviteToken };
};

const confirmBothSides = async (harness: TelegramTranscriptHarness, sessionId: string) => {
  await harness.runStep(
    { type: 'callback', updateId: 7, userId: 102, data: `consent:${sessionId}` },
    { textIncludes: ['Что конкретно сейчас происходит?'] }
  );
};

const answerAndConfirmOneIntakeStep = async (
  harness: TelegramTranscriptHarness,
  userId: number,
  sessionId: string,
  stepId: string,
  text: string,
  updateBase: number
) => {
  await harness.runStep(
    { type: 'text', updateId: updateBase, userId, text },
    { textIncludes: ['Я понял правильно?'], uxStep: 'INTAKE_CONFIRMATION_PENDING' }
  );
  await harness.runStep(
    { type: 'callback', updateId: updateBase + 1, userId, data: `intake:confirm:${sessionId}:${stepId}` },
    { textIncludes: ['Принято. Идём дальше.'] }
  );
};

const completeStructuredIntakeForUser = async (
  harness: TelegramTranscriptHarness,
  userId: number,
  sessionId: string,
  seed: string,
  updateBase: number
) => {
  const steps: Array<{ stepId: string; text: string }> = [
    { stepId: 'situation_facts', text: `Сейчас происходит спор по расписанию ${seed}` },
    { stepId: 'tension_point', text: `Больше всего напрягает хаос ${seed}` },
    { stepId: 'important_need_or_interest', text: `Важно предсказуемое утро ${seed}` },
    { stepId: 'hard_constraint', text: `Не подойдут внезапные переносы ${seed}` },
    { stepId: 'desired_outcome', text: `Нормальный исход: понятный график ${seed}` },
    { stepId: 'acceptable_flexibility', text: `Готов обсудить сдвиг на 10 минут ${seed}` }
  ];

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    await answerAndConfirmOneIntakeStep(
      harness,
      userId,
      sessionId,
      step.stepId,
      step.text,
      updateBase + i * 2
    );
  }
};

describe('telegram transcript-driven scenarios', () => {
  it('first /start shows welcome and begin action', async () => {
    const harness = await createTelegramTranscriptHarness();
    await harness.runStep(
      { type: 'command', updateId: 200, userId: 101, text: '/start' },
      { textIncludes: ['Привет.', 'Готовы начать?'], buttonsInclude: ['menu:begin'], uxStep: 'IDLE', protocolState: null }
    );
  });

  it('repeated /start during active flow resumes instead of duplicating welcome', async () => {
    const harness = await createTelegramTranscriptHarness();
    await harness.runStep({ type: 'command', updateId: 201, userId: 101, text: '/start' });
    await harness.runStep({ type: 'callback', updateId: 202, userId: 101, data: 'menu:begin' });
    await harness.runStep(
      { type: 'callback', updateId: 203, userId: 101, data: 'menu:create' },
      { uxStep: 'CREATE_TOPIC_INPUT_PENDING' }
    );
    await harness.runStep(
      { type: 'command', updateId: 204, userId: 101, text: '/start' },
      { textIncludes: ['У вас уже есть активный сценарий.'], uxStep: 'CREATE_TOPIC_INPUT_PENDING' }
    );
  });

  it('create + topic + confirm produces invite message with expected actions', async () => {
    const harness = await createTelegramTranscriptHarness();
    await completeTopicAndJoin(harness);
    const sessionId = parseSessionId(harness);
    expect(sessionId.length).toBeGreaterThan(2);
  });

  it('topic rephrase path loops safely', async () => {
    const harness = await createTelegramTranscriptHarness();
    await harness.runStep({ type: 'command', updateId: 210, userId: 101, text: '/start' });
    await harness.runStep({ type: 'callback', updateId: 211, userId: 101, data: 'menu:begin' });
    await harness.runStep({ type: 'callback', updateId: 212, userId: 101, data: 'menu:create' });
    await harness.runStep({ type: 'text', updateId: 213, userId: 101, text: 'Тема для проверки' });
    await harness.runStep(
      { type: 'callback', updateId: 214, userId: 101, data: 'create_topic:rephrase' },
      { textIncludes: ['Отправьте формулировку ещё раз.'], uxStep: 'CREATE_TOPIC_INPUT_PENDING' }
    );
  });

  it('join + consent works for both roles', async () => {
    const harness = await createTelegramTranscriptHarness();
    const { sessionId } = await completeTopicAndJoin(harness);
    await confirmBothSides(harness, sessionId);
    const lastForCreator = harness.sentMessages
      .filter((entry) => entry.chatId === 101)
      .map((entry) => entry.text)
      .join('\n');
    expect(lastForCreator).toContain('Что конкретно сейчас происходит?');
  });

  it('intake happy path proceeds through sequential questions', async () => {
    const harness = await createTelegramTranscriptHarness();
    const { sessionId } = await completeTopicAndJoin(harness);
    await confirmBothSides(harness, sessionId);
    await answerAndConfirmOneIntakeStep(
      harness,
      101,
      sessionId,
      'situation_facts',
      'Сейчас спорим о графике ванной',
      220
    );
    const latestFor101 = harness.sentMessages.filter((entry) => entry.chatId === 101).at(-1);
    expect(latestFor101?.text).toContain('Что в этой ситуации больше всего напрягает?');
  });

  it('intake confirm path is idempotent on double callback and avoids generic fallback', async () => {
    const harness = await createTelegramTranscriptHarness();
    const { sessionId } = await completeTopicAndJoin(harness);
    await confirmBothSides(harness, sessionId);

    await harness.runStep({ type: 'text', updateId: 230, userId: 101, text: 'Сейчас конфликт из-за графика' });
    await harness.runStep({ type: 'callback', updateId: 231, userId: 101, data: `intake:confirm:${sessionId}:situation_facts` });
    await harness.runStep(
      { type: 'callback', updateId: 232, userId: 101, data: `intake:confirm:${sessionId}:situation_facts` },
      { textIncludes: ['Этот ответ уже подтверждён.'] }
    );

    const fullThread = harness.sentMessages
      .filter((entry) => entry.chatId === 101)
      .map((entry) => entry.text)
      .join('\n');
    expect(fullThread).not.toContain('Что-то пошло не так');
    expect(fullThread).not.toContain('Participant intake was not found');
  });

  it('synthesis review path appears after both intakes complete', async () => {
    const harness = await createTelegramTranscriptHarness();
    const { sessionId } = await completeTopicAndJoin(harness);
    await confirmBothSides(harness, sessionId);
    await completeStructuredIntakeForUser(harness, 101, sessionId, 'A', 240);
    await completeStructuredIntakeForUser(harness, 102, sessionId, 'B', 300);

    const for101 = harness.sentMessages.filter((entry) => entry.chatId === 101).map((entry) => entry.text).join('\n');
    expect(for101).toContain('Похоже, вы оба хотите...');
    expect(for101).toContain('Главная точка напряжения сейчас...');

    await harness.runStep(
      { type: 'callback', updateId: 380, userId: 101, data: `synthesis:ok:${sessionId}` },
      { textIncludes: ['Спасибо. Зафиксировал.'] }
    );
  });

  it('replays saved transcript fixture deterministically', async () => {
    const harness = await createTelegramTranscriptHarness();
    const transcript = await loadTranscriptFromFile(
      `${process.cwd()}/tests/fixtures/transcripts/create_topic_confirm.json`
    );
    await harness.replayTranscript(transcript);
    const latest = harness.sentMessages.at(-1);
    expect(latest?.text).toContain('Нажмите на ссылку, чтобы подключиться:');
  });
});
