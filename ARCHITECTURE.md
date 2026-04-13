# Архитектура Ладно

> Для тех, кто не пишет код. Здесь объясняется как устроен проект, что где лежит и как всё работает вместе.

---

## Что вообще происходит, когда пользователь пишет боту

1. Пользователь пишет сообщение в Telegram
2. Telegram отправляет это сообщение на наш сервер
3. Бот читает сообщение, понимает на каком этапе находится пользователь
4. Бот обращается к сервисам — они меняют состояние в базе данных
5. Бот отправляет ответ пользователю

---

## Карта папок

```
deal/
├── src/                     ← весь код
│   ├── domain/              ← правила игры (что можно делать, что нельзя)
│   ├── application/         ← сценарии (как это делать)
│   ├── infrastructure/      ← связь с внешним миром (Telegram, база данных, Claude API)
│   ├── config/              ← настройки (токены, переменные окружения)
│   └── index.ts             ← точка запуска: собирает всё вместе
│
├── prisma/                  ← схема базы данных и миграции
├── tests/                   ← тесты
└── docs/                    ← документация
```

---

## domain/ — Правила

Здесь живёт вся бизнес-логика без какого-либо кода Telegram или базы данных. Чистые правила.

```
domain/
├── session/        ← сессия: создание, приглашение, присоединение, согласие
├── intake/         ← приватный опрос каждого участника (6 вопросов)
├── synthesis/      ← общая картина конфликта (синтез из двух позиций)
├── issue/          ← петля решения: 3 варианта, реакции участников
├── proposal/       ← предложения: Сбалансированный / В пользу А / В пользу Б
├── negotiation/    ← раунды переговоров: принять, отклонить, предложить правку
├── agreement/      ← черновик договорённости и финальные ответы
├── conversation/   ← где сейчас находится пользователь в диалоге с ботом
└── protocol/       ← журнал всех действий (аудит)
```

**Главный принцип:** в каждой папке есть `stateMachine.ts` — файл с чёткими правилами переходов. Например: нельзя перейти к синтезу, пока оба не завершили intake. Это жёсткие ограничения — нарушить нельзя.

---

## application/ — Сценарии

Здесь описано *как* выполняются действия. Сервисы берут входные данные, обращаются к домену, сохраняют результат.

```
application/
├── services/
│   ├── ProtocolGatewayService.ts  ← ГЛАВНЫЙ ОРКЕСТРАТОР (единая точка входа для всего)
│   ├── MediationService.ts         ← создание сессий, приглашения, согласие
│   ├── IntakeService.ts            ← опрос: принять ответ, нормализовать, сохранить
│   ├── SynthesisService.ts         ← построить общую картину из двух позиций
│   ├── ProposalGenerationService.ts← сгенерировать 3 варианта решения
│   └── NegotiationService.ts       ← управлять раундами переговоров
│
└── ports/                          ← интерфейсы (что умеет делать каждый компонент)
    ├── ConversationStateRepository.ts
    ├── IntakeDialogManager.ts
    ├── IntakeNormalizer.ts
    └── ... (репозитории для каждой сущности)
```

**`ProtocolGatewayService`** — это центральный узел. Любое действие пользователя проходит через него. Он проверяет идемпотентность (не выполнить одно и то же дважды), пишет в журнал событий, и вызывает нужный сервис.

---

## infrastructure/ — Связь с внешним миром

```
infrastructure/
├── telegram/
│   └── bot.ts                ← ВСЯ логика Telegram-бота (~3700 строк)
│
├── llm/
│   ├── AnthropicClient.ts              ← клиент Claude API
│   ├── LlmIntakeDialogManager.ts       ← живой разговор в intake через Claude
│   ├── DeterministicIntakeDialogManager.ts ← детерминированный (для тестов)
│   └── LlmIntakeNormalizer.ts          ← нормализация ответов через Claude
│
├── repositories/
│   ├── Prisma*.ts       ← реальные репозитории (PostgreSQL)
│   └── InMemory*.ts     ← in-memory репозитории (для тестов, без БД)
│
├── http/
│   └── server.ts        ← HTTP-сервер (Fastify), webhook endpoint
│
└── transport/
    ├── errorMapping.ts  ← переводит технические ошибки в читаемые сообщения
    ├── rateLimiter.ts   ← ограничение запросов (защита от спама)
    └── viewMappers.ts   ← преобразует данные из БД в удобный для бота формат
```

