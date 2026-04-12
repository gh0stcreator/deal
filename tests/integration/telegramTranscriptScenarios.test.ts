import { describe, expect, it } from 'vitest';
import { loadTranscriptFromFile } from './support/replayTranscriptFromFile.js';
import {
  createTelegramTranscriptHarness,
  StepExpectations,
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
    { textIncludes: ['Привет.'] }
  );
  await harness.runStep(
    { type: 'callback', updateId: 3, userId: 101, data: 'menu:create' },
    { textIncludes: ['О чём хотите договориться?'], uxStep: 'CREATE_TOPIC_INPUT_PENDING' }
  );
  await harness.runStep(
    { type: 'text', updateId: 4, userId: 101, text: 'График утренней ванной' },
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
    { textIncludes: ['Расскажите, что происходит.'] }
  );
};

const answerOneIntakeStep = async (
  harness: TelegramTranscriptHarness,
  userId: number,
  text: string,
  updateBase: number,
  expectation: StepExpectations = { uxStep: 'INTAKE_QUESTION_PENDING' }
) => {
  await harness.runStep(
    { type: 'text', updateId: updateBase, userId, text },
    expectation
  );
};

const completeStructuredIntakeForUser = async (
  harness: TelegramTranscriptHarness,
  userId: number,
  sessionId: string,
  seed: string,
  updateBase: number
) => {
  const texts = [
    `Сейчас происходит спор по расписанию ${seed}`,
    `Больше всего напрягает хаос ${seed}`,
    `Важно предсказуемое утро ${seed}`,
    `Не подойдут внезапные переносы ${seed}`,
    `Нормальный исход: понятный график ${seed}`,
    `Готов обсудить сдвиг на 10 минут ${seed}`
  ];

  for (let i = 0; i < texts.length; i += 1) {
    const isLastStep = i === texts.length - 1;
    await answerOneIntakeStep(
      harness,
      userId,
      texts[i],
      updateBase + i,
      isLastStep ? { uxStep: 'SESSION_ACTIVE' } : undefined
    );
  }
};

const completeSynthesisForBoth = async (harness: TelegramTranscriptHarness): Promise<string> => {
  const { sessionId } = await completeTopicAndJoin(harness);
  await confirmBothSides(harness, sessionId);
  await completeStructuredIntakeForUser(harness, 101, sessionId, 'A', 240);
  await completeStructuredIntakeForUser(harness, 102, sessionId, 'B', 300);
  return sessionId;
};

