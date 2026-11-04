import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_BYTES = 1024 * 1024;
const STALE_MS = 120_000;
const TOOLS = ['codex', 'claude-code', 'local-llm', 'other', 'unknown'];
const STATUSES = ['queued', 'running', 'blocked', 'completed', 'failed', 'cancelled', 'unknown'];
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const invalid = () => { throw new Error('Invalid task feed'); };
function object(value, keys, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k) && !optional.includes(k)) || keys.some(k => !Object.hasOwn(value, k))) invalid();
}
function text(value, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  return value;
}
function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) invalid();
  return value;
}
const nullable = (value, check) => value === null ? null : check(value);
function choice(value, choices) { if (!choices.includes(value)) invalid(); return value; }
function timestamp(value, now) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || Date.parse(value) > now + 30_000) invalid();
  if (new Date(value).toISOString() !== (value.includes('.') ? value : value.replace('Z', '.000Z'))) invalid();
  return value;
}
function workContext(value, now) {
  if (value === null) return null;
  object(value, ['repository', 'taskName', 'taskRef', 'basis', 'updatedAt']);
  const repository = nullable(value.repository, label => {
    text(label);
    if (/[:@\\~]/u.test(label) || label.startsWith('/') || label.split('/').length > 2 || label.split('/').some(part => !part.trim() || part === '.' || part === '..')) invalid();
    return label;
  });
  const taskName = nullable(value.taskName, label => text(label));
  const taskRef = nullable(value.taskRef, ref => {
    text(ref, 64);
    if (!/^(?:#[1-9][0-9]*|[A-Z][A-Z0-9]*-[1-9][0-9]*)$/.test(ref)) invalid();
    return ref;
  });
  const basis = choice(value.basis, ['reported', 'reviewed', 'unknown']);
  const updatedAt = timestamp(value.updatedAt, now);
  const unknown = repository === null && taskName === null && taskRef === null;
  if (unknown !== (basis === 'unknown') || (unknown && updatedAt !== null)) invalid();
  return { repository, taskName, taskRef, basis, updatedAt };
}
const freshness = (stamp, now) => stamp === null ? 'unknown' : now - Date.parse(stamp) > STALE_MS ? 'stale' : 'fresh';
function rows(value, max = 500) { if (!Array.isArray(value) || value.length > max) invalid(); return value; }
function unique(items) { const ids = new Set(items.map(v => v.id)); if (ids.size !== items.length) invalid(); return ids; }
function aliasMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 100) invalid();
  for (const [key, label] of Object.entries(value)) { id(key); text(label, 100); }
  return value;
}
function alias(ref, map) { return nullable(ref, key => { id(key); if (!Object.hasOwn(map, key)) invalid(); return map[key]; }); }
function empty(state) { return { state, generatedAt: null, coverage: [], tasks: [], executions: [], sessions: [] }; }

