import Anthropic from '@anthropic-ai/sdk';

export class AnthropicClient {
  private readonly client: Anthropic;

  constructor(apiKey: string | undefined = process.env.ANTHROPIC_API_KEY) {
    if (!apiKey || !apiKey.trim()) {
      throw new Error('ANTHROPIC_API_KEY is required for AnthropicClient.');
    }
    this.client = new Anthropic({ apiKey: apiKey.trim() });
  }

  async ask(systemPrompt: string, userMessage: string): Promise<string> {
    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    });

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (!text) {
      throw new Error('Anthropic response did not contain text content.');
    }

    return text;
  }
}