---

## Структура telegram/ — после разбивки

`bot.ts` теперь занимает ~150 строк: создаёт общий контекст (`BotDeps`), подключает все модули, возвращает бота. Вся логика разнесена по файлам:

```
src/infrastructure/telegram/
│
├── bot.ts              ← точка входа: создаёт BotDeps, подключает все модули (~150 строк)
├── botDeps.ts          ← тип BotDeps: все Maps + сервисы в одном объекте
├── constants.ts        ← константы лимитов, типы, список 6 вопросов intake
├── helpers.ts          ← чистые утилиты: makeCorrelationId, extractInviteToken, etc.
├── keyboards.ts        ← фабрики inline-кнопок Telegram (без состояния)
├── renderers.ts        ← шаблоны текста: синтез, варианты, статус (без состояния)
├── transport.ts        ← отправка с ретраем, rate limiting, safeAnswerCallback
├── logging.ts          ← logInboundEvent, logTransition, detectCurrentUxStep
├── conversationState.ts← upsertConversationState, findActiveIntakeState
│
├── flows/              ← сценарии (логика нескольких шагов подряд)
│   ├── intakeFlow.ts   ← askNextMediationIntakeQuestion: задать вопрос → принять → следующий
│   ├── sessionFlow.ts  ← createSessionFlow, joinWithToken, giveConsentFlow, resumeActiveScenario
│   └── issueFlow.ts    ← maybeStartIssueLoop, maybeStartDraftAgreement
│
└── handlers/           ← обработчики событий Telegram (регистрируют bot.command / bot.callbackQuery)
    ├── commandHandlers.ts      ← /start, debug-команды
    ├── menuCallbacks.ts        ← menu:create, menu:join, menu:resume, menu:new
    ├── sessionCallbacks.ts     ← status:SESSION_ID
    ├── intakeCallbacks.ts      ← intake:edit:*, intake:confirm:*, create_topic:*
    ├── synthesisCallbacks.ts   ← synthesis:ok:*, synthesis:clarify:*
    ├── inviteCallbacks.ts      ← invite:send, invite:details
    ├── issueCallbacks.ts       ← issue:react:*
    ├── agreementCallbacks.ts   ← agreement:respond:*
    └── textHandler.ts          ← главный текстовый handler + bot.hears() для неизвестных команд
```

**Ключевая идея:** все обработчики и сценарии получают `BotDeps` — один объект со всеми Maps, сервисами и конфигом. Это заменяет замыкание: раньше всё жило внутри одной функции и видело общее состояние через closure, теперь общее состояние явно передаётся как параметр.

---

## Как данные текут от сообщения до ответа

Пример: пользователь отвечает на вопрос intake.

```
[Пользователь пишет текст в Telegram]
        ↓
[grammy перехватывает сообщение]
        ↓
[bot.ts: текстовый handler]
   → смотрит: pendingMediationIntakeSession.has(userId) → true
   → значит пользователь в intake
        ↓
[Вызывает IntakeDialogManager]
   → DeterministicIntakeDialogManager (тесты)
     или LlmIntakeDialogManager (прод: спрашивает Claude)
   → получает: reply + extractedFields + isComplete
        ↓
[gateway.submitIntakeAnswers()]
   → IntakeService.submitFieldAnswer()
      → normalizer нормализует ответ
      → stateMachine делает переход
      → IntakeRepository сохраняет в PostgreSQL
   → ProtocolEvent записывается в журнал
        ↓
[bot.ts смотрит на результат]
   → если isComplete → вызывает askNextMediationIntakeQuestion()
      → проверяет какие поля уже заполнены
      → отправляет следующий вопрос ИЛИ завершает intake
   → если не complete → обновляет ConversationState в БД
        ↓
[Telegram получает ответ пользователю]
```

---

## База данных (PostgreSQL через Prisma)

Главные таблицы:

