import { AppError } from '../errors/app-error.ts';

interface RateWindowEntry {
  timestamps: number[];
}

export class RateLimiter {
  private readonly windowMs: number;
  private readonly maxPerIp: number;
  private readonly maxGlobal: number;
  private readonly ipWindows = new Map<string, RateWindowEntry>();
  private globalTimestamps: number[] = [];

  constructor(windowMs: number, maxPerIp: number, maxGlobal: number) {
    this.windowMs = windowMs;
    this.maxPerIp = maxPerIp;
    this.maxGlobal = maxGlobal;
  }

  public checkAndRecord(clientIp: string, now: number = Date.now()): void {
    const cutoff = now - this.windowMs;

    // 1. Prune and check global window
    this.globalTimestamps = this.globalTimestamps.filter(t => t > cutoff);
    if (this.globalTimestamps.length >= this.maxGlobal) {
      throw new AppError(
        'RATE_LIMITED',
        'El servidor ha alcanzado su límite global de consultas por minuto. Intenta de nuevo en unos momentos.',
        429
      );
    }

    // 2. Prune and check per-IP window
    const key = clientIp || 'unknown';
    const existing = this.ipWindows.get(key) || { timestamps: [] };
    existing.timestamps = existing.timestamps.filter(t => t > cutoff);

    if (existing.timestamps.length >= this.maxPerIp) {
      this.ipWindows.set(key, existing);
      throw new AppError(
        'RATE_LIMITED',
        'Has enviado demasiadas consultas seguidas. Espera unos segundos antes de volver a intentar.',
        429
      );
    }

    existing.timestamps.push(now);
    this.ipWindows.set(key, existing);
    this.globalTimestamps.push(now);

    // Prevent unbounded map growth
    if (this.ipWindows.size > 1000) {
      for (const [ipKey, entry] of this.ipWindows.entries()) {
        if (entry.timestamps.every(t => t <= cutoff)) {
          this.ipWindows.delete(ipKey);
        }
      }
    }
  }
}
