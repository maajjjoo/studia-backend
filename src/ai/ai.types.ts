export type ChatRole = 'user' | 'assistant';

export interface ChatMessageDto {
  role: ChatRole;
  content: string;
}

export interface AcademicClassItemDto {
  subject: string;
  dayName: string;
  startTime: string;
  endTime: string;
  room?: string;
}

export interface AcademicAvailabilityItemDto {
  dayName: string;
  startTime: string;
  endTime: string;
}

export interface AcademicPendingTaskDto {
  title: string;
  dueDate?: string;
  priority: 'low' | 'medium' | 'high';
  remainingMinutes: number;
  isOverdue: boolean;
}

export interface AcademicActivityItemDto {
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  category: string;
}

export interface AcademicContextDto {
  currentDate: string;
  subjects: string[];
  classSchedule: AcademicClassItemDto[];
  studyAvailability: AcademicAvailabilityItemDto[];
  studyPreferences: {
    preferredSessionDuration: number;
    preferredBreakDuration: number;
  };
  pendingTasks: AcademicPendingTaskDto[];
  completedTasksCount: number;
  upcomingActivities: AcademicActivityItemDto[];
  focusSummary: {
    todayFocusMinutes: number;
    weeklyFocusMinutes: number;
    completedSessionsThisWeek: number;
  };
}

export interface ChatRequestDto {
  messages: ChatMessageDto[];
  academicContext?: AcademicContextDto;
}

export interface AiChatResult {
  reply: string;
  model: string;
}

export type AiChatResponse = AiChatResult;

export interface AiChatSuccessEnvelope {
  ok: true;
  data: AiChatResult;
}

export type TopicEvaluationResult =
  | { allowed: true; reason: 'in_scope' }
  | { allowed: false; reason: 'off_topic'; refusalReply: string };

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;
