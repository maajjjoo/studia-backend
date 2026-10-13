import type { BackendConfig } from '../config/env.config.ts';
import { isValidModelIdentifier } from '../config/env.config.ts';
import { AppError, scrubSecrets } from '../errors/app-error.ts';
import type { AiChatResult, ChatMessageDto, FetchLike } from './ai.types.ts';

export const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
export const MAX_OUTPUT_TOKENS = 420;
export const DEFAULT_TEMPERATURE = 0.3;

export function buildGeminiEndpointUrl(model: string): string {
  if (!isValidModelIdentifier(model)) {
    throw new AppError(
      'MODEL_UNAVAILABLE',
      'El identificador del modelo de IA configurado en el servidor no es válido.',
      502
    );
  }
  return `${GEMINI_API_BASE_URL}/${model}:generateContent`;
}

export function buildGeminiRequestBody(
  messages: ChatMessageDto[],
  systemInstructionText: string
) {
  const contents = messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }],
  }));

  return {
    systemInstruction: {
      parts: [{ text: systemInstructionText }],
    },
    contents,
    generationConfig: {
      temperature: DEFAULT_TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  };
}

export function parseGeminiApiResponse(
  statusCode: number,
  rawBody: string,
  apiKeyToScrub: string
): string {
  if (statusCode < 200 || statusCode >= 300) {
    throw classifyGeminiHttpError(statusCode, rawBody, apiKeyToScrub);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new AppError(
      'PROVIDER_ERROR',
      'La respuesta recibida del proveedor de IA no tiene un formato JSON válido.',
      502
    );
  }

  const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  if (candidates.length === 0) {
    throw new AppError(
      'EMPTY_RESPONSE',
      'El proveedor de IA devolvió una respuesta vacía o bloqueada por filtros de seguridad.',
      502
    );
  }

  const first = candidates[0] as Record<string, unknown>;
  const content =
    first && typeof first.content === 'object' && first.content !== null
      ? (first.content as Record<string, unknown>)
      : null;

  const parts = content && Array.isArray(content.parts) ? content.parts : [];
  const combinedText = parts
    .map(p =>
      p && typeof p === 'object' && typeof (p as Record<string, unknown>).text === 'string'
        ? String((p as Record<string, unknown>).text)
        : ''
    )
    .join('')
    .trim();

  if (!combinedText) {
    throw new AppError(
      'EMPTY_RESPONSE',
      'El proveedor de IA respondió sin contenido de texto utilizable.',
      502
    );
  }

  return scrubSecrets(combinedText, apiKeyToScrub);
}

export function classifyGeminiHttpError(
  statusCode: number,
  rawBody: string,
  apiKeyToScrub: string
): AppError {
  let providerStatus = '';
  let providerMessageLower = '';

  try {
    const parsed = JSON.parse(rawBody) as {
      error?: { status?: string; message?: string };
    };
    providerStatus = parsed.error?.status || '';
    providerMessageLower = (parsed.error?.message || '').toLowerCase();
  } catch {
    // Ignore non-JSON body
  }

  const isInvalidKey =
    statusCode === 401 ||
    statusCode === 403 ||
    (statusCode === 400 &&
      (providerStatus === 'INVALID_ARGUMENT' || providerStatus === 'UNAUTHENTICATED') &&
      (providerMessageLower.includes('api key') || providerMessageLower.includes('api_key')));

  if (isInvalidKey) {
    return new AppError(
      'INVALID_API_KEY',
      'El servidor no pudo autenticarse con Gemini API. Verifica la clave configurada en el backend.',
      502
    );
  }

  if (
    statusCode === 404 ||
    providerStatus === 'NOT_FOUND' ||
    (statusCode === 400 && providerMessageLower.includes('model'))
  ) {
    return new AppError(
      'MODEL_UNAVAILABLE',
      'El modelo de IA configurado en el servidor no está disponible. Revisa la variable GEMINI_MODEL en el backend.',
      502
    );
  }

  if (statusCode === 429 || providerStatus === 'RESOURCE_EXHAUSTED') {
    return new AppError(
      'RATE_LIMITED',
      'Se alcanzó temporalmente el límite de cuota de Gemini API. Intenta nuevamente en unos segundos.',
      429
    );
  }

  if (statusCode >= 500 && statusCode <= 599) {
    return new AppError(
      'PROVIDER_ERROR',
      scrubSecrets(
        `El servicio de Gemini API no está disponible temporalmente (HTTP ${statusCode}).`,
        apiKeyToScrub
      ),
      502
    );
  }

  return new AppError(
    'PROVIDER_ERROR',
    scrubSecrets(
      `El proveedor de IA rechazó la solicitud (HTTP ${statusCode}).`,
      apiKeyToScrub
    ),
    502
  );
}

export class GeminiClient {
  private readonly config: BackendConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config: BackendConfig, fetchImpl: FetchLike = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  public getModel(): string {
    return this.config.geminiModel;
  }

  public async sendGenerateContent(
    messages: ChatMessageDto[],
    systemInstructionText: string
  ): Promise<AiChatResult> {
    const apiKey = this.config.geminiApiKey.trim();
    if (!apiKey) {
      throw new AppError(
        'MISSING_API_KEY',
        'El servidor backend no tiene configurada la variable GEMINI_API_KEY.',
        503
      );
    }

    const url = buildGeminiEndpointUrl(this.config.geminiModel);
    const requestPayload = buildGeminiRequestBody(messages, systemInstructionText);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(requestPayload),
        signal: AbortSignal.timeout(this.config.geminiTimeoutMs),
      });
    } catch (err: unknown) {
      const errName = err instanceof Error ? err.name : '';
      if (errName === 'TimeoutError' || errName === 'AbortError') {
        throw new AppError(
          'TIMEOUT',
          'La solicitud al proveedor de IA superó el tiempo máximo de espera.',
          504
        );
      }
      throw new AppError(
        'NETWORK_ERROR',
        'El servidor backend no pudo establecer conexión de red con Gemini API.',
        502
      );
    }

    let rawBody = '';
    try {
      rawBody = await response.text();
    } catch {
      throw new AppError(
        'NETWORK_ERROR',
        'Error al leer la respuesta del proveedor de IA.',
        502
      );
    }

    const reply = parseGeminiApiResponse(response.status, rawBody, apiKey);
    return {
      reply,
      model: this.config.geminiModel,
    };
  }
}