| Таблица | Что хранит |
|---------|-----------|
| `MediationSession` | Сессия: состояние, тема, участники |
| `SessionParticipant` | Участник: роль (A/B), согласие, время |
| `ParticipantConversationState` | Где сейчас пользователь в диалоге |
| `ParticipantIntake` | Опрос участника: поля, нормализованная модель |
| `IntakeFieldAnswer` | Ответы на каждый вопрос |
| `MediationSummary` | Синтез: общие интересы, точка напряжения |
| `ProblemSynthesisSnapshot` | Нейтральная картина конфликта |
| `SynthesisReviewSignal` | Реакция на синтез: подтвердил / уточнил |
| `IssueResolutionLoop` | Петля решения: 3 варианта |
| `IssueResolutionReaction` | Реакция на вариант: принял / отклонил / правка |
| `DraftAgreement` | Черновик договорённости |
| `DraftAgreementOutcome` | Итог: AGREEMENT / DEADLOCK |
| `ProtocolEvent` | Журнал всех действий (аудит) |
| `IdempotencyRecord` | Защита от дублирования запросов |

---

## Состояния сессии (конечный автомат)

```
CREATED
  → (второй участник переходит по ссылке)
INVITED
  → (подключился)
BOTH_JOINED
  → (оба дали consent)
CONSENTED
  → (идёт intake, сначала один...)
SIDE_A_INTAKE
  → (потом другой...)
SIDE_B_INTAKE
  → (оба завершили)
READY_FOR_SYNTHESIS
  → (синтез построен)
SYNTHESIS_COMPLETED / CONSENTED (после clarify)
  → (оба подтвердили)
  → (issue loop)
  → (черновик)
AGREEMENT_REACHED / DEADLOCK / PARTIAL_AGREEMENT
```

Переход назад невозможен — это жёсткое правило домена.

---

## Intake: 6 вопросов

Каждый участник приватно отвечает на 6 вопросов:

1. **situation_facts** → "Что конкретно сейчас происходит?" → поле `facts`
2. **tension_point** → "Что задевает сильнее всего?" → поле `interpretations`
3. **important_need_or_interest** → "Что для вас здесь важнее всего?" → поле `interests`
4. **hard_constraint** → "Что точно неприемлемо?" → поля `constraints` + `boundaries`
5. **desired_outcome** → "Какой результат был бы рабочим?" → поле `desired_outcome`
6. **acceptable_flexibility** → "Где готовы быть гибкими?" → поле `acceptable_concessions`

Ответы второго участника первому не видны никогда.

---

## Тесты

```
tests/
├── integration/
│   ├── telegramTranscriptScenarios.test.ts  ← 19 сценариев от /start до issue loop
│   ├── transportAdapters.test.ts            ← HTTP/Telegram адаптеры
│   └── support/
│       └── telegramTranscriptHarness.ts     ← тест-харнесс: in-memory бот без реального Telegram
│
├── unit/                   ← юнит-тесты отдельных сервисов
└── fixtures/               ← фиксированные данные для тестов
```

Харнесс запускает настоящий код бота, но перехватывает все `sendMessage` вместо отправки в Telegram. Все репозитории — in-memory. Тесты воспроизводимы и быстрые.

---

## LLM (Claude) — где используется

| Где | Зачем |
|-----|-------|
| `LlmIntakeDialogManager` | Ведёт живой разговор в intake, извлекает поля из ответов |
| `LlmIntakeNormalizer` | Нормализует сырые ответы в структурированный текст |
| `DeterministicSynthesisMapper` | Формирует синтез (сейчас детерминированный, позже — LLM) |
| `DeterministicProposalMapper` | Генерирует варианты решения (аналогично) |

Если `ANTHROPIC_API_KEY` не задан — бот работает в детерминированном режиме (для тестов и локального запуска).

---

## Ключевые зависимости

| Пакет | Зачем |
|-------|-------|
| `grammy` | Telegram Bot API framework |
| `fastify` | HTTP-сервер |
| `prisma` | ORM для PostgreSQL |
| `@anthropic-ai/sdk` | Claude API |
| `zod` | Валидация env-переменных |
| `vitest` | Тесты |
| `pino` | Структурированное логирование |
