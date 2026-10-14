import { validateChatRequestDto } from './ai-context.service.ts';
import { AiService } from './ai.service.ts';
import type { AiChatSuccessEnvelope } from './ai.types.ts';

export class AiController {
  private readonly aiService: AiService;

  constructor(aiService: AiService) {
    this.aiService = aiService;
  }

  public async handleChat(rawBody: unknown, clientSignal?: AbortSignal): Promise<AiChatSuccessEnvelope> {
    const validatedDto = validateChatRequestDto(rawBody);
    const result = await this.aiService.generateReply(validatedDto, clientSignal);
    return {
      ok: true,
      data: result,
    };
  }
}
