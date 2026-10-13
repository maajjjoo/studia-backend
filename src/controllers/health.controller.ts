import type { BackendConfig } from '../config/env.config.ts';

export interface HealthResponse {
  ok: true;
  service: string;
  status: 'up';
  aiConfigured: boolean;
  model: string;
  timestamp: string;
}

export class HealthController {
  private readonly config: BackendConfig;

  constructor(config: BackendConfig) {
    this.config = config;
  }

  public getHealth(): HealthResponse {
    return {
      ok: true,
      service: 'studia-backend',
      status: 'up',
      aiConfigured: this.config.geminiApiKey.trim().length > 0,
      model: this.config.geminiModel,
      timestamp: new Date().toISOString(),
    };
  }
}
