import { AppError } from '../errors/app-error.ts';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_PORT = 3000;
export const DEFAULT_GEMINI_TIMEOUT_MS = 35000;
export const DEFAULT_GEMINI_TOTAL_TIMEOUT_MS = 55000;
export const DEFAULT_TIMEOUT_MS = DEFAULT_GEMINI_TIMEOUT_MS;
export const DEFAULT_GEMINI_MAX_RETRIES = 2;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60000;
export const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 15;
export const DEFAULT_GLOBAL_RATE_LIMIT_MAX = 60;
export const DEFAULT_MAX_BODY_BYTES = 65536;

export interface BackendConfig {
  port: number;
  geminiApiKey: string;
  geminiModel: string;
  geminiTimeoutMs: number;
  geminiTotalTimeoutMs: number;
  geminiMaxRetries: number;
  geminiRetryBaseDelayMs?: number;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  globalRateLimitMaxRequests: number;
  maxBodyBytes: number;
  corsOrigin: string;
}

const MODEL_ID_REGEX = /^[a-zA-Z0-9._-]{1,64}$/;

export function isValidModelIdentifier(model: string): boolean {
  return MODEL_ID_REGEX.test(model);
}

function parsePositiveInt(
  raw: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
  fieldName: string
): number {
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `Configuración inválida para ${fieldName}: debe ser un entero entre ${min} y ${max}.`
    );
  }
  return parsed;
}

export function loadBackendConfig(
  env: Record<string, string | undefined> = process.env
): BackendConfig {
  const port = parsePositiveInt(env.PORT, DEFAULT_PORT, 1, 65535, 'PORT');
  const geminiTimeoutMs = parsePositiveInt(
    env.GEMINI_TIMEOUT_MS,
    DEFAULT_GEMINI_TIMEOUT_MS,
    50,
    120000,
    'GEMINI_TIMEOUT_MS'
  );
  const geminiTotalTimeoutMs = parsePositiveInt(
    env.GEMINI_TOTAL_TIMEOUT_MS,
    DEFAULT_GEMINI_TOTAL_TIMEOUT_MS,
    50,
    180000,
    'GEMINI_TOTAL_TIMEOUT_MS'
  );
  const geminiMaxRetries = parsePositiveInt(
    env.GEMINI_MAX_RETRIES,
    DEFAULT_GEMINI_MAX_RETRIES,
    0,
    5,
    'GEMINI_MAX_RETRIES'
  );
  const geminiRetryBaseDelayMs =
    env.GEMINI_RETRY_BASE_DELAY_MS !== undefined && env.GEMINI_RETRY_BASE_DELAY_MS.trim() !== ''
      ? parsePositiveInt(
          env.GEMINI_RETRY_BASE_DELAY_MS,
          1500,
          1,
          30000,
          'GEMINI_RETRY_BASE_DELAY_MS'
        )
      : undefined;
  const rateLimitWindowMs = parsePositiveInt(
    env.RATE_LIMIT_WINDOW_MS,
    DEFAULT_RATE_LIMIT_WINDOW_MS,
    1000,
    3600000,
    'RATE_LIMIT_WINDOW_MS'
  );
  const rateLimitMaxRequests = parsePositiveInt(
    env.RATE_LIMIT_MAX_REQUESTS,
    DEFAULT_RATE_LIMIT_MAX_REQUESTS,
    1,
    500,
    'RATE_LIMIT_MAX_REQUESTS'
  );
  const globalRateLimitMaxRequests = parsePositiveInt(
    env.GLOBAL_RATE_LIMIT_MAX_REQUESTS,
    DEFAULT_GLOBAL_RATE_LIMIT_MAX,
    1,
    5000,
    'GLOBAL_RATE_LIMIT_MAX_REQUESTS'
  );
  const maxBodyBytes = parsePositiveInt(
    env.MAX_BODY_BYTES,
    DEFAULT_MAX_BODY_BYTES,
    1024,
    262144,
    'MAX_BODY_BYTES'
  );

  const rawModel = (env.GEMINI_MODEL || '').trim();
  const geminiModel = rawModel.length > 0 ? rawModel : DEFAULT_GEMINI_MODEL;

  if (!isValidModelIdentifier(geminiModel)) {
    throw new AppError(
      'MODEL_UNAVAILABLE',
      'El identificador configurado en GEMINI_MODEL tiene un formato inválido.',
      502
    );
  }

  const geminiApiKey = (env.GEMINI_API_KEY || '').trim();
  const corsOrigin = (env.CORS_ORIGIN || '*').trim() || '*';

  return {
    port,
    geminiApiKey,
    geminiModel,
    geminiTimeoutMs,
    geminiTotalTimeoutMs,
    geminiMaxRetries,
    geminiRetryBaseDelayMs,
    rateLimitWindowMs,
    rateLimitMaxRequests,
    globalRateLimitMaxRequests,
    maxBodyBytes,
    corsOrigin,
  };
}
