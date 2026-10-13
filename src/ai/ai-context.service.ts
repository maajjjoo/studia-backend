import { AppError } from '../errors/app-error.ts';
import type {
  AcademicActivityItemDto,
  AcademicAvailabilityItemDto,
  AcademicClassItemDto,
  AcademicContextDto,
  AcademicPendingTaskDto,
  ChatMessageDto,
  ChatRequestDto,
} from './ai.types.ts';

export const CHAT_LIMITS = {
  maxMessagesPerRequest: 12,
  maxMessageLength: 4000,
  maxHistoryMessageLength: 2500,
  maxTotalHistoryChars: 12000,
  maxFormattedContextChars: 6000,
  maxSubjects: 20,
  maxSubjectLength: 80,
  maxClassScheduleItems: 40,
  maxAvailabilityItems: 21,
  maxPendingTasks: 25,
  maxTaskTitleLength: 120,
  maxActivities: 25,
  maxActivityTitleLength: 120,
} as const;

function validateUserMessageContent(val: unknown, maxLen: number, fieldName: string): string {
  if (typeof val !== 'string') {
    throw new AppError(
      'BAD_REQUEST',
      `El campo ${fieldName} debe ser una cadena de texto.`,
      400
    );
  }
  const trimmed = val.trim();
  if (trimmed.length > maxLen) {
    throw new AppError(
      'MESSAGE_TOO_LONG',
      `Tu mensaje tiene ${trimmed.length} caracteres y supera el límite máximo permitido de ${maxLen} caracteres. Acórtalo un poco e inténtalo de nuevo.`,
      400
    );
  }
  return trimmed;
}

