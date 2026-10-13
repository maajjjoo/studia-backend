import type { BackendConfig } from '../config/env.config.ts';
import { AppError } from '../errors/app-error.ts';
import { buildSystemInstruction, sanitizeAssistantReply } from './ai-instructions.ts';
import { evaluateMessageTopic } from './ai-topic-guard.ts';
import type { AiChatResult, ChatRequestDto, FetchLike } from './ai.types.ts';
import { GeminiClient } from './gemini.client.ts';

export class AiService {
  private readonly geminiClient: GeminiClient;

  constructor(configOrClient: BackendConfig | GeminiClient, fetchImpl: FetchLike = fetch) {
    if (configOrClient instanceof GeminiClient) {
      this.geminiClient = configOrClient;
    } else {
      this.geminiClient = new GeminiClient(configOrClient, fetchImpl);
    }
  }

  public async generateReply(dto: ChatRequestDto): Promise<AiChatResult> {
    const topicEvaluation = evaluateMessageTopic(dto.messages);

    if (!topicEvaluation.allowed) {
      return {
        reply: sanitizeAssistantReply(topicEvaluation.refusalReply),
        model: this.geminiClient.getModel(),
      };
    }

    const systemInstruction = buildSystemInstruction(dto.academicContext);
    const rawResult = await this.geminiClient.sendGenerateContent(dto.messages, systemInstruction);
    const sanitizedReply = sanitizeAssistantReply(rawResult.reply);

    if (!sanitizedReply) {
      throw new AppError(
        'EMPTY_RESPONSE',
        'El proveedor de IA respondió sin contenido de texto utilizable.',
        502
      );
    }

    return {
      reply: sanitizedReply,
      model: rawResult.model,
    };
  }

  public async generateChatReply(dto: ChatRequestDto): Promise<AiChatResult> {
    return this.generateReply(dto);
  }
}
