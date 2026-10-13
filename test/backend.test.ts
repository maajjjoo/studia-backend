import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { formatAcademicContextForPrompt } from '../src/ai/ai-context.service.ts';
import {
  OFF_TOPIC_REFUSAL_MESSAGE,
  buildSystemInstruction,
  sanitizeAssistantReply,
} from '../src/ai/ai-instructions.ts';
import { evaluateMessageTopic } from '../src/ai/ai-topic-guard.ts';
import { MAX_OUTPUT_TOKENS } from '../src/ai/gemini.client.ts';
import type { FetchLike } from '../src/ai/ai.types.ts';
import { createBackendServer } from '../src/app.ts';
import { DEFAULT_GEMINI_MODEL, loadBackendConfig } from '../src/config/env.config.ts';

async function withTestServer(
  envOverrides: Record<string, string | undefined>,
  mockFetch: FetchLike,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const config = loadBackendConfig({
    PORT: '3000',
    GEMINI_API_KEY: 'AIzaSyTestSecretKeyForUnitTesting12345',
    GEMINI_MODEL: DEFAULT_GEMINI_MODEL,
    RATE_LIMIT_MAX_REQUESTS: '5',
    GLOBAL_RATE_LIMIT_MAX_REQUESTS: '20',
    MAX_BODY_BYTES: '4096',
    ...envOverrides,
  });

  const server = createBackendServer(config, mockFetch);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('1. Consulta válida sobre funciones de Studia se procesa correctamente', async () => {
  let geminiCalls = 0;
  let capturedUrl = '';
  let capturedApiKeyHeader = '';
  let capturedBody: Record<string, unknown> = {};

  const mockFetch: FetchLike = async (input, init) => {
    geminiCalls++;
    capturedUrl = String(input);
    const headers = (init?.headers || {}) as Record<string, string>;
    capturedApiKeyHeader = headers['x-goog-api-key'] || '';
    capturedBody = JSON.parse(String(init?.body || '{}'));

    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  text: 'En la pestaña Planificador puedes generar bloques de estudio según tus entregas y disponibilidad.',
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  await withTestServer({}, mockFetch, async baseUrl => {
    const res = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: '¿Cómo funciona el planificador inteligente de Studia?',
          },
        ],
      }),
    });

    assert.equal(res.status, 200);
    assert.equal(geminiCalls, 1);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(
      body.data.reply,
      'En la pestaña Planificador puedes generar bloques de estudio según tus entregas y disponibilidad.'
    );
    assert.equal(body.data.model, 'gemini-3.5-flash-lite');
    assert.equal(
      capturedUrl,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent'
    );
    assert.equal(capturedUrl.includes('AIza'), false);
    assert.equal(capturedApiKeyHeader, 'AIzaSyTestSecretKeyForUnitTesting12345');

    const generationConfig = capturedBody.generationConfig as { maxOutputTokens?: number };
    assert.equal(generationConfig.maxOutputTokens, MAX_OUTPUT_TOKENS);
    assert.equal(MAX_OUTPUT_TOKENS <= 500, true);
  });
});

test('2. Consulta válida sobre organización de tareas o estudio sin mencionar "Studia" se procesa correctamente', async () => {
  let geminiCalls = 0;
  let capturedBody: Record<string, unknown> = {};

  const mockFetch: FetchLike = async (_input, init) => {
    geminiCalls++;
    capturedBody = JSON.parse(String(init?.body || '{}'));

    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  text: 'Prioriza hoy el Taller de Cálculo porque vence mañana y requiere 90 minutos.',
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const queryWithoutStudia =
    'Tengo dos entregas y un examen esta semana, ¿cómo me organizo?';
  const topicEval = evaluateMessageTopic([{ role: 'user', content: queryWithoutStudia }]);
  assert.equal(topicEval.allowed, true);

  await withTestServer({}, mockFetch, async baseUrl => {
    const res = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: queryWithoutStudia }],
        academicContext: {
          currentDate: '2026-10-12',
          subjects: ['Cálculo Vectorial'],
          classSchedule: [
            {
              subject: 'Cálculo Vectorial',
              dayName: 'Lunes',
              startTime: '08:00',
              endTime: '10:00',
              room: 'Bloque 3',
            },
          ],
          studyAvailability: [{ dayName: 'Lunes', startTime: '14:00', endTime: '18:00' }],
          studyPreferences: { preferredSessionDuration: 45, preferredBreakDuration: 10 },
          pendingTasks: [
            {
              title: 'Taller de Cálculo',
              dueDate: '2026-10-13',
              priority: 'high',
              remainingMinutes: 90,
              isOverdue: false,
            },
          ],
          completedTasksCount: 4,
          upcomingActivities: [],
          focusSummary: {
            todayFocusMinutes: 45,
            weeklyFocusMinutes: 180,
            completedSessionsThisWeek: 4,
          },
        },
      }),
    });

    assert.equal(res.status, 200);
    assert.equal(geminiCalls, 1);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(
      body.data.reply,
      'Prioriza hoy el Taller de Cálculo porque vence mañana y requiere 90 minutos.'
    );

    const sysInstruction = JSON.stringify(capturedBody.systemInstruction);
    assert.equal(sysInstruction.includes('Taller de Cálculo'), true);
    assert.equal(sysInstruction.includes('Cálculo Vectorial'), true);
  });
});

