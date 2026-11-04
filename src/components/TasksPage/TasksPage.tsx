import { useEffect, useRef, useState } from 'react';
import { fetchTasks } from '../../api/tasksClient';
import { onTokenChange } from '../../api/authToken';
import type { Freshness, TaskExecution, TaskSession, TasksResponse, TaskStatus, TaskTool } from '../../api/tasksTypes';

const tools: Record<TaskTool, string> = { codex: 'Codex', 'claude-code': 'Claude Code', 'local-llm': 'Local LLM', other: 'その他', unknown: '不明' };
const statuses: Record<TaskStatus, string> = { queued: '待機', running: '実行中', blocked: '保留', completed: '完了', failed: '失敗', cancelled: '中止', unknown: '不明' };
const scopes = { complete: '設定した収集範囲内で全件', partial: '一部のみ', unsupported: '未対応' };
const modelBasis = { reported: '実行元が報告', configured: '設定値・使用実績未確認', unknown: '不明' };
const statusBasis = { reported: '明示報告', observed: '観測', recorded: '保存された記録', unknown: '不明' };
const purposeBasis = { manual: '明示された説明', 'reviewed-summary': '確認済み要約', unknown: '不明' };
const workBasis = { reported: '報告値', reviewed: '確認済み', unknown: '不明' };
const sessionSearch = (session: TaskSession) => [session.id, session.title ?? '', session.purpose ?? '', tools[session.tool], session.host ?? '', session.workContext?.repository ?? '', session.workContext?.taskName ?? '', session.workContext?.taskRef ?? ''].join(' ');
const showTime = (value: string | null) => value ? new Date(value).toLocaleString() : '未報告';
type SessionFilterValue = string | null | undefined;
const filterValue = (value: SessionFilterValue) => value === undefined ? '' : JSON.stringify(value);
function SessionFilter({ label, values, value, onChange, display = value => value ?? '未報告' }: {
  label: string; values: (string | null)[]; value: SessionFilterValue;
  onChange: (value: SessionFilterValue) => void; display?: (value: string | null) => string;
}) {
  const options = [...new Set(values)].sort((a, b) => (a ?? '').localeCompare(b ?? ''));
  const missingSelection = value !== undefined && !options.includes(value);
  // 未報告はnullで区別し、同名の報告値がある場合は表示も分ける。
  const optionLabel = (option: string | null) => option === null && options.includes('未報告') ? '未報告（値なし）' : display(option);
  return <label className="grid min-w-0 gap-1 text-sm">{label}
    <select className="w-full min-w-0 rounded border border-border bg-transparent p-2" aria-label={`セッションの${label}`} value={filterValue(value)} onChange={event => onChange(event.target.value === '' ? undefined : JSON.parse(event.target.value))}>
      <option value="">すべて</option>
      {options.map(option => <option key={filterValue(option)} value={filterValue(option)}>{optionLabel(option)}</option>)}
      {missingSelection ? <option value={filterValue(value)}>{optionLabel(value)}（現在の一覧にありません）</option> : null}
    </select>
  </label>;
}
function FreshnessLabel({ value }: { value: Freshness }) {
  return <span className="text-muted">{value === 'fresh' ? '更新あり（生存確認ではありません）' : value === 'stale' ? '古い報告' : '鮮度不明'}</span>;
}
function SessionDescription({ value }: { value: TaskSession }) {
  return <div className="space-y-1 break-words">
    <p className="font-semibold">作業リポジトリ: {value.workContext?.repository ?? '未報告'}</p>
    <p className="font-semibold">タスク: {value.workContext?.taskName ?? '未報告'}{value.workContext?.taskRef ? `（${value.workContext.taskRef}）` : ''}</p>
    {value.workContext && value.workContext.basis !== 'unknown' ? <>
      <p className="text-xs text-muted">作業情報の根拠: {workBasis[value.workContext.basis]}（確認時点の情報）</p>
      <p className="text-xs text-muted">作業情報の確認時刻: {value.workContext.updatedAt ? showTime(value.workContext.updatedAt) : '未報告（鮮度不明）'}</p>
    </> : null}
    {value.title ? <p>{value.title}</p> : null}
    <p className="text-xs text-muted">セッションID: {value.id}</p>
    <p>{value.purpose ?? '説明未報告'}</p>
    {value.purpose ? <>
      <p className="text-xs text-muted">説明の根拠: {purposeBasis[value.purposeBasis ?? 'unknown']}（確認時点の説明）</p>
      <p className="text-xs text-muted">説明の確認時刻: {value.purposeUpdatedAt ? showTime(value.purposeUpdatedAt) : '未報告（鮮度不明）'}</p>
    </> : null}
  </div>;
}
function Execution({ value, sessions }: { value: TaskExecution; sessions: TaskSession[] }) {
  const sessionIds = value.sessionIds ?? (value.sessionId === null ? [] : [value.sessionId]);
  return <li className="rounded border border-border p-3 text-sm">
    <p className="font-semibold">実行ID: {value.id}</p>
    <p>ツール: {tools[value.tool]} · 端末: {value.host ?? '不明'}</p>
    <p>モデル: {value.model ?? '不明'}（{modelBasis[value.modelBasis]}）</p>
    <p>推論先: {value.provider ?? '不明'}</p>
    <p>記録された状態: {statuses[value.status]}（{statusBasis[value.statusBasis]}）</p>
    <p>関連セッション: {sessionIds.length ? sessionIds.join(', ') : '未ひも付け'}</p>
    {sessions.filter(session => sessionIds.includes(session.id)).map(session => <SessionDescription key={session.id} value={session} />)}
    <p className="text-xs text-muted">開始: {showTime(value.startedAt)} · 更新: {showTime(value.updatedAt)}</p>
    <FreshnessLabel value={value.freshness} />
  </li>;
}

