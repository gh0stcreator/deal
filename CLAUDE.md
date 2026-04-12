# Ладно — что это

**Ладно** — Telegram-бот для разрешения конфликтов между двумя людьми. Не чат-бот общего назначения, а структурированный протокол: каждый шаг фиксирован, состояния явные, LLM используется только там где нужен живой язык.

## Суть продукта

Два человека не могут договориться — например, о графике ванной, разделе обязанностей, деньгах. Они оба заходят в бота. Бот проводит их через несколько этапов:

1. **Invite** — первый создаёт сессию, второй подключается по ссылке
2. **Consent** — оба явно подтверждают участие
3. **Intake** — каждый приватно отвечает на вопросы (что происходит, что важно, что неприемлемо). Ответы второго стороне не видны
4. **Synthesis** — бот строит нейтральную картину: общие интересы, точка напряжения, зона возможного соглашения. Оба видят одно и то же
5. **Issue loop** — три варианта решения основного конфликта. Каждый реагирует приватно
6. **Draft agreement** — если есть пересечение — бот генерирует проект договорённости

## Жёсткие правила

- **Никакого кросс-чтения**: сырые ответы одной стороны никогда не попадают другой
- **Только два участника** (MVP)
- **Детерминированный flow**: состояние — явный state machine, не "ИИ решает что делать дальше"
- **LLM — только для языка**: нормализация ответов, synthesis-текст, вопросы в intake. Не для управления протоколом

## Архитектура

```
Telegram (grammY) ──┐
                    ├─► Application services ──► Domain (state machine)
HTTP (Fastify)  ────┘         │
                              ▼
                         PostgreSQL (Prisma)
```

- **`src/domain/`** — чистая логика без зависимостей: сессии, intake, synthesis, proposals, negotiation
- **`src/application/`** — порты (интерфейсы репозиториев, LLM-клиентов) и сервисы
- **`src/infrastructure/`** — реализации: Telegram-бот, HTTP, Prisma-репозитории, LLM-клиенты
- **`src/infrastructure/telegram/bot.ts`** — главный файл (~3700 строк). Весь UX-flow бота

## Intake dialog

Intake — самая сложная часть. Раньше было 6 жёстких вопросов, сейчас — диалог через `IntakeDialogManager`:

- **`DeterministicIntakeDialogManager`** — для тестов: обрабатывает поля по порядку, детерминированно
- **`LlmIntakeDialogManager`** — для прода: ведёт живой разговор через Claude API, извлекает поля (situation_facts, tension_point, core_interest, constraints, desired_outcome, acceptable_concessions)

Поля хранятся в intake-репозитории. Бот отслеживает прогресс через `ConversationStateRepository`.

## ConversationState

Персистентный стейт разговора в БД. Нужен для восстановления после рестарта бота:

```typescript
{
  sessionId, telegramUserId,
  currentStage: 'INTAKE' | 'COMPLETED' | ...,
  currentQuestionKey: 'situation_facts' | 'tension_point' | ...,
  expectedInputType: 'TEXT' | 'NONE',
  committedFields: string[]
}
```

## Тесты

Все интеграционные тесты в `tests/integration/telegramTranscriptScenarios.test.ts`. Используют `TelegramTranscriptHarness` — in-memory бот с перехватом `sendMessage`. Тесты покрывают полный flow от `/start` до issue loop.

```bash
pnpm test tests/integration/telegramTranscriptScenarios.test.ts
```

19 тестов, все зелёные.

## Команды

```bash
pnpm dev                    # запустить бота
pnpm test                   # все тесты
pnpm build                  # TypeScript build
pnpm prisma:deploy          # применить миграции
docker compose up -d postgres  # поднять БД
```

## Env переменные

Смотри `.env.example`. Ключевые:
- `TELEGRAM_BOT_TOKEN` — токен бота
- `DATABASE_URL` — PostgreSQL
- `ANTHROPIC_API_KEY` — для LLM intake (опционально, без него работает детерминированный fallback)

## Что не трогать без причины

- Логику приватности (кто что видит) — описана в `docs/VISIBILITY_MATRIX.md`
- State machine переходы — в `docs/STATE_MACHINE.md`
- Порядок этапов протокола
