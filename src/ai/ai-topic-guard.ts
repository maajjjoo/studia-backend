import { OFF_TOPIC_REFUSAL_MESSAGE } from './ai-instructions.ts';
import type { ChatMessageDto, TopicEvaluationResult } from './ai.types.ts';

function normalizeForMatch(input: string): string {
  return (input || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Señales semánticas del dominio de Studia y de la organización/planificación universitaria.
 * Incluye referencias informales a estudio, entregas, parciales, horarios, concentración y uso de la app.
 */
const ACADEMIC_OR_STUDIA_SIGNALS: RegExp[] = [
  /\b(studia|aplicacion|app|pestana|pantalla|interfaz|menu|ajustes|configurar|configuracion)\b/,
  /\b(tarea|tareas|entrega|entregas|pendiente|pendientes|atrasad[oa]s?|vencid[oa]s?|plazo|fecha limite)\b/,
  /\b(examen|examenes|parcial|parciales|quiz|quices|prueba|evaluacion|evaluaciones|exposicion|sustentacion|calificacion|nota|notas|promedio)\b/,
  /\b(proyecto|proyectos|taller|talleres|laboratorio|informe|ensayo|lectura|monografia|apuntes|resumen|bibliografia)\b/,
  /\b(materia|materias|asignatura|asignaturas|clase|clases|curso|cursos|semestre|universidad|universitari[oa]|facultad|profesor|docente|aula|salon)\b/,
  /\b(horario|horarios|calendario|agenda|agendar|cronograma|disponibilidad|tiempo libre|hueco|bloque|bloques)\b/,
  /\b(estudiar|estudio|organizar|organizo|organizacion|planificar|planifico|planificacion|plan de estudio|distribuir|priorizar|prioridad|urgente)\b/,
  /\b(enfoque|concentracion|concentrarme|pomodoro|temporizador|sesion|sesiones|descanso|descansos|pausa|pausas|bloqueo|bloquear|distraccion|distracciones|productividad|habito|habitos|metodo|repasar|repaso|rutina)\b/,
  /\b(carga academica|sobrecarga|progreso|avance|estadisticas|que hago primero|por donde empiezo|que tengo (para )?(hoy|manana|esta semana|el lunes|el martes|el miercoles|el jueves|el viernes|el sabado|el domingo)|como tengo (hoy|manana|el dia|la semana))\b/,
];

/**
 * Consultas breves de saludo o preguntas sobre la identidad/capacidades del asistente.
 */
const ASSISTANT_META_OR_GREETING_SIGNALS: RegExp[] = [
  /^(hola|buenos dias|buenas tardes|buenas noches|hey|saludos)(\s+[a-z]+){0,3}$/,
  /\b(que puedes hacer|en que me ayudas|en que puedes ayudarme|como funcionas|quien eres|para que sirves|ayudame con studia)\b/,
];

/**
 * Señales de continuidad conversacional cuando ya existe historial previo con el asistente.
 */
const CONVERSATIONAL_FOLLOWUP_SIGNALS: RegExp[] = [
  /\b(eso|esto|ese|esa|estos|estas|anterior|primero|segundo|tercero|ultimo|punto|opcion|alternativa|mejor|mas detalle|explicame|como lo aplico|y si|entonces|gracias|vale|entiendo)\b/,
];

/**
 * Patrones de intenciones claramente ajenas al propósito de Studia
 * (cocina, deportes, entretenimiento/farándula, horóscopo, chistes, política, cripto/apuestas, clima, trivia general).
 */
const EXPLICIT_OFF_TOPIC_PATTERNS: RegExp[] = [
  /\b(receta|cocinar|ingredientes|hornear|freir|como preparar un[a]?|platillo|postre|lasana|pizza)\b/,
  /\b(partido de futbol|futbol|champions league|mundial|marcador del partido|tabla de posiciones|gol de|nba|formula 1|quien gano)\b/,
  /\b(cuentame un chiste|dime un chiste|chiste|adivinanza|horoscopo|signo zodiacal|tarot|carta astral)\b/,
  /\b(pelicula|serie de netflix|actor|actriz|famosos|farandula|chisme|cancion|letra de la cancion)\b/,
  /\b(criptomoneda|criptomonedas|bitcoin|ethereum|invertir en bolsa|trading|apuestas deportivas|casino)\b/,
  /\b(por quien votar|elecciones presidenciales|partido politico|presidente de|capital de)\b/,
  /\b(pronostico del clima|va a llover|temperatura en|clima en)\b/,
  /\b(diagnostico medico|que medicamento tomar|recetame una pastilla)\b/,
];

/**
 * Evalúa si la consulta del usuario pertenece al dominio de Studia y la organización académica.
 *
 * Estrategia en dos capas:
 * 1. Validación determinista rápida en servidor (sin gastar una segunda llamada a Gemini):
 *    - Rechaza inmediatamente solicitudes de dominios claramente ajenos (recetas, deportes, chistes, etc.).
 *    - Acepta cualquier consulta con señales de organización académica, estudio, tareas, exámenes,
 *      horarios, concentración o funciones de Studia (aunque no mencione la palabra "Studia").
 *    - Rechaza preguntas enciclopédicas o generales aisladas que no contienen ninguna señal académica ni de seguimiento.
 * 2. Las instrucciones del sistema (`ai-instructions.ts`) actúan como segunda barrera en el modelo.
 */
export function evaluateMessageTopic(messages: ChatMessageDto[]): TopicEvaluationResult {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { allowed: false, reason: 'off_topic', refusalReply: OFF_TOPIC_REFUSAL_MESSAGE };
  }

  const lastMessage = messages[messages.length - 1];
  const normalized = normalizeForMatch(lastMessage.content);

  if (!normalized) {
    return { allowed: false, reason: 'off_topic', refusalReply: OFF_TOPIC_REFUSAL_MESSAGE };
  }

  const hasExplicitOffTopicSignal = EXPLICIT_OFF_TOPIC_PATTERNS.some(regex =>
    regex.test(normalized)
  );

  // Si contiene un tema explícitamente ajeno (ej. receta de cocina, partido de fútbol, chiste, capital de un país),
  // se rechaza antes de consultar a Gemini.
  if (hasExplicitOffTopicSignal) {
    return {
      allowed: false,
      reason: 'off_topic',
      refusalReply: OFF_TOPIC_REFUSAL_MESSAGE,
    };
  }

  const hasAcademicOrStudiaSignal = ACADEMIC_OR_STUDIA_SIGNALS.some(regex =>
    regex.test(normalized)
  );

  // Si tiene señales académicas, de organización de estudio o de uso de Studia, se permite.
  if (hasAcademicOrStudiaSignal) {
    return { allowed: true, reason: 'in_scope' };
  }

  // Saludos o preguntas sobre qué puede hacer el asistente
  if (ASSISTANT_META_OR_GREETING_SIGNALS.some(regex => regex.test(normalized))) {
    return { allowed: true, reason: 'in_scope' };
  }

  // Si hay historial previo en la conversación y es una repregunta o seguimiento breve
  const hasPriorConversation = messages.length > 1;
  if (
    hasPriorConversation &&
    !hasExplicitOffTopicSignal &&
    (normalized.length <= 60 ||
      CONVERSATIONAL_FOLLOWUP_SIGNALS.some(regex => regex.test(normalized)))
  ) {
    return { allowed: true, reason: 'in_scope' };
  }

  // Consulta aislada sin relación con tareas, materias, horarios, estudio ni Studia
  return {
    allowed: false,
    reason: 'off_topic',
    refusalReply: OFF_TOPIC_REFUSAL_MESSAGE,
  };
}