test('3. Consulta fuera de tema es rechazada con mensaje breve de alcance sin responder el tema ajeno ni llamar a Gemini', async () => {
  let geminiCalls = 0;
  const mockFetch: FetchLike = async () => {
    geminiCalls++;
    return new Response('{}', { status: 200 });
  };

  const offTopicQueries = [
    'Dame una receta paso a paso para preparar lasaña casera hoy.',
    '¿Quién ganó el partido de fútbol de la Champions League?',
    'Cuéntame un chiste gracioso y dime mi horóscopo.',
    '¿Cuál es la capital de Australia?',
  ];

  await withTestServer({ RATE_LIMIT_MAX_REQUESTS: '20' }, mockFetch, async baseUrl => {
    for (const query of offTopicQueries) {
      const res = await fetch(`${baseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: query }],
        }),
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.data.reply, OFF_TOPIC_REFUSAL_MESSAGE);
      assert.equal(body.data.reply.includes('Studia'), true);
      // Verify it did NOT answer the off-topic question
      assert.equal(body.data.reply.toLowerCase().includes('lasaña'), false);
      assert.equal(body.data.reply.toLowerCase().includes('canberra'), false);
    }
  });

  // Confirm Gemini API was not invoked at all for off-topic queries
  assert.equal(geminiCalls, 0);
});

test('4. Instrucciones del asistente incluyen reglas de brevedad, prohibición de emojis, no inventar datos y alcance exclusivo de Studia', () => {
  const instruction = buildSystemInstruction();

  assert.equal(instruction.includes('ALCANCE PERMITIDO (EXCLUSIVO)'), true);
  assert.equal(instruction.includes('MANEJO DE PREGUNTAS FUERA DE TEMA'), true);
  assert.equal(
    instruction.includes('NO utilices ningún emoji ni símbolo pictográfico'),
    true
  );
  assert.equal(instruction.includes('evita saludos repetitivos'), true);
  assert.equal(instruction.includes('No repitas ni parafrasees la pregunta'), true);
  assert.equal(instruction.includes('prefiere uno o dos párrafos cortos'), true);
  assert.equal(instruction.includes('No inventes datos'), true);
  assert.equal(instruction.includes('No afirmes ejecuciones falsas'), true);
});

test('5. Limpieza determinista de salida elimina emojis sin dañar texto válido en español (tildes, eñes, signos ¡!¿?)', async () => {
  const sampleWithEmojis =
    '¡Organiza tu mañana con éxito! 📚✨ Prioriza Cálculo Vectorial y programación en C++: ¿prefieres sesiones de 45 min? 🚀🔥';
  const cleaned = sanitizeAssistantReply(sampleWithEmojis);

  assert.equal(
    cleaned,
    '¡Organiza tu mañana con éxito! Prioriza Cálculo Vectorial y programación en C++: ¿prefieres sesiones de 45 min?'
  );
  assert.equal(cleaned.includes('📚'), false);
  assert.equal(cleaned.includes('✨'), false);
  assert.equal(cleaned.includes('🚀'), false);

  // Also verify end-to-end through POST /api/ai/chat if Gemini accidentally emits emojis
  const mockFetchWithEmojis: FetchLike = async () =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  text: 'Te sugiero dividir el estudio de Física en dos bloques de 45 minutos. 💡✅',
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

  await withTestServer({}, mockFetchWithEmojis, async baseUrl => {
    const res = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: '¿Cómo estudio para mi examen de Física?' }],
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(
      body.data.reply,
      'Te sugiero dividir el estudio de Física en dos bloques de 45 minutos.'
    );
  });
});

test('6. Cuando faltan datos en el contexto académico, las instrucciones y el formateador indican explícitamente que no están registrados', () => {
  const instructionWithoutContext = buildSystemInstruction(undefined);
  assert.equal(
    instructionWithoutContext.includes(
      'No se recibió contexto académico en esta consulta'
    ),
    true
  );

  const emptyAcademicContext = {
    currentDate: '2026-10-12',
    subjects: [],
    classSchedule: [],
    studyAvailability: [],
    studyPreferences: { preferredSessionDuration: 25, preferredBreakDuration: 5 },
    pendingTasks: [
      {
        title: 'Lectura sin fecha',
        dueDate: null,
        priority: 'medium' as const,
        remainingMinutes: 30,
        isOverdue: false,
      },
    ],
    completedTasksCount: 0,
    upcomingActivities: [],
    focusSummary: {
      todayFocusMinutes: 0,
      weeklyFocusMinutes: 0,
      completedSessionsThisWeek: 0,
    },
  };

  const formatted = formatAcademicContextForPrompt(emptyAcademicContext);
  assert.equal(formatted.includes('Ninguna registrada'), true);
  assert.equal(formatted.includes('Horario de clases: Sin clases registradas.'), true);
  assert.equal(
    formatted.includes(
      'Disponibilidad configurada para estudio: Sin disponibilidad registrada.'
    ),
    true
  );
  assert.equal(formatted.includes('Sin fecha límite registrada'), true);
  assert.equal(
    formatted.includes(
      'Próximas actividades en calendario: Sin actividades próximas registradas.'
    ),
    true
  );
});

test('7. Validaciones de longitud: permite mensajes >1500 caracteres (hasta 4000), recorta historial largo sin fallar y rechaza mensajes excesivos (>4000)', async () => {
  const okFetch: FetchLike = async () =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Plan generado correctamente.' }] } }],
      }),
      { status: 200 }
    );

  await withTestServer({ RATE_LIMIT_MAX_REQUESTS: '20', MAX_BODY_BYTES: '65536' }, okFetch, async baseUrl => {
    // 1. Valid user message longer than 1500 chars (e.g. 2400 chars) + long previous assistant reply (3200 chars) + large academicContext
    const detailedUserMessage =
      'Necesito organizar mis entregas y exámenes de esta semana: ' +
      'Tengo taller de Cálculo, proyecto de Ingeniería de Software y lectura de Bases de Datos. '.repeat(26);
    assert.equal(detailedUserMessage.length > 1500 && detailedUserMessage.length <= 4000, true);

    const longPreviousAssistantReply =
      'Aquí tienes el desglose detallado de bloques de estudio para tus materias de este semestre. '.repeat(36);
    assert.equal(longPreviousAssistantReply.length > 3000, true);

    const resValidLong = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: 'Hola, ayúdame a planificar mi semestre.' },
          { role: 'assistant', content: longPreviousAssistantReply },
          { role: 'user', content: detailedUserMessage },
        ],
        academicContext: {
          currentDate: '2026-10-12',
          subjects: Array.from({ length: 20 }, (_, i) => `Materia Universitaria ${i + 1} con nombre extenso`),
          classSchedule: Array.from({ length: 30 }, (_, i) => ({
            subject: `Materia Universitaria ${(i % 10) + 1}`,
            dayName: 'Lunes',
            startTime: '08:00',
            endTime: '10:00',
            room: `Edificio de Ingeniería Aula ${100 + i}`,
          })),
          studyAvailability: Array.from({ length: 14 }, () => ({
            dayName: 'Martes',
            startTime: '14:00',
            endTime: '18:00',
          })),
          studyPreferences: { preferredSessionDuration: 45, preferredBreakDuration: 10 },
          pendingTasks: Array.from({ length: 25 }, (_, i) => ({
            title: `Entrega académica número ${i + 1} con descripción de capítulos y ejercicios prácticos`,
            dueDate: '2026-10-18',
            priority: 'high',
            remainingMinutes: 120,
            isOverdue: false,
          })),
          completedTasksCount: 12,
          upcomingActivities: Array.from({ length: 25 }, (_, i) => ({
            title: `Bloque de estudio programado número ${i + 1} para preparación de parcial`,
            date: '2026-10-14',
            startTime: '15:00',
            endTime: '16:30',
            category: 'study_block',
          })),
          focusSummary: {
            todayFocusMinutes: 90,
            weeklyFocusMinutes: 360,
            completedSessionsThisWeek: 8,
          },
        },
      }),
    });
    assert.equal(resValidLong.status, 200);
    const dataValidLong = await resValidLong.json();
    assert.equal(dataValidLong.ok, true);
    assert.equal(dataValidLong.data.reply, 'Plan generado correctamente.');

    // 2. Empty messages array
    const resEmpty = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(resEmpty.status, 400);
    const dataEmpty = await resEmpty.json();
    assert.equal(dataEmpty.error.code, 'BAD_REQUEST');

    // 3. Oversized user message (> 4000 chars) is rejected with MESSAGE_TOO_LONG
    const resTooLong = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'A'.repeat(4200) }],
      }),
    });
    assert.equal(resTooLong.status, 400);
    const dataTooLong = await resTooLong.json();
    assert.equal(dataTooLong.error.code, 'MESSAGE_TOO_LONG');
    assert.equal(dataTooLong.error.message.includes('4000'), true);

    // 4. Malformed JSON
    const resBadJson = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ invalid json',
    });
    assert.equal(resBadJson.status, 400);
    const dataBadJson = await resBadJson.json();
    assert.equal(dataBadJson.error.code, 'BAD_REQUEST');
  });

  // Rate limiting check
  await withTestServer({ RATE_LIMIT_MAX_REQUESTS: '2' }, okFetch, async baseUrl => {
    const payload = JSON.stringify({
      messages: [{ role: 'user', content: '¿Qué tareas tengo hoy?' }],
    });

    const r1 = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    assert.equal(r1.status, 200);

    const r2 = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    assert.equal(r2.status, 200);

    const r3 = await fetch(`${baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    assert.equal(r3.status, 429);
    const data3 = await r3.json();
    assert.equal(data3.error.code, 'RATE_LIMITED');
  });
});

test('8. Manejo de errores del proveedor y garantía de que ninguna respuesta ni endpoint expone GEMINI_API_KEY', async () => {
  const secret = 'AIzaSySuperPrivateKey999999999999';

  // Health check never exposes GEMINI_API_KEY
  await withTestServer(
    { GEMINI_API_KEY: secret },
    async () => new Response('{}', { status: 200 }),
    async baseUrl => {
      const res = await fetch(`${baseUrl}/health`);
      assert.equal(res.status, 200);
      const rawText = await res.text();
      assert.equal(rawText.includes(secret), false);
    }
  );

  // Missing API key in server environment
  await withTestServer(
    { GEMINI_API_KEY: '' },
    async () => new Response('{}', { status: 200 }),
    async baseUrl => {
      const res = await fetch(`${baseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: '¿Cómo organizo mis tareas?' }],
        }),
      });
      assert.equal(res.status, 503);
      const data = await res.json();
      assert.equal(data.error.code, 'MISSING_API_KEY');
    }
  );

  // Invalid API key echoing secret in upstream error body
  await withTestServer(
    { GEMINI_API_KEY: secret },
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: `API key not valid: ${secret}`,
            status: 'INVALID_ARGUMENT',
          },
        }),
        { status: 400 }
      ),
    async baseUrl => {
      const res = await fetch(`${baseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: '¿Cómo organizo mis tareas?' }],
        }),
      });
      assert.equal(res.status, 502);
      const rawText = await res.text();
      assert.equal(rawText.includes(secret), false);
      const data = JSON.parse(rawText);
      assert.equal(data.error.code, 'INVALID_API_KEY');
    }
  );

  // Model unavailable (404 NOT_FOUND)
  await withTestServer(
    {},
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 404,
            message: 'models/gemini-old is not found',
            status: 'NOT_FOUND',
          },
        }),
        { status: 404 }
      ),
    async baseUrl => {
      const res = await fetch(`${baseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: '¿Cómo organizo mis tareas?' }],
        }),
      });
      assert.equal(res.status, 502);
      const data = await res.json();
      assert.equal(data.error.code, 'MODEL_UNAVAILABLE');
    }
  );

  // Timeout
  await withTestServer(
    {},
    async () => {
      const err = new Error('Timed out');
      err.name = 'TimeoutError';
      throw err;
    },
    async baseUrl => {
      const res = await fetch(`${baseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: '¿Cómo organizo mis tareas?' }],
        }),
      });
      assert.equal(res.status, 504);
      const data = await res.json();
      assert.equal(data.error.code, 'TIMEOUT');
    }
  );

  // Empty candidates response
  await withTestServer(
    {},
    async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
    async baseUrl => {
      const res = await fetch(`${baseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: '¿Cómo organizo mis tareas?' }],
        }),
      });
      assert.equal(res.status, 502);
      const data = await res.json();
      assert.equal(data.error.code, 'EMPTY_RESPONSE');
    }
  );
});
