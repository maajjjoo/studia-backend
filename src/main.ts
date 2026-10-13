import fs from 'node:fs';
import path from 'node:path';
import { createBackendServer } from './app.ts';
import { loadBackendConfig } from './config/env.config.ts';

function loadLocalEnvFileIfPresent(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
}

function bootstrap(): void {
  loadLocalEnvFileIfPresent();

  const config = loadBackendConfig(process.env);
  const server = createBackendServer(config);

  server.listen(config.port, '0.0.0.0', () => {
    const keyState = config.geminiApiKey ? 'CONFIGURADA' : 'NO CONFIGURADA (faltante)';
    console.log(
      `[studia-backend] Servidor activo en http://0.0.0.0:${config.port} | Modelo: ${config.geminiModel} | GEMINI_API_KEY: ${keyState}`
    );
  });
}

bootstrap();
