import { IntakeDialogManager, IntakeDialogResult, ConversationTurn } from '../../application/ports/IntakeDialogManager.js';
import { mediatorSystemPrompt } from './prompts/mediatorSystemPrompt.js';
import { AnthropicClient } from './AnthropicClient.js';
import { IntakeField } from '../../domain/intake/types.js';

const extractJsonObject = (value: string): string | null => {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) return value.slice(start, end + 1);
  return null;
};

const safeText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const ALL_FIELDS: IntakeField[] = [
  'facts', 'interpretations', 'interests', 'constraints', 'boundaries',
  'desired_outcome', 'acceptable_concessions', 'non_negotiables'
];

export class LlmIntakeDialogManager implements IntakeDialogManager {
  constructor(private readonly anthropic: AnthropicClient = new AnthropicClient()) {}

  async processTurn(input: {
    topic: string;
    history: ConversationTurn[];
    collectedFields: Partial<Record<string, string>>;
    latestUserMessage: string;
  }): Promise<IntakeDialogResult> {
    const collectedList = Object.keys(input.collectedFields).join(', ') || 'ничего';
    const historyText = input.history
      .map(turn => `${turn.role === 'user' ? 'Пользователь' : 'Медиатор'}: ${turn.text}`)
      .join('\n');

    const userPrompt = [
      'Ты ведёшь intake-разговор с одной стороной конфликта. Задача: собрать 6 измерений позиции.',
      '',
      `Тема: «${input.topic}»`,
      '',
      `Уже зафиксировано: ${collectedList}`,
      `Нужно собрать (если ещё нет): facts, interpretations, interests, constraints, desired_outcome, acceptable_concessions`,
      '',
      historyText ? `История разговора:\n${historyText}` : 'Это первое сообщение пользователя.',
      '',
      `Последнее сообщение пользователя: «${input.latestUserMessage}»`,
      '',
      'Правила:',
      '- reply: отрази смысл услышанного, задай ОДИН следующий вопрос (если ещё есть что собрать)',
      '- extracted: извлеки из последнего сообщения то, что реально там есть (null если не хватает данных)',
      '- complete: true только если все 6 измерений теперь заполнены',
      '',
      'Верни строго JSON без комментариев:',
      '{"reply":"...","extracted":{"facts":null,"interpretations":null,"interests":null,"constraints":null,"desired_outcome":null,"acceptable_concessions":null},"complete":false}'
    ].join('\n');

    const response = await this.anthropic.ask(mediatorSystemPrompt, userPrompt);
    const jsonText = extractJsonObject(response);
    if (!jsonText) throw new Error('LlmIntakeDialogManager: non-JSON response.');

    let parsed: unknown;
    try { parsed = JSON.parse(jsonText); } catch { throw new Error('LlmIntakeDialogManager: JSON parse failed.'); }

    const obj = parsed as Record<string, unknown>;
    const reply = safeText(obj.reply) || 'Расскажите подробнее.';
    const complete = Boolean(obj.complete);

    const extracted = (obj.extracted ?? {}) as Record<string, unknown>;
    const extractedFields: Partial<Record<IntakeField, string>> = {};
    for (const field of ALL_FIELDS) {
      const val = safeText(extracted[field]);
      if (val) extractedFields[field as IntakeField] = val;
    }

    return { reply, extractedFields, isComplete: complete };
  }
}