export function TasksPage() {
  const [data, setData] = useState<TasksResponse | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [repositoryFilter, setRepositoryFilter] = useState<SessionFilterValue>();
  const [toolFilter, setToolFilter] = useState<SessionFilterValue>();
  const [hostFilter, setHostFilter] = useState<SessionFilterValue>();
  const resetSessionFilters = () => {
    setQuery(''); setRepositoryFilter(undefined); setToolFilter(undefined); setHostFilter(undefined);
  };
  const generation = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => onTokenChange(() => {
    generation.current += 1;
    activeRequest.current?.abort();
    setData(null);
    setQuery(''); setRepositoryFilter(undefined); setToolFilter(undefined); setHostFilter(undefined); setStatusFilter('all');
    setError(false);
    setReload(v => v + 1);
  }), []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController;
    const load = async () => {
      const epoch = generation.current;
      controller = new AbortController();
      activeRequest.current = controller;
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const result = await fetchTasks(controller.signal);
        if (!stopped && epoch === generation.current) { setData(result); setError(false); }
      } catch {
        if (!stopped && epoch === generation.current) { setData(null); setError(true); }
      } finally {
        clearTimeout(timeout);
        if (!stopped) timer = setTimeout(load, 10000);
      }
    };
    void load();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
  }, [reload]);
  const available = data?.state === 'ready' || data?.state === 'stale';
  const searchQuery = query.trim().toLocaleLowerCase();
  const visibleSessions = data?.sessions.filter(session =>
    (repositoryFilter === undefined || (session.workContext?.repository ?? null) === repositoryFilter)
    && (toolFilter === undefined || session.tool === toolFilter)
    && (hostFilter === undefined || session.host === hostFilter)
    && sessionSearch(session).toLocaleLowerCase().includes(searchQuery)) ?? [];
  const visibleTasks = data?.tasks.filter(task => {
    const executions = data.executions.filter(execution => execution.taskId === task.id);
    const linkedIds = new Set(executions.flatMap(execution => execution.sessionIds ?? (execution.sessionId === null ? [] : [execution.sessionId])));
    const searchText = [task.title, task.id, ...executions.flatMap(execution => [tools[execution.tool], execution.model ?? '']), ...data.sessions.filter(session => linkedIds.has(session.id)).map(sessionSearch)].join(' ').toLocaleLowerCase();
    return (statusFilter === 'all' || task.status === statusFilter) && searchText.includes(searchQuery);
  }) ?? [];
  return <div className="space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-xl font-semibold text-text-strong">Tasks</h1>
        <p className="mt-1 text-sm text-muted">表示を許可したセッション・タスクと実行履歴。読み取り専用です。</p></div>
      <button type="button" className="btn btn--sm" onClick={() => setReload(v => v + 1)}>再読込</button>
    </header>
    {!data && !error ? <p role="status">読み込み中…</p> : null}
    {error || data?.state === 'unavailable' ? <p className="panel p-4" role="alert">タスク情報を取得できません。接続または表示データを確認してください。</p> : null}
    {data?.state === 'disabled' ? <p className="panel p-4">Tasks連携は無効です。管理者が表示を許可した情報源を設定すると利用できます。</p> : null}
    {available && data ? <>
      <section className="panel space-y-2 p-4" aria-label="収集範囲">
        <h2 className="font-semibold">収集範囲</h2>
        <p className="text-sm text-muted">未登録のアプリ・起動経路を含む全タスクの一覧ではありません。未表示は未実行を意味しません。</p>
        {data.coverage.length ? <ul className="text-sm">{data.coverage.map(row => <li key={row.tool}>{tools[row.tool]}: {scopes[row.scope]}</li>)}</ul> : <p>収集範囲は未報告です。</p>}
        <p className="text-xs text-muted">一覧生成: {showTime(data.generatedAt)}。各項目の更新時刻とは異なります。</p>
        {data.state === 'stale' ? <p role="alert">一覧情報が古いため、現在の状態は確認できません。</p> : null}
      </section>
      <label className="grid gap-1 text-sm">全体検索（タスク・リポジトリ・参照番号・ツール・モデル・端末・セッションの説明）
        <input className="w-full rounded border border-border bg-transparent p-2" value={query} onChange={event => setQuery(event.target.value)} type="search" />
      </label>
      <section className="panel space-y-3 p-4" aria-label="セッション一覧">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">セッション一覧</h2>
          <p className="text-sm text-muted" role="status">{visibleSessions.length} / {data.sessions.length} セッションを表示</p>
        </div>
        <p className="text-sm text-muted">以下の絞込はセッション一覧のみに適用します。セッションの存在だけでは実行中とは判断しません。</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <SessionFilter label="リポジトリ" values={data.sessions.map(session => session.workContext?.repository ?? null)} value={repositoryFilter} onChange={setRepositoryFilter} />
          <SessionFilter label="ツール" values={data.sessions.map(session => session.tool)} value={toolFilter} onChange={setToolFilter} display={value => tools[value as TaskTool]} />
          <SessionFilter label="端末" values={data.sessions.map(session => session.host)} value={hostFilter} onChange={setHostFilter} />
        </div>
        <button type="button" className="btn btn--sm" aria-label="検索とセッション絞込をリセット" onClick={resetSessionFilters}>検索とセッション絞込をリセット</button>
        {visibleSessions.length === 0 ? <p>{data.sessions.length ? '条件に一致するセッションはありません。' : '収集範囲内に表示可能なセッションはありません。'}</p> : null}
        <ul className="grid gap-3 text-sm md:grid-cols-2">{visibleSessions.map(session => <li className="min-w-0 rounded border border-border p-3" key={session.id}>
          <SessionDescription value={session} />
          <p className="mt-2 break-words">{tools[session.tool]} · {session.host ?? '端末未報告'} · {showTime(session.updatedAt)} · <FreshnessLabel value={session.freshness} /></p>
          <p className="text-xs text-muted">{session.linked ? '登録タスクと関連あり（実行履歴を参照）' : 'タスクとの関係は未確認'}</p>
        </li>)}</ul>
      </section>
      {data.tasks.length > 0 ? <section className="space-y-3" aria-label="登録タスク">
        <h2 className="font-semibold">登録タスク</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">タスクの状態で絞込（登録タスクのみに適用）
            <select className="rounded border border-border bg-transparent p-2" aria-label="登録タスクの状態" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
              <option value="all">すべて</option>
              {Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <p className="text-sm text-muted" role="status">{visibleTasks.length} / {data.tasks.length} タスクを表示</p>
        </div>
        {visibleTasks.length === 0 ? <p>条件に一致するタスクはありません。</p> : null}
      {visibleTasks.map(task => {
        const attempts = data.executions.filter(execution => execution.taskId === task.id);
        const children = data.tasks.filter(child => child.parentTaskId === task.id);
        return <article className="panel space-y-3 p-4" key={task.id} id={`task-${task.id}`}>
          <h2 className="break-words font-semibold text-text-strong">{task.title}</h2>
          <p className="text-sm">報告された状態: {statuses[task.status]} · <FreshnessLabel value={task.freshness} /></p>
          <p className="text-sm">{attempts.length ? [...new Set(attempts.map(execution => `${tools[execution.tool]} / ${execution.model ?? 'モデル不明'}（${modelBasis[execution.modelBasis]}）`))].join(' · ') : '実行は未報告'}</p>
          <details className="space-y-3"><summary className="cursor-pointer text-sm text-accent">進捗・親子関係・実行履歴を表示</summary>
          <p className="text-xs text-muted">タスクID: {task.id}</p>
          {task.parentTaskId ? <a className="text-sm text-accent" href={`#task-${task.parentTaskId}`}>親タスク: {task.parentTaskId}</a> : <p className="text-sm text-muted">親タスク未報告</p>}
          {children.length ? <p className="text-sm">子タスク: {children.map((child, index) => <span key={child.id}>{index ? ', ' : ''}<a className="text-accent" href={`#task-${child.id}`}>{child.title}</a></span>)}</p> : null}
          <p className="text-sm">報告された状態: {statuses[task.status]} · 工程: {task.stage ?? '未報告'}</p>
          <p className="text-sm">受入条件: {task.acceptance ? `${task.acceptance.completed} / ${task.acceptance.total} 完了` : '未報告'}</p>
          <p className="break-words text-sm">進捗報告: {task.summary ?? '未報告'}</p>
          <p className="text-xs text-muted">更新: {showTime(task.updatedAt)} · <FreshnessLabel value={task.freshness} /></p>
          <h3 className="text-sm font-semibold">実行履歴（{attempts.length}）</h3>
          {attempts.length ? <ul className="grid gap-3 md:grid-cols-2">{attempts.map(execution => <Execution key={execution.id} value={execution} sessions={data.sessions} />)}</ul> : <p className="text-sm text-muted">実行は未報告です。</p>}
          </details>
        </article>;
      })}
      </section> : null}
    </> : null}
  </div>;
}
