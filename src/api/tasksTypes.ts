export type TaskTool = 'codex' | 'claude-code' | 'local-llm' | 'other' | 'unknown';
export type TaskStatus = 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type Freshness = 'fresh' | 'stale' | 'unknown';
interface Updated { updatedAt: string | null; freshness: Freshness }
export interface VisibleTask extends Updated {
  id: string; parentTaskId: string | null; title: string; status: TaskStatus;
  stage: string | null; summary: string | null; acceptance: { completed: number; total: number } | null;
}
export interface TaskExecution extends Updated {
  id: string; taskId: string; sessionId: string | null; sessionIds?: string[]; tool: TaskTool;
  model: string | null; modelBasis: 'reported' | 'configured' | 'unknown';
  provider: string | null; host: string | null; status: TaskStatus;
  statusBasis: 'reported' | 'observed' | 'recorded' | 'unknown'; startedAt: string | null;
}
export interface TaskSession extends Updated {
  id: string; tool: TaskTool; host: string | null; linked: boolean;
  title?: string | null; purpose?: string | null;
  purposeBasis?: 'manual' | 'reviewed-summary' | 'unknown'; purposeUpdatedAt?: string | null;
}
export interface TasksResponse {
  state: 'disabled' | 'unavailable' | 'ready' | 'stale'; generatedAt: string | null;
  coverage: { tool: TaskTool; scope: 'partial' | 'complete' | 'unsupported' }[];
  tasks: VisibleTask[]; executions: TaskExecution[]; sessions: TaskSession[];
}
