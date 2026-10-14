import type { BackendConfig } from '../config/env.config.ts';
import { DEFAULT_GEMINI_MAX_RETRIES, isValidModelIdentifier } from '../config/env.config.ts';
import { AppError, scrubSecrets } from '../errors/app-error.ts';
import type { AiChatResult, ChatMessageDto, FetchLike } from './ai.types.ts';

export const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
export const MAX_OUTPUT_TOKENS = 320;
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

export interface RetryDecision {
  shouldRetry: boolean;
  reason: string;
  isTransient: boolean;
}

export function parseRetryAfterHeader(headerValue: string | null | undefined): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;

  const seconds = Number(trimmed);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    const diff = parsedDate - Date.now();
    return diff > 0 ? diff : 0;
  }

  return null;
}

export function evaluateGeminiErrorRetryability(
  statusCode: number,
  rawBody: string,
  clientSignalAborted: boolean
): RetryDecision {
  if (clientSignalAborted) {
    return { shouldRetry: false, reason: 'CLIENT_ABORTED', isTransient: false };
  }

  // HTTP 503: Servicio temporalmente no disponible / modelo saturado -> Reintentable
  if (statusCode === 503) {
    return { shouldRetry: true, reason: 'SERVICE_UNAVAILABLE', isTransient: true };
  }

  // HTTP 429: Cuota o tasa excedida -> No reintentar (evita bucles cuando la cuota está agotada o requiere facturación)
  if (statusCode === 429) {
    const isBillingOrPermanent =
      rawBody.toLowerCase().includes('billing') ||
      rawBody.toLowerCase().includes('plan') ||
      rawBody.toLowerCase().includes('quota');
    return {
      shouldRetry: false,
      reason: isBillingOrPermanent ? 'PERMANENT_QUOTA_OR_BILLING' : 'RATE_OR_QUOTA_EXHAUSTED',
      isTransient: false,
    };
  }

  // Errores permanentes de autenticación o cliente -> No reintentar
  if (statusCode === 401 || statusCode === 403) {
    return { shouldRetry: false, reason: 'AUTH_ERROR', isTransient: false };
  }
  if (statusCode === 400) {
    return { shouldRetry: false, reason: 'BAD_REQUEST', isTransient: false };
  }
  if (statusCode === 404) {
    return { shouldRetry: false, reason: 'MODEL_NOT_FOUND', isTransient: false };
  }

  // Errores de pasarela / upstream temporales de Google (502, 504) -> Reintentable
  if (statusCode === 502 || statusCode === 504) {
    return { shouldRetry: true, reason: `GATEWAY_ERROR_${statusCode}`, isTransient: true };
  }

  return { shouldRetry: false, reason: `NON_RETRYABLE_STATUS_${statusCode}`, isTransient: false };
}

export function isTransientNetworkError(err: unknown, clientSignal?: AbortSignal): boolean {
  if (clientSignal?.aborted) return false;
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' && !clientSignal?.aborted) {
    return true;
  }
  if (err.name === 'TimeoutError') {
    return true;
  }
  const msg = err.message.toLowerCase();
  return (
    err.name === 'TypeError' ||
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up')
  );
}

