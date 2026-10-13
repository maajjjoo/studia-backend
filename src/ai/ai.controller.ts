import { validateChatRequestDto } from './ai-context.service.ts';
import { AiService } from './ai.service.ts';
import type { AiChatSuccessEnvelope } from './ai.types.ts';

export class AiController {
  private readonly aiService: AiService;

  constructor(aiService: AiService) {
    this.aiService = aiService;
  }

  public async handleChat(rawBody: unknown): Promise<AiChatSuccessEnvelope> {
    const validatedDto = validateChatRequestDto(rawBody);
    const result = await this.aiService.generateReply(validatedDto);
    return {
      ok: true,
      data: result,
    };
  }
}