// displayApprovedは送信側の審査済み宣言であり、任意の秘密文字列を検出する機構ではない。
export function projectFeed(feed, now = Date.now()) {
  object(feed, ['schemaVersion', 'displayApproved', 'generatedAt', 'coverage', 'aliases', 'tasks', 'executions', 'sessions']);
  if (feed.schemaVersion !== 1 || feed.displayApproved !== true) invalid();
  const generatedAt = timestamp(feed.generatedAt, now);
  if (generatedAt === null) invalid();
  object(feed.aliases, ['hosts', 'providers']);
  const hosts = aliasMap(feed.aliases.hosts), providers = aliasMap(feed.aliases.providers);
  const coverage = rows(feed.coverage, 5).map(row => {
    object(row, ['tool', 'scope']);
    return { tool: choice(row.tool, TOOLS), scope: choice(row.scope, ['partial', 'complete', 'unsupported']) };
  });
  if (new Set(coverage.map(row => row.tool)).size !== coverage.length) invalid();
  const tasks = rows(feed.tasks).map(row => {
    object(row, ['id', 'parentTaskId', 'title', 'status', 'stage', 'summary', 'acceptance', 'updatedAt']);
    let acceptance = null;
    if (row.acceptance !== null) {
      object(row.acceptance, ['completed', 'total']);
      const { completed, total } = row.acceptance;
      if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || completed < 0 || total < 1 || total > 10000 || completed > total) invalid();
      acceptance = { completed, total };
    }
    const updatedAt = timestamp(row.updatedAt, now);
    return { id: id(row.id), parentTaskId: nullable(row.parentTaskId, id), title: text(row.title), status: choice(row.status, STATUSES), stage: nullable(row.stage, v => text(v, 80)), summary: nullable(row.summary, v => text(v, 500)), acceptance, updatedAt, freshness: freshness(updatedAt, now) };
  });
  const taskIds = unique(tasks), parents = new Map(tasks.map(t => [t.id, t.parentTaskId]));
  for (const task of tasks) {
    const seen = new Set([task.id]);
    for (let parent = task.parentTaskId; parent !== null; parent = parents.get(parent)) {
      if (!taskIds.has(parent) || seen.has(parent)) invalid();
      seen.add(parent);
    }
  }
  const sessions = rows(feed.sessions).map(row => {
    object(row, ['id', 'tool', 'hostRef', 'updatedAt'], ['title', 'purpose', 'purposeBasis', 'purposeUpdatedAt', 'workContext']);
    const updatedAt = timestamp(row.updatedAt, now);
    const title = nullable(Object.hasOwn(row, 'title') ? row.title : null, value => text(value));
    const purpose = nullable(Object.hasOwn(row, 'purpose') ? row.purpose : null, value => text(value, 500));
    const purposeBasis = choice(Object.hasOwn(row, 'purposeBasis') ? row.purposeBasis : 'unknown', ['manual', 'reviewed-summary', 'unknown']);
    const purposeUpdatedAt = timestamp(Object.hasOwn(row, 'purposeUpdatedAt') ? row.purposeUpdatedAt : null, now);
    if ((purpose === null) !== (purposeBasis === 'unknown') || (purpose === null && purposeUpdatedAt !== null)) invalid();
    return { id: id(row.id), tool: choice(row.tool, TOOLS), host: alias(row.hostRef, hosts), updatedAt, freshness: freshness(updatedAt, now), linked: false, title, purpose, purposeBasis, purposeUpdatedAt, workContext: workContext(Object.hasOwn(row, 'workContext') ? row.workContext : null, now) };
  });
  const sessionIds = unique(sessions);
  const executions = rows(feed.executions, 1000).map(row => {
    object(row, ['id', 'taskId', 'sessionId', 'tool', 'model', 'modelBasis', 'providerRef', 'hostRef', 'status', 'statusBasis', 'startedAt', 'updatedAt'], ['sessionIds']);
    if (!taskIds.has(row.taskId) || (row.sessionId !== null && !sessionIds.has(row.sessionId))) invalid();
    const relatedSessions = Object.hasOwn(row, 'sessionIds') ? rows(row.sessionIds) : row.sessionId === null ? [] : [row.sessionId];
    if (new Set(relatedSessions).size !== relatedSessions.length || relatedSessions.some(sid => !sessionIds.has(sid)) || row.sessionId !== (relatedSessions.length === 1 ? relatedSessions[0] : null)) invalid();
    const updatedAt = timestamp(row.updatedAt, now), startedAt = timestamp(row.startedAt, now);
    if (updatedAt !== null && startedAt !== null && Date.parse(updatedAt) < Date.parse(startedAt)) invalid();
    const modelBasis = choice(row.modelBasis, ['reported', 'configured', 'unknown']);
    const statusBasis = choice(row.statusBasis, ['reported', 'observed', 'recorded', 'unknown']);
    if ((row.model === null) !== (modelBasis === 'unknown') || (row.status === 'unknown') !== (statusBasis === 'unknown')) invalid();
    return { id: id(row.id), taskId: row.taskId, sessionId: row.sessionId, sessionIds: [...relatedSessions], tool: choice(row.tool, TOOLS), model: nullable(row.model, v => text(v)), modelBasis, provider: alias(row.providerRef, providers), host: alias(row.hostRef, hosts), status: choice(row.status, STATUSES), statusBasis, startedAt, updatedAt, freshness: freshness(updatedAt, now) };
  });
  unique(executions);
  const linked = new Set(executions.flatMap(e => e.sessionIds));
  for (const session of sessions) session.linked = linked.has(session.id);
  return { state: freshness(generatedAt, now) === 'stale' ? 'stale' : 'ready', generatedAt, coverage, tasks, executions, sessions };
}

function inside(file, root) { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
async function readPrivateFile(file, sourceRoot, ownerUid) {
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0) invalid();
  if (typeof file !== 'string' || !path.isAbsolute(file) || !constants.O_NOFOLLOW) invalid();
  const resolved = path.resolve(file);
  if (await realpath(resolved) !== resolved || inside(resolved, await realpath(sourceRoot))) invalid();
  // 親ディレクトリにもsymlink/書込み権限を確認し、別のcheckoutやworktree内も拒否する。
  for (let dir = path.dirname(resolved); ; dir = path.dirname(dir)) {
    const stat = await lstat(dir);
    if (!stat.isDirectory() || (stat.uid !== ownerUid && stat.uid !== 0) || ((stat.mode & 0o022) && !(stat.uid === 0 && (stat.mode & 0o1000)))) invalid();
    try { await lstat(path.join(dir, '.git')); invalid(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dir === path.dirname(dir)) break;
  }
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== ownerUid || (stat.mode & 0o077) || stat.size > MAX_BYTES) invalid();
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) invalid();
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) invalid();
    return JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } finally { await handle.close(); }
}

export function createTasksReader({ enabled = process.env.SPARKDASH_TASKS_ENABLED === '1', file = process.env.SPARKDASH_TASKS_FEED, sourceRoot = ROOT, ownerUid = process.env.SPARKDASH_TASKS_FEED_UID === undefined ? process.getuid?.() : (/^(0|[1-9][0-9]*)$/.test(process.env.SPARKDASH_TASKS_FEED_UID) ? Number(process.env.SPARKDASH_TASKS_FEED_UID) : NaN), now = Date.now, readFile = readPrivateFile } = {}) {
  let pending = null;
  return async () => {
    if (!enabled) return empty('disabled');
    // 低速なfilesystemでもHTTP応答を制限し、同時readを増殖させない。
    if (!pending) pending = readFile(file, sourceRoot, ownerUid).then(feed => projectFeed(feed, now())).catch(() => empty('unavailable')).finally(() => { pending = null; });
    let timer;
    try { return await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(empty('unavailable')), 1500); })]); }
    finally { clearTimeout(timer); }
  };
}
