export type BackendErrorCode =
  | 'MISSING_API_KEY'
  | 'INVALID_API_KEY'
  | 'MODEL_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'PROVIDER_ERROR'
  | 'EMPTY_RESPONSE'
  | 'MESSAGE_TOO_LONG'
  | 'BAD_REQUEST'
  | 'NOT_FOUND';

export class AppError extends Error {
  public readonly code: BackendErrorCode;
  public readonly statusCode: number;

  constructor(code: BackendErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function scrubSecrets(text: string, secret?: string): string {
  if (!text) return '';
  let result = text;
  const trimmedSecret = (secret || '').trim();
  if (trimmedSecret.length > 0) {
    result = result.split(trimmedSecret).join('[REDACTED]');
  }
  // Redact any accidental Google API key pattern (AIza...)
  result = result.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]');
  return result;
}
