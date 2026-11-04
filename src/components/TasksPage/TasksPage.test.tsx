import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render, flush } from '../../testing/render';
import { TasksPage } from './TasksPage';
import { fetchTasks } from '../../api/tasksClient';
vi.mock('../../api/tasksClient', () => ({ fetchTasks: vi.fn() }));
const mock = vi.mocked(fetchTasks);
afterEach(() => vi.useRealTimers());
const empty = { state: 'ready' as const, generatedAt: '2030-01-01T00:00:00Z', coverage: [], tasks: [], executions: [], sessions: [] };
it('shows disabled and does not invent tasks', async () => {
  mock.mockResolvedValue({ ...empty, state: 'disabled' });
  const { container } = render(<TasksPage />); await flush();
  expect(container.textContent).toContain('連携は無効');
});
it('shows partial coverage, stale task reports, attempts and unknown model without HTML interpretation', async () => {
  mock.mockResolvedValue({ ...empty, state: 'stale', coverage: [{ tool: 'codex', scope: 'partial' }], tasks: [
    { id: 'task-a', parentTaskId: null, title: '<script>demo</script>', status: 'completed', stage: 'review', summary: 'Synthetic report', acceptance: { completed: 1, total: 2 }, updatedAt: null, freshness: 'unknown' },
    { id: 'task-b', parentTaskId: 'task-a', title: 'Synthetic child', status: 'unknown', stage: null, summary: null, acceptance: null, updatedAt: null, freshness: 'unknown' },
  ], executions: [{ id: 'run-a', taskId: 'task-a', sessionId: null, tool: 'codex', model: null, modelBasis: 'unknown', provider: null, host: 'Demo workstation', status: 'running', statusBasis: 'recorded', startedAt: null, updatedAt: null, freshness: 'unknown' }], sessions: [{ id: 'session-orphan', tool: 'other', host: null, updatedAt: null, freshness: 'unknown', linked: false }] });
  const { container } = render(<TasksPage />); await flush();
  expect(container.textContent).toContain('一部のみ');
  expect(container.textContent).toContain('古い');
  expect(container.textContent).toContain('鮮度不明');
  expect(container.textContent).toContain('1 / 2');
  expect(container.textContent).toContain('親タスク: task-a');
  expect(container.textContent).toContain('親タスク未報告');
  expect(container.textContent).not.toContain('親タスクなし');
  expect(container.textContent).toContain('モデル: 不明');
  expect(container.textContent).toContain('run-a');
  expect(container.textContent).toContain('session-orphan');
  expect(container.querySelector('script')).toBeNull();
});
it('does not show raw transport errors or pretend connection failure is empty success', async () => {
  mock.mockRejectedValue(new Error('SYNTHETIC_SECRET'));
  const { container } = render(<TasksPage />); await flush();
  expect(container.textContent).toContain('取得できません');
  expect(container.textContent).not.toContain('SYNTHETIC_SECRET');
  expect(container.textContent).not.toContain('タスクはありません');
});

it('drops previous payload on polling failure and recovers without stale success', async () => {
  vi.useFakeTimers();
  const initial = { ...empty, tasks: [{ id: 'task-a', parentTaskId: null, title: 'Synthetic initial task', status: 'running' as const, stage: null, summary: null, acceptance: null, updatedAt: null, freshness: 'unknown' as const }] };
  mock.mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error('SYNTHETIC_SECRET')).mockResolvedValueOnce({ ...initial, tasks: [{ ...initial.tasks[0], title: 'Synthetic recovered task' }] });
  const { container } = render(<TasksPage />); await flush();
  expect(container.textContent).toContain('Synthetic initial task');
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(container.textContent).toContain('取得できません');
  expect(container.textContent).not.toContain('Synthetic initial task');
  expect(container.textContent).not.toContain('SYNTHETIC_SECRET');
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(container.textContent).toContain('Synthetic recovered task');
  expect(container.textContent).not.toContain('取得できません');
});

