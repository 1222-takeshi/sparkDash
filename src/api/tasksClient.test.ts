import { expect, it, vi } from 'vitest';
import { fetchTasks } from './tasksClient';
import { setToken } from './authToken';

it('uses the existing auth boundary and forbids cache', async () => {
  setToken('synthetic-token');
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ state: 'disabled' })));
  await expect(fetchTasks()).resolves.toEqual({ state: 'disabled' });
  expect(fetchMock).toHaveBeenCalledWith('/api/tasks', { headers: { Authorization: 'Bearer synthetic-token' }, cache: 'no-store', signal: undefined });
  setToken('');
});
it('never reflects a failed response body', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('SYNTHETIC_SECRET', { status: 500 }));
  await expect(fetchTasks()).rejects.toThrow('Tasks unavailable');
});
