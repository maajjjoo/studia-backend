import http from 'node:http';
import { AiController } from './ai/ai.controller.ts';
import { AiService } from './ai/ai.service.ts';
import type { FetchLike } from './ai/ai.types.ts';
import type { BackendConfig } from './config/env.config.ts';
import { HealthController } from './controllers/health.controller.ts';
import { AppError, scrubSecrets } from './errors/app-error.ts';
import { RateLimiter } from './middleware/rate-limit.middleware.ts';

function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        aborted = true;
        reject(
          new AppError(
            'MESSAGE_TOO_LONG',
            `El tamaño de la solicitud supera el máximo permitido (${maxBytes} bytes).`,
            413
          )
        );
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      const rawText = Buffer.concat(chunks).toString('utf-8').trim();
      if (!rawText) {
        reject(new AppError('BAD_REQUEST', 'El cuerpo de la solicitud está vacío.', 400));
        return;
      }
      try {
        resolve(JSON.parse(rawText));
      } catch {
        reject(
          new AppError('BAD_REQUEST', 'El cuerpo de la solicitud no es un JSON válido.', 400)
        );
      }
    });

    req.on('error', () => {
      if (aborted) return;
      reject(new AppError('BAD_REQUEST', 'Error al leer el cuerpo de la solicitud.', 400));
    });
  });
}

function getClientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function applySecurityAndCorsHeaders(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  corsOriginConfig: string
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');

  const requestOrigin = req.headers.origin;
  if (corsOriginConfig === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (requestOrigin) {
    const allowedOrigins = corsOriginConfig
      .split(',')
      .map(o => o.trim())
      .filter(Boolean);
    if (allowedOrigins.includes(requestOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      res.setHeader('Vary', 'Origin');
    }
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(body);
}

export function createBackendServer(
  config: BackendConfig,
  fetchImpl?: FetchLike
): http.Server {
  const healthController = new HealthController(config);
  const aiService = new AiService(config, fetchImpl);
  const aiController = new AiController(aiService);
  const rateLimiter = new RateLimiter(
    config.rateLimitWindowMs,
    config.rateLimitMaxRequests,
    config.globalRateLimitMaxRequests
  );

  return http.createServer(async (req, res) => {
    applySecurityAndCorsHeaders(req, res, config.corsOrigin);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const urlObj = new URL(req.url || '/', 'http://localhost');
    const pathname = urlObj.pathname;

    try {
      if (req.method === 'GET' && pathname === '/health') {
        const healthData = healthController.getHealth();
        sendJson(res, 200, healthData);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/ai/chat') {
        const clientIp = getClientIp(req);
        rateLimiter.checkAndRecord(clientIp);

        const body = await readJsonBody(req, config.maxBodyBytes);
        const result = await aiController.handleChat(body);
        sendJson(res, 200, result);
        return;
      }

      throw new AppError(
        'NOT_FOUND',
        `Ruta no encontrada: ${req.method || 'UNKNOWN'} ${pathname}`,
        404
      );
    } catch (err: unknown) {
      if (err instanceof AppError) {
        sendJson(res, err.statusCode, {
          ok: false,
          error: {
            code: err.code,
            message: scrubSecrets(err.message, config.geminiApiKey),
          },
        });
        return;
      }

      // Unexpected internal error: never expose stack traces or secrets
      sendJson(res, 500, {
        ok: false,
        error: {
          code: 'PROVIDER_ERROR',
          message: 'Ocurrió un error interno en el servidor al procesar la solicitud.',
        },
      });
    }
  });
}