it('clears private data immediately on token change and ignores the old request', async () => {
  const { setToken } = await import('../../api/authToken');
  vi.useFakeTimers();
  const initial = { ...empty, tasks: [{ id: 'task-a', parentTaskId: null, title: 'Synthetic previous scope', status: 'running' as const, stage: null, summary: null, acceptance: null, updatedAt: null, freshness: 'unknown' as const }] };
  let oldResolve!: (value: typeof initial) => void;
  let newResolve!: (value: typeof initial) => void;
  mock.mockResolvedValueOnce(initial)
    .mockImplementationOnce(() => new Promise(resolve => { oldResolve = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { newResolve = resolve; }));
  const { container } = render(<TasksPage />); await flush();
  expect(container.textContent).toContain('Synthetic previous scope');
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  act(() => setToken('synthetic-next-scope'));
  expect(container.textContent).not.toContain('Synthetic previous scope');
  await act(async () => { oldResolve(initial); });
  expect(container.textContent).not.toContain('Synthetic previous scope');
  await act(async () => { newResolve({ ...initial, tasks: [{ ...initial.tasks[0], title: 'Synthetic new scope' }] }); });
  expect(container.textContent).toContain('Synthetic new scope');
  localStorage.clear();
});

it('filters by task name and reported status while retaining compact details', async () => {
  mock.mockResolvedValue({ ...empty, tasks: [
    { id: 'task-a', parentTaskId: null, title: 'Synthetic alpha', status: 'running', stage: null, summary: null, acceptance: null, updatedAt: null, freshness: 'unknown' },
    { id: 'task-b', parentTaskId: null, title: 'Synthetic beta', status: 'completed', stage: null, summary: null, acceptance: null, updatedAt: null, freshness: 'unknown' },
  ] });
  const { container } = render(<TasksPage />); await flush();
  expect(container.querySelectorAll('article')).toHaveLength(2);
  expect(container.querySelector('details')?.open).toBe(false);
  const input = container.querySelector('input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'beta');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(container.querySelectorAll('article')).toHaveLength(1);
  expect(container.querySelector('article')?.textContent).toContain('Synthetic beta');
  act(() => {
    const select = container.querySelector('select')!;
    select.value = 'running'; select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.querySelectorAll('article')).toHaveLength(0);
  expect(container.textContent).toContain('条件に一致するタスクはありません');
});

it('shows all known sessions while no current session is selected', async () => {
  mock.mockResolvedValue({ ...empty, tasks: [{ id: 'task-a', parentTaskId: null, title: 'Synthetic task', status: 'unknown', stage: null, summary: null, acceptance: null, updatedAt: null, freshness: 'unknown' }],
    executions: [{ id: 'run-a', taskId: 'task-a', sessionId: null, sessionIds: ['session-a', 'session-b'], tool: 'unknown', model: null, modelBasis: 'unknown', provider: null, host: null, status: 'unknown', statusBasis: 'unknown', startedAt: null, updatedAt: null, freshness: 'unknown' }],
    sessions: [{ id: 'session-a', tool: 'codex', host: null, updatedAt: null, freshness: 'unknown', linked: true }, { id: 'session-b', tool: 'claude-code', host: null, updatedAt: null, freshness: 'unknown', linked: true }] });
  const { container } = render(<TasksPage />); await flush();
  expect(container.textContent).toContain('関連セッション: session-a, session-b');
  expect(container.textContent).toContain('未ひも付けセッション（0）');
});


it('shows approved session purpose as plain text with separate source time and missing indicators', async () => {
  mock.mockResolvedValue({ ...empty, sessions: [
    { id: 'described', tool: 'codex', host: 'Demo workstation', updatedAt: null, freshness: 'unknown', linked: false, title: 'Synthetic documentation', purpose: '<img src=x onerror=alert(1)> Explain synthetic module', purposeBasis: 'reviewed-summary', purposeUpdatedAt: null },
    { id: 'unreported', tool: 'other', host: null, updatedAt: null, freshness: 'unknown', linked: false },
  ] });
  const { container } = render(<TasksPage />); await flush();
  expect(container.textContent).toContain('Synthetic documentation');
  expect(container.textContent).toContain('<img src=x onerror=alert(1)> Explain synthetic module');
  expect(container.textContent).toContain('確認済み要約');
  expect(container.textContent).toContain('説明の確認時刻: 未報告（鮮度不明）');
  expect(container.textContent).toContain('説明未報告');
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelectorAll('article')).toHaveLength(0);
  const input = container.querySelector('input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'synthetic module');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const section = container.querySelector('[aria-label="未ひも付けセッション"]')!;
  expect(section.textContent).toContain('described');
  expect(section.textContent).not.toContain('unreported');
});

it('shows linked session explanations without changing execution state', async () => {
  mock.mockResolvedValue({ ...empty, tasks: [{ id: 'task-a', parentTaskId: null, title: 'Synthetic task', status: 'unknown', stage: null, summary: null, acceptance: null, updatedAt: null, freshness: 'unknown' }],
    executions: [{ id: 'run-a', taskId: 'task-a', sessionId: 'session-a', tool: 'codex', model: null, modelBasis: 'unknown', provider: null, host: null, status: 'unknown', statusBasis: 'unknown', startedAt: null, updatedAt: null, freshness: 'unknown' }],
    sessions: [{ id: 'session-a', tool: 'codex', host: null, updatedAt: null, freshness: 'unknown', linked: true, title: null, purpose: 'Review synthetic tests', purposeBasis: 'manual', purposeUpdatedAt: '2030-01-01T00:00:00Z' }] });
  const { container } = render(<TasksPage />); await flush();
  expect(container.querySelector('article')?.textContent).toContain('Review synthetic tests');
  expect(container.textContent).toContain('明示された説明');
  expect(container.textContent).toContain('記録された状態: 不明');
  expect(container.textContent).toContain('未ひも付けセッション（0）');
});

it('shows repository and task context as plain primary information and searches each field', async () => {
  mock.mockResolvedValue({ ...empty, sessions: [
    { id: 'session-context', tool: 'codex', host: null, updatedAt: null, freshness: 'unknown', linked: false, title: 'Synthetic session', workContext: { repository: 'demo-owner/demo-repo', taskName: '<b>Synthetic parser review</b>', taskRef: 'DEMO-7', basis: 'reviewed', updatedAt: null } },
    { id: 'session-legacy', tool: 'other', host: null, updatedAt: null, freshness: 'unknown', linked: false },
  ] });
  const { container } = render(<TasksPage />); await flush();
  expect(container.textContent).toContain('作業リポジトリ: demo-owner/demo-repo');
  expect(container.textContent).toContain('タスク: <b>Synthetic parser review</b>');
  expect(container.textContent).toContain('DEMO-7');
  expect(container.textContent).toContain('作業情報の根拠: 確認済み');
  expect(container.textContent).toContain('作業情報の確認時刻: 未報告（鮮度不明）');
  expect(container.textContent).toContain('作業リポジトリ: 未報告');
  expect(container.querySelector('b')).toBeNull();
  expect(container.querySelectorAll('article')).toHaveLength(0);
  for (const query of ['demo-repo', 'parser review', 'DEMO-7']) {
    act(() => {
      const input = container.querySelector('input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const section = container.querySelector('[aria-label="未ひも付けセッション"]')!;
    expect(section.textContent).toContain('session-context');
    expect(section.textContent).not.toContain('session-legacy');
  }
});