function sanitizeHistoryMessageContent(val: unknown, maxLen: number, fieldName: string): string {
  if (typeof val !== 'string') {
    throw new AppError(
      'BAD_REQUEST',
      `El campo ${fieldName} debe ser una cadena de texto.`,
      400
    );
  }
  const trimmed = val.trim();
  if (trimmed.length <= maxLen) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLen - 3).trimEnd()}...`;
}

function parseSafeNonNegativeInt(val: unknown, maxVal: number, fallback = 0): number {
  const num = Number(val);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return Math.min(Math.round(num), maxVal);
}

export function validateChatRequestDto(body: unknown): ChatRequestDto {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(
      'BAD_REQUEST',
      'El cuerpo de la solicitud debe ser un objeto JSON válido.',
      400
    );
  }

  const raw = body as Record<string, unknown>;

  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw new AppError(
      'BAD_REQUEST',
      'La solicitud debe incluir al menos un mensaje en el arreglo "messages".',
      400
    );
  }

  if (raw.messages.length > CHAT_LIMITS.maxMessagesPerRequest) {
    throw new AppError(
      'BAD_REQUEST',
      `No se pueden enviar más de ${CHAT_LIMITS.maxMessagesPerRequest} mensajes de historial por consulta.`,
      400
    );
  }

  const lastIndex = raw.messages.length - 1;

  const parsedMessages: ChatMessageDto[] = raw.messages.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AppError('BAD_REQUEST', `El mensaje en la posición ${idx} no es válido.`, 400);
    }
    const msg = item as Record<string, unknown>;
    if (msg.role !== 'user' && msg.role !== 'assistant') {
      throw new AppError(
        'BAD_REQUEST',
        `El rol del mensaje en la posición ${idx} debe ser "user" o "assistant".`,
        400
      );
    }

    const isCurrentMessage = idx === lastIndex;
    const content = isCurrentMessage
      ? validateUserMessageContent(
          msg.content,
          CHAT_LIMITS.maxMessageLength,
          `messages[${idx}].content`
        )
      : sanitizeHistoryMessageContent(
          msg.content,
          CHAT_LIMITS.maxHistoryMessageLength,
          `messages[${idx}].content`
        );

    if (!content) {
      throw new AppError('BAD_REQUEST', 'El contenido del mensaje no puede estar vacío.', 400);
    }

    return {
      role: msg.role,
      content,
    };
  });

  const lastMessage = parsedMessages[parsedMessages.length - 1];
  if (lastMessage.role !== 'user') {
    throw new AppError(
      'BAD_REQUEST',
      'El último mensaje de la consulta debe pertenecer al estudiante ("user").',
      400
    );
  }

  // Asegurar que la suma del historial previo no exceda maxTotalHistoryChars
  const historyMessages = parsedMessages.slice(0, -1);
  const boundedHistory: ChatMessageDto[] = [];
  let accumulatedHistoryChars = 0;

  for (let i = historyMessages.length - 1; i >= 0; i--) {
    const candidate = historyMessages[i];
    if (accumulatedHistoryChars + candidate.content.length > CHAT_LIMITS.maxTotalHistoryChars) {
      break;
    }
    accumulatedHistoryChars += candidate.content.length;
    boundedHistory.unshift(candidate);
  }

  const messages: ChatMessageDto[] = [...boundedHistory, lastMessage];

  let academicContext: AcademicContextDto | undefined;
  if (
    raw.academicContext !== undefined &&
    raw.academicContext !== null &&
    typeof raw.academicContext === 'object' &&
    !Array.isArray(raw.academicContext)
  ) {
    academicContext = validateAcademicContextDto(raw.academicContext);
  }

  return {
    messages,
    academicContext,
  };
}

export function validateAcademicContextDto(rawCtx: unknown): AcademicContextDto {
  if (typeof rawCtx !== 'object' || rawCtx === null || Array.isArray(rawCtx)) {
    throw new AppError('BAD_REQUEST', 'El campo academicContext debe ser un objeto válido.', 400);
  }

  const ctx = rawCtx as Record<string, unknown>;
  const currentDate =
    typeof ctx.currentDate === 'string' ? ctx.currentDate.trim().slice(0, 40) : '';

  const subjects = Array.isArray(ctx.subjects)
    ? ctx.subjects
        .slice(0, CHAT_LIMITS.maxSubjects)
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map(s => s.trim().slice(0, CHAT_LIMITS.maxSubjectLength))
    : [];

  const classSchedule: AcademicClassItemDto[] = Array.isArray(ctx.classSchedule)
    ? ctx.classSchedule
        .slice(0, CHAT_LIMITS.maxClassScheduleItems)
        .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === 'object'))
        .map(c => ({
          subject: String(c.subject || '').trim().slice(0, CHAT_LIMITS.maxSubjectLength),
          dayName: String(c.dayName || '').trim().slice(0, 20),
          startTime: String(c.startTime || '').trim().slice(0, 10),
          endTime: String(c.endTime || '').trim().slice(0, 10),
          room:
            typeof c.room === 'string' && c.room.trim().length > 0
              ? c.room.trim().slice(0, 60)
              : undefined,
        }))
        .filter(c => c.subject.length > 0)
    : [];

  const studyAvailability: AcademicAvailabilityItemDto[] = Array.isArray(ctx.studyAvailability)
    ? ctx.studyAvailability
        .slice(0, CHAT_LIMITS.maxAvailabilityItems)
        .filter((a): a is Record<string, unknown> => Boolean(a && typeof a === 'object'))
        .map(a => ({
          dayName: String(a.dayName || '').trim().slice(0, 20),
          startTime: String(a.startTime || '').trim().slice(0, 10),
          endTime: String(a.endTime || '').trim().slice(0, 10),
        }))
        .filter(a => a.dayName.length > 0)
    : [];

  const rawPrefs =
    ctx.studyPreferences && typeof ctx.studyPreferences === 'object'
      ? (ctx.studyPreferences as Record<string, unknown>)
      : {};

  const studyPreferences = {
    preferredSessionDuration: parseSafeNonNegativeInt(rawPrefs.preferredSessionDuration, 180, 25),
    preferredBreakDuration: parseSafeNonNegativeInt(rawPrefs.preferredBreakDuration, 60, 5),
  };

  const pendingTasks: AcademicPendingTaskDto[] = Array.isArray(ctx.pendingTasks)
    ? ctx.pendingTasks
        .slice(0, CHAT_LIMITS.maxPendingTasks)
        .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === 'object'))
        .map(t => {
          const prio: 'low' | 'medium' | 'high' =
            t.priority === 'high' || t.priority === 'medium' || t.priority === 'low'
              ? t.priority
              : 'medium';
          return {
            title: String(t.title || '').trim().slice(0, CHAT_LIMITS.maxTaskTitleLength),
            dueDate:
              typeof t.dueDate === 'string' && t.dueDate.trim().length > 0
                ? t.dueDate.trim().slice(0, 20)
                : undefined,
            priority: prio,
            remainingMinutes: parseSafeNonNegativeInt(t.remainingMinutes, 10000, 0),
            isOverdue: Boolean(t.isOverdue),
          };
        })
        .filter(t => t.title.length > 0)
    : [];

  const completedTasksCount = parseSafeNonNegativeInt(ctx.completedTasksCount, 10000, 0);

  const upcomingActivities: AcademicActivityItemDto[] = Array.isArray(ctx.upcomingActivities)
    ? ctx.upcomingActivities
        .slice(0, CHAT_LIMITS.maxActivities)
        .filter((a): a is Record<string, unknown> => Boolean(a && typeof a === 'object'))
        .map(a => ({
          title: String(a.title || '').trim().slice(0, CHAT_LIMITS.maxActivityTitleLength),
          date: String(a.date || '').trim().slice(0, 20),
          startTime: String(a.startTime || '').trim().slice(0, 10),
          endTime: String(a.endTime || '').trim().slice(0, 10),
          category: String(a.category || '').trim().slice(0, 30),
        }))
        .filter(a => a.title.length > 0)
    : [];

  const rawFocus =
    ctx.focusSummary && typeof ctx.focusSummary === 'object'
      ? (ctx.focusSummary as Record<string, unknown>)
      : {};

  const focusSummary = {
    todayFocusMinutes: parseSafeNonNegativeInt(rawFocus.todayFocusMinutes, 1440, 0),
    weeklyFocusMinutes: parseSafeNonNegativeInt(rawFocus.weeklyFocusMinutes, 10080, 0),
    completedSessionsThisWeek: parseSafeNonNegativeInt(rawFocus.completedSessionsThisWeek, 500, 0),
  };

  return {
    currentDate,
    subjects,
    classSchedule,
    studyAvailability,
    studyPreferences,
    pendingTasks,
    completedTasksCount,
    upcomingActivities,
    focusSummary,
  };
}

export function formatAcademicContextForPrompt(context: AcademicContextDto): string {
  const lines: string[] = [
    '[CONTEXTO ACADÉMICO DEL ESTUDIANTE]',
    `Fecha actual de referencia: ${context.currentDate || 'No especificada'}`,
    `Materias inscritas (${context.subjects.length}): ${
      context.subjects.length > 0 ? context.subjects.join(', ') : 'Ninguna registrada'
    }`,
    `Preferencias de estudio: sesiones de ${context.studyPreferences.preferredSessionDuration} min con descansos de ${context.studyPreferences.preferredBreakDuration} min.`,
    `Progreso de concentración: ${context.focusSummary.todayFocusMinutes} min hoy | ${context.focusSummary.weeklyFocusMinutes} min esta semana (${context.focusSummary.completedSessionsThisWeek} sesiones completadas) | ${context.completedTasksCount} tareas completadas en total.`,
  ];

  if (context.classSchedule.length > 0) {
    lines.push('Horario de clases:');
    for (const cls of context.classSchedule) {
      const roomPart = cls.room ? ` (${cls.room})` : '';
      lines.push(
        `- ${cls.dayName}: ${cls.subject} de ${cls.startTime} a ${cls.endTime}${roomPart}`
      );
    }
  } else {
    lines.push('Horario de clases: Sin clases registradas.');
  }

  if (context.studyAvailability.length > 0) {
    lines.push('Disponibilidad configurada para estudio:');
    for (const slot of context.studyAvailability) {
      lines.push(`- ${slot.dayName}: ${slot.startTime} a ${slot.endTime}`);
    }
  } else {
    lines.push('Disponibilidad configurada para estudio: Sin disponibilidad registrada.');
  }

  if (context.pendingTasks.length > 0) {
    lines.push(`Tareas pendientes (${context.pendingTasks.length}):`);
    for (const task of context.pendingTasks) {
      const dueStr = task.dueDate ? `Entrega: ${task.dueDate}` : 'Sin fecha límite registrada';
      const overdueTag = task.isOverdue ? ' [ATRASADA]' : '';
      const prioLabel =
        task.priority === 'high' ? 'Alta' : task.priority === 'medium' ? 'Media' : 'Baja';
      lines.push(
        `- "${task.title}" | ${dueStr}${overdueTag} | Prioridad: ${prioLabel} | Tiempo restante estimado: ${task.remainingMinutes} min`
      );
    }
  } else {
    lines.push('Tareas pendientes: No hay tareas pendientes registradas.');
  }

  if (context.upcomingActivities.length > 0) {
    lines.push(`Próximas actividades en calendario (${context.upcomingActivities.length}):`);
    for (const act of context.upcomingActivities) {
      lines.push(
        `- ${act.date} (${act.startTime}-${act.endTime}): "${act.title}" [${act.category}]`
      );
    }
  } else {
    lines.push('Próximas actividades en calendario: Sin actividades próximas registradas.');
  }

  const formatted = lines.join('\n');
  if (formatted.length <= CHAT_LIMITS.maxFormattedContextChars) {
    return formatted;
  }
  return `${formatted.slice(0, CHAT_LIMITS.maxFormattedContextChars - 3).trimEnd()}...`;
}
