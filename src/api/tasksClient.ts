import { authHeaders, reportAuthRequired } from './authToken';
import type { TasksResponse } from './tasksTypes';

export async function fetchTasks(signal?: AbortSignal): Promise<TasksResponse> {
  const response = await fetch('/api/tasks', { headers: authHeaders(), cache: 'no-store', signal });
  if (!response.ok) {
    if (response.status === 401) reportAuthRequired();
    throw new Error('Tasks unavailable');
  }
  return response.json();
}
