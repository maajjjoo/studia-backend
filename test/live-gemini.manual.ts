import { AiService } from '../src/ai/ai.service.ts';
import { loadBackendConfig } from '../src/config/env.config.ts';

async function runManualLiveTest(): Promise<void> {
  const config = loadBackendConfig(process.env);
  if (!config.geminiApiKey) {
    console.error(
      'Error: Define $env:GEMINI_API_KEY en tu sesión de PowerShell antes de ejecutar esta prueba manual.'
    );
    process.exit(1);
  }

  const service = new AiService(config);
  console.log(`Probando conexión real con Gemini (${config.geminiModel})...`);

  const response = await service.generateReply({
    messages: [
      {
        role: 'user',
        content: 'Responde en una oración corta confirmando que el backend de Studia está conectado.',
      },
    ],
  });

  console.log('Respuesta recibida exitosamente:');
  console.log(`Modelo: ${response.model}`);
  console.log(`Texto: ${response.reply}`);
}

runManualLiveTest().catch(err => {
  console.error('Fallo en la prueba manual de Gemini:', err);
  process.exit(1);
});