describe('telegram transcript-driven scenarios', () => {
  it('first /start shows welcome and begin action', async () => {
    const harness = await createTelegramTranscriptHarness();
    await harness.runStep(
      { type: 'command', updateId: 200, userId: 101, text: '/start' },
      { textIncludes: ['Привет.'], buttonsInclude: ['menu:create'], uxStep: 'IDLE', protocolState: null }
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
      { textIncludes: ['Есть незавершённая договорённость'], uxStep: 'CREATE_TOPIC_INPUT_PENDING' }
    );
  });

  it('create + topic + confirm produces invite message with expected actions', async () => {
    const harness = await createTelegramTranscriptHarness();
    await completeTopicAndJoin(harness);
    const sessionId = parseSessionId(harness);
    expect(sessionId.length).toBeGreaterThan(2);
  });

  it('topic input directly creates session without confirmation gate', async () => {
    const harness = await createTelegramTranscriptHarness();
    await harness.runStep({ type: 'command', updateId: 210, userId: 101, text: '/start' });
    await harness.runStep({ type: 'callback', updateId: 211, userId: 101, data: 'menu:begin' });
    await harness.runStep({ type: 'callback', updateId: 212, userId: 101, data: 'menu:create' });
    await harness.runStep(
      { type: 'text', updateId: 213, userId: 101, text: 'Тема для проверки' },
      { textIncludes: ['Нажмите на ссылку, чтобы подключиться:'] }
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
    expect(lastForCreator).toContain('Расскажите, что происходит.');
  });

  it('intake happy path proceeds through sequential questions', async () => {
    const harness = await createTelegramTranscriptHarness();
    const { sessionId } = await completeTopicAndJoin(harness);
    await confirmBothSides(harness, sessionId);
    await answerOneIntakeStep(harness, 101, 'Сейчас спорим о графике ванной', 220);
    const latestFor101 = harness.sentMessages.filter((entry) => entry.chatId === 101).at(-1);
    expect(latestFor101?.text).toContain('Что в этой ситуации задевает вас сильнее всего?');
  });

  it('intake auto-confirms and advances to tension step for natural phrase input', async () => {
    const harness = await createTelegramTranscriptHarness();
    const { sessionId } = await completeTopicAndJoin(harness);
    await confirmBothSides(harness, sessionId);

    await harness.runStep(
      { type: 'text', updateId: 233, userId: 101, text: 'хочу есть лень вставать' },
      { textIncludes: ['Что в этой ситуации задевает вас сильнее всего?'], uxStep: 'INTAKE_QUESTION_PENDING' }
    );

    const fullThread = harness.sentMessages
      .filter((entry) => entry.chatId === 101)
      .map((entry) => entry.text)
      .join('\n');
    expect(fullThread).not.toContain('Что-то пошло не так');
  });

  it('intake answer shows reflection then moves to next question without buttons', async () => {
    const harness = await createTelegramTranscriptHarness();
    const { sessionId } = await completeTopicAndJoin(harness);
    await confirmBothSides(harness, sessionId);

    await harness.runStep(
      { type: 'text', updateId: 235, userId: 101, text: 'Сейчас конфликт из-за графика' },
      { uxStep: 'INTAKE_QUESTION_PENDING' }
    );

    const fullThread = harness.sentMessages
      .filter((entry) => entry.chatId === 101)
      .map((entry) => entry.text)
      .join('\n');
    expect(fullThread).toContain('Я фиксирую ваш смысл');
    expect(fullThread).toContain('Что в этой ситуации задевает вас сильнее всего?');
    expect(fullThread).not.toContain('Что-то пошло не так');
  });

  it('intake answer is committed after single text message', async () => {
    const harness = await createTelegramTranscriptHarness();
    const { sessionId } = await completeTopicAndJoin(harness);
    await confirmBothSides(harness, sessionId);

    await harness.runStep(
      { type: 'text', updateId: 236, userId: 101, text: 'Ну, жена спит под тёплым одеялом и я тоже хочу под ним спать.' },
      { uxStep: 'INTAKE_QUESTION_PENDING' }
    );
    const afterState = await harness.conversationStateRepository.findBySessionAndUser(sessionId, '101');
    expect(afterState?.currentStage).toBe('INTAKE');
    expect(afterState?.currentQuestionKey).toBe('tension_point');
    expect(afterState?.expectedInputType).toBe('TEXT');
    expect(afterState?.committedFields).toContain('situation_facts');

    const fullThread = harness.sentMessages
      .filter((entry) => entry.chatId === 101)
      .map((entry) => entry.text)
      .join('\n');
    expect(fullThread).not.toContain('Что-то пошло не так');
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
      { textIncludes: ['Принял. Двигаемся к решению.'] }
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

  it('menu:new during intake clears state and prompts for new topic', async () => {
    const harness = await createTelegramTranscriptHarness();
    const { sessionId } = await completeTopicAndJoin(harness);
    await confirmBothSides(harness, sessionId);
    await harness.runStep(
      { type: 'callback', updateId: 401, userId: 101, data: 'menu:new' },
      { textIncludes: ['О чём хотите договориться?'], uxStep: 'CREATE_TOPIC_INPUT_PENDING' }
    );
  });

  it('resume after transport restart recovers intake state from DB', async () => {
    const harness = await createTelegramTranscriptHarness();
    const { sessionId } = await completeTopicAndJoin(harness);
    await confirmBothSides(harness, sessionId);
    await harness.restartTransport();
    await harness.runStep(
      { type: 'command', updateId: 410, userId: 102, text: '/start' },
      { textIncludes: ['незавершённая'] }
    );
    await harness.runStep(
      { type: 'callback', updateId: 411, userId: 102, data: `menu:resume:${sessionId}` },
      { textIncludes: ['Продолжаем', 'Расскажите'], uxStep: 'INTAKE_QUESTION_PENDING' }
    );
  });

  it('status callback responds with current session status', async () => {
    const harness = await createTelegramTranscriptHarness();
    await completeTopicAndJoin(harness);
    const sessionId = parseSessionId(harness);
    await harness.runStep(
      { type: 'callback', updateId: 420, userId: 101, data: `status:${sessionId}` },
      { textIncludes: ['Текущий статус:'] }
    );
  });

  it('invite:details callback shows the invite token', async () => {
    const harness = await createTelegramTranscriptHarness();
    await harness.runStep({ type: 'command', updateId: 430, userId: 101, text: '/start' });
    await harness.runStep({ type: 'callback', updateId: 431, userId: 101, data: 'menu:create' });
    await harness.runStep({ type: 'text', updateId: 432, userId: 101, text: 'Тема для invite details' });
    await harness.runStep(
      { type: 'callback', updateId: 433, userId: 101, data: 'invite:details' },
      { textIncludes: ['join_'] }
    );
  });

  it('menu:join then token text joins the session', async () => {
    const harness = await createTelegramTranscriptHarness();
    await harness.runStep({ type: 'command', updateId: 440, userId: 101, text: '/start' });
    await harness.runStep({ type: 'callback', updateId: 441, userId: 101, data: 'menu:create' });
    await harness.runStep({ type: 'text', updateId: 442, userId: 101, text: 'Тест join через меню' });
    const inviteToken = harness.extractLastInviteToken();

    await harness.runStep({ type: 'command', updateId: 443, userId: 102, text: '/start' });
    await harness.runStep(
      { type: 'callback', updateId: 444, userId: 102, data: 'menu:join' },
      { uxStep: 'JOIN_TOKEN_INPUT_PENDING' }
    );
    await harness.runStep(
      { type: 'text', updateId: 445, userId: 102, text: inviteToken },
      { textIncludes: ['Вы подключились'] }
    );
  });

  it('synthesis:clarify prompts for clarification text and confirms receipt', async () => {
    const harness = await createTelegramTranscriptHarness();
    const sessionId = await completeSynthesisForBoth(harness);
    await harness.runStep(
      { type: 'callback', updateId: 450, userId: 101, data: `synthesis:clarify:${sessionId}` },
      { textIncludes: ['Что именно я понял не так'] }
    );
    await harness.runStep(
      { type: 'text', updateId: 451, userId: 101, text: 'Не совсем так с ограничениями' },
      { textIncludes: ['Принял уточнение'] }
    );
  });

  it('both users confirming synthesis triggers issue resolution loop', async () => {
    const harness = await createTelegramTranscriptHarness();
    const sessionId = await completeSynthesisForBoth(harness);
    await harness.runStep(
      { type: 'callback', updateId: 460, userId: 101, data: `synthesis:ok:${sessionId}` },
      { textIncludes: ['Принял. Двигаемся к решению.'] }
    );
    await harness.runStep(
      { type: 'callback', updateId: 461, userId: 102, data: `synthesis:ok:${sessionId}` }
    );
    const all101 = harness.sentMessages
      .filter((entry) => entry.chatId === 101)
      .map((entry) => entry.text)
      .join('\n');
    const all102 = harness.sentMessages
      .filter((entry) => entry.chatId === 102)
      .map((entry) => entry.text)
      .join('\n');
    expect(all101).toContain('Вот варианты');
    expect(all102).toContain('Вот варианты');
    const hasIssueButton = harness.sentMessages.some((entry) =>
      entry.replyMarkupJson.includes('issue:react:')
    );
    expect(hasIssueButton).toBe(true);
  });

  it('unknown command shows a helpful fallback message', async () => {
    const harness = await createTelegramTranscriptHarness();
    await harness.runStep(
      { type: 'command', updateId: 470, userId: 101, text: '/blahblah' },
      { textIncludes: ['Неизвестная команда'] }
    );
  });
});