export function computeBackoffDelay(
  attempt: number,
  retryAfterMs: number | null,
  remainingBudgetMs: number,
  baseDelayMs = 1500,
  maxDelayMs = 8000
): number {
  const exponential = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  const jitter = Math.floor(Math.random() * 500);
  let delay = exponential + jitter;

  if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
    delay = Math.max(delay, retryAfterMs);
  }

  return Math.min(delay, remainingBudgetMs);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new AppError('TIMEOUT', 'La solicitud fue cancelada por el cliente.', 499));
    }
    const timer = setTimeout(() => {
      resolve();
    }, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new AppError('TIMEOUT', 'La solicitud fue cancelada por el cliente.', 499));
        },
        { once: true }
      );
    }
  });
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
    systemInstructionText: string,
    clientSignal?: AbortSignal
  ): Promise<AiChatResult> {
    const apiKey = this.config.geminiApiKey.trim();
    if (!apiKey) {
      throw new AppError(
        'MISSING_API_KEY',
        'El servidor backend no tiene configurada la variable GEMINI_API_KEY.',
        503
      );
    }

    if (clientSignal?.aborted) {
      throw new AppError('TIMEOUT', 'La solicitud fue cancelada por el cliente.', 499);
    }

    const url = buildGeminiEndpointUrl(this.config.geminiModel);
    const requestPayload = buildGeminiRequestBody(messages, systemInstructionText);
    const configuredRetries =
      typeof this.config.geminiMaxRetries === 'number'
        ? this.config.geminiMaxRetries
        : DEFAULT_GEMINI_MAX_RETRIES;
    const maxRetries = Math.max(0, Math.min(configuredRetries, 2));
    const maxAttempts = maxRetries + 1;
    const totalBudgetMs = this.config.geminiTotalTimeoutMs || 55000;
    const perAttemptTimeoutMs = this.config.geminiTimeoutMs || 35000;
    const baseDelayMs = this.config.geminiRetryBaseDelayMs ?? 1500;
    const startTime = Date.now();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (clientSignal?.aborted) {
        throw new AppError('TIMEOUT', 'La solicitud fue cancelada por el cliente.', 499);
      }

      const overallElapsed = Date.now() - startTime;
      const remainingBudget = totalBudgetMs - overallElapsed;
      if (remainingBudget <= 500) {
        console.warn(
          `[GeminiClient] Presupuesto total (${totalBudgetMs}ms) agotado antes del intento ${attempt + 1}.`
        );
        throw new AppError(
          'TIMEOUT',
          'La solicitud al proveedor de IA superó el tiempo máximo de espera.',
          504
        );
      }

      const attemptTimeoutMs = Math.min(perAttemptTimeoutMs, remainingBudget);
      const attemptStart = Date.now();

      const timeoutSignal = AbortSignal.timeout(attemptTimeoutMs);
      const attemptSignal = clientSignal
        ? AbortSignal.any([timeoutSignal, clientSignal])
        : timeoutSignal;

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(requestPayload),
          signal: attemptSignal,
        });
      } catch (err: unknown) {
        const attemptElapsed = Date.now() - attemptStart;
        if (clientSignal?.aborted) {
          throw new AppError('TIMEOUT', 'La solicitud fue cancelada por el cliente.', 499);
        }

        const isTransient = isTransientNetworkError(err, clientSignal);
        const isTimeout =
          (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) ||
          attemptElapsed >= attemptTimeoutMs;

        console.warn(
          `[GeminiClient] Intento ${attempt + 1}/${maxAttempts} falló tras ${attemptElapsed}ms: ${isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR'}.`
        );

        if (!isTransient || attempt >= maxAttempts - 1) {
          if (isTimeout) {
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

        const retryRemainingBudget = totalBudgetMs - (Date.now() - startTime);
        const delay = computeBackoffDelay(attempt, null, retryRemainingBudget, baseDelayMs);
        if (delay >= retryRemainingBudget || delay <= 0) {
          throw new AppError(
            'TIMEOUT',
            'La solicitud al proveedor de IA superó el tiempo máximo de espera.',
            504
          );
        }

        console.info(`[GeminiClient] Reintentando tras error de red en ${delay}ms...`);
        await sleep(delay, clientSignal);
        continue;
      }

      const attemptElapsed = Date.now() - attemptStart;
      let rawBody = '';
      try {
        rawBody = await response.text();
      } catch {
        console.warn(
          `[GeminiClient] Intento ${attempt + 1}/${maxAttempts} falló al leer el cuerpo tras ${attemptElapsed}ms.`
        );
        if (attempt >= maxAttempts - 1) {
          throw new AppError(
            'NETWORK_ERROR',
            'Error al leer la respuesta del proveedor de IA.',
            502
          );
        }
        const delay = computeBackoffDelay(
          attempt,
          null,
          totalBudgetMs - (Date.now() - startTime),
          baseDelayMs
        );
        await sleep(delay, clientSignal);
        continue;
      }

      if (response.status >= 200 && response.status < 300) {
        const reply = parseGeminiApiResponse(response.status, rawBody, apiKey);
        if (attempt > 0) {
          console.info(
            `[GeminiClient] Éxito en intento ${attempt + 1}/${maxAttempts} (duración total: ${Date.now() - startTime}ms).`
          );
        }
        return {
          reply,
          model: this.config.geminiModel,
        };
      }

      const retryDecision = evaluateGeminiErrorRetryability(
        response.status,
        rawBody,
        Boolean(clientSignal?.aborted)
      );

      console.warn(
        `[GeminiClient] Intento ${attempt + 1}/${maxAttempts} falló tras ${attemptElapsed}ms con HTTP ${response.status} (${retryDecision.reason}).`
      );

      if (!retryDecision.shouldRetry || attempt >= maxAttempts - 1) {
        throw classifyGeminiHttpError(response.status, rawBody, apiKey);
      }

      const retryAfterMs = parseRetryAfterHeader(response.headers.get('retry-after'));
      const remainingForDelay = totalBudgetMs - (Date.now() - startTime);
      const delay = computeBackoffDelay(attempt, retryAfterMs, remainingForDelay, baseDelayMs);

      if (delay >= remainingForDelay || delay <= 0) {
        throw new AppError(
          'TIMEOUT',
          'La solicitud al proveedor de IA superó el tiempo máximo de espera.',
          504
        );
      }

      console.info(
        `[GeminiClient] Reintentando tras HTTP ${response.status} en ${delay}ms...`
      );
      await sleep(delay, clientSignal);
    }

    throw new AppError(
      'PROVIDER_ERROR',
      'El proveedor de IA no pudo responder tras varios intentos.',
      502
    );
  }
}
