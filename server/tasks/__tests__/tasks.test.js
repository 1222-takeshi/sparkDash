import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, link, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTasksReader, projectFeed, MAX_BYTES } from '../feed.js';

const now = Date.parse('2030-01-02T03:04:05Z');
const stamp = new Date(now).toISOString();
function fixture() {
  return { schemaVersion: 1, displayApproved: true, generatedAt: stamp,
    coverage: [{ tool: 'codex', scope: 'partial' }, { tool: 'claude-code', scope: 'unsupported' }],
    aliases: { hosts: { desk: 'Demo workstation' }, providers: { cloud: 'Demo hosted provider' } },
    tasks: [{ id: 'task-a', parentTaskId: null, title: 'Synthetic task', status: 'running', stage: 'review', summary: 'Synthetic report', acceptance: { completed: 1, total: 2 }, updatedAt: stamp },
      { id: 'task-b', parentTaskId: 'task-a', title: 'Synthetic child', status: 'unknown', stage: null, summary: null, acceptance: null, updatedAt: null }],
    executions: [{ id: 'run-a', taskId: 'task-a', sessionId: 'session-a', tool: 'codex', model: 'synthetic-model-a', modelBasis: 'reported', providerRef: 'cloud', hostRef: 'desk', status: 'completed', statusBasis: 'reported', startedAt: stamp, updatedAt: stamp },
      { id: 'run-b', taskId: 'task-a', sessionId: null, tool: 'local-llm', model: null, modelBasis: 'unknown', providerRef: null, hostRef: null, status: 'running', statusBasis: 'recorded', startedAt: null, updatedAt: null }],
    sessions: [{ id: 'session-a', tool: 'codex', hostRef: 'desk', updatedAt: stamp }, { id: 'session-orphan', tool: 'other', hostRef: null, updatedAt: null }] };
}
async function fileFixture(content = JSON.stringify(fixture())) {
  const dir = await mkdtemp(path.join(tmpdir(), 'synthetic-tasks-'));
  const file = path.join(dir, 'feed.json');
  await writeFile(file, content, { mode: 0o600 });
  return { dir, file, read: createTasksReader({ enabled: true, file, now: () => now }) };
}

test('disabled performs no provider I/O even with an invalid path', async () => {
  const read = createTasksReader({ enabled: false, file: '/does/not/exist', readFile: () => { throw Error('I/O'); } });
  assert.equal((await read()).state, 'disabled');
});
test('projects tools, actual model, aliases, separate IDs, attempts and orphan sessions', () => {
  const result = projectFeed(fixture(), now);
  assert.equal(result.tasks[1].parentTaskId, 'task-a');
  assert.equal(result.executions.length, 2);
  assert.equal(result.executions[0].provider, 'Demo hosted provider');
  assert.equal(result.executions[0].host, 'Demo workstation');
  assert.equal(result.executions[1].model, null);
  assert.equal(result.sessions[1].linked, false);
  assert.equal(result.tasks[1].freshness, 'unknown');
  assert.ok(!JSON.stringify(result).includes('providerRef'));
});
test('old reports stay stale even if feed was freshly generated', () => {
  const feed = fixture(); feed.tasks[0].updatedAt = new Date(now - 121000).toISOString();
  const result = projectFeed(feed, now);
  assert.equal(result.tasks[0].freshness, 'stale');
  assert.equal(result.tasks[0].acceptance.completed, 1);
  feed.generatedAt = new Date(now - 121000).toISOString();
  assert.equal(projectFeed(feed, now).state, 'stale');
});
for (const [name, mutate] of [
  ['approval absent', f => { delete f.displayApproved; }],
  ['secret extra field', f => { f.tasks[0].rawLog = 'SYNTHETIC_SECRET'; }],
  ['impossible calendar date', f => { f.tasks[0].updatedAt = '2029-02-31T00:00:00Z'; }],
  ['future feed', f => { f.generatedAt = new Date(now + 31000).toISOString(); }],
  ['future report', f => { f.tasks[0].updatedAt = new Date(now + 31000).toISOString(); }],
  ['dangling parent', f => { f.tasks[0].parentTaskId = 'missing'; }],
  ['parent cycle', f => { f.tasks[0].parentTaskId = 'task-b'; }],
  ['duplicate ID', f => { f.tasks[1].id = 'task-a'; }],
  ['bad execution link', f => { f.executions[0].taskId = 'missing'; }],
  ['bad session link', f => { f.executions[0].sessionId = 'missing'; }],
  ['unmapped provider', f => { f.executions[0].providerRef = 'missing'; }],
  ['invalid acceptance', f => { f.tasks[0].acceptance.completed = 3; }],
  ['too many records', f => { f.tasks = Array(501).fill(f.tasks[0]); }],
]) test(`rejects ${name} without reflecting input`, async () => {
  const feed = fixture(); mutate(feed);
  const { read } = await fileFixture(JSON.stringify(feed));
  const result = await read();
  assert.equal(result.state, 'unavailable');
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SECRET'));
  assert.deepEqual(result.tasks, []);
});
test('regular private feed succeeds and missing file returns generic unavailable', async () => {
  const { read, dir } = await fileFixture();
  assert.equal((await read()).state, 'ready');
  const result = await createTasksReader({ enabled: true, file: path.join(dir, 'missing') })();
  assert.equal(result.state, 'unavailable');
  assert.ok(!JSON.stringify(result).includes(dir));
});
test('rejects malformed, oversized, symlink, hardlink, public permission and directory inputs', async () => {
  for (const value of ['SYNTHETIC_SECRET {', ' '.repeat(MAX_BYTES + 1)]) {
    assert.equal((await (await fileFixture(value)).read()).state, 'unavailable');
  }
  const { file, dir, read } = await fileFixture();
  await chmod(file, 0o644);
  assert.equal((await read()).state, 'unavailable');
  await chmod(file, 0o600);
  const sym = path.join(dir, 'symbolic'); await symlink(file, sym);
  assert.equal((await createTasksReader({ enabled: true, file: sym })()).state, 'unavailable');
  const hard = path.join(dir, 'hard'); await link(file, hard);
  assert.equal((await read()).state, 'unavailable');
  assert.equal((await createTasksReader({ enabled: true, file: dir })()).state, 'unavailable');
});
test('rejects symlinked parent, unsafe parent, relative path and source-tree feed', async () => {
  const { dir, file } = await fileFixture();
  const parent = await mkdtemp(path.join(tmpdir(), 'synthetic-links-'));
  const sym = path.join(parent, 'linked'); await symlink(dir, sym);
  assert.equal((await createTasksReader({ enabled: true, file: path.join(sym, 'feed.json') })()).state, 'unavailable');
  await chmod(dir, 0o777);
  assert.equal((await createTasksReader({ enabled: true, file })()).state, 'unavailable');
  assert.equal((await createTasksReader({ enabled: true, file: 'relative.json' })()).state, 'unavailable');
  assert.equal((await createTasksReader({ enabled: true, file, sourceRoot: dir })()).state, 'unavailable');
});

test('rejects a feed inside any checkout or linked worktree', async () => {
  for (const worktree of [false, true]) {
    const { dir, file } = await fileFixture();
    if (worktree) await writeFile(path.join(dir, '.git'), 'gitdir: synthetic');
    else await mkdir(path.join(dir, '.git'));
    assert.equal((await createTasksReader({ enabled: true, file })()).state, 'unavailable');
  }
});
test('unknown coverage and model/status provenance are not fabricated', () => {
  const feed = fixture(); feed.coverage = [];
  feed.executions[1].status = 'unknown'; feed.executions[1].statusBasis = 'unknown';
  const projected = projectFeed(feed, now);
  assert.deepEqual(projected.coverage, []);
  assert.equal(projected.executions[1].status, 'unknown');
  feed.executions[1].modelBasis = 'reported';
  assert.throws(() => projectFeed(feed, now), /Invalid task feed/);
});
test('API sends only projected data, no cache, and does not register write routes', async () => {
  const { registerTasksRoutes } = await import('../routes.js');
  const registrations = [];
  const app = { get: (url, handler) => registrations.push({ url, handler }) };
  registerTasksRoutes(app, async () => projectFeed(fixture(), now));
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].url, '/api/tasks');
  const headers = {}; let body;
  await registrations[0].handler({}, { set: (key, value) => { headers[key] = value; }, json: value => { body = value; } });
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(body.executions[0].provider, 'Demo hosted provider');
  assert.ok(!Object.hasOwn(body, 'aliases'));
});

test('explicit trusted owner UID is checked, including invalid configuration', async () => {
  const { file } = await fileFixture();
  assert.equal((await createTasksReader({ enabled: true, file, ownerUid: process.getuid(), now: () => now })()).state, 'ready');
  for (const ownerUid of [process.getuid() + 1, -1, NaN, 0.5, '0']) {
    assert.equal((await createTasksReader({ enabled: true, file, ownerUid })()).state, 'unavailable');
  }
});

test('timeout bounds responses and keeps a single pending read', async () => {
  let resolve; let calls = 0;
  const pending = new Promise(done => { resolve = done; });
  const read = createTasksReader({ enabled: true, now: () => now, readFile: () => { calls++; return pending; } });
  const responses = await Promise.all([read(), read()]);
  assert.ok(responses.every(response => response.state === 'unavailable'));
  assert.equal(calls, 1);
  const next = read(); resolve(fixture());
  assert.equal((await next).state, 'ready');
  assert.equal(calls, 1);
});

test('optional sessionIds retains all known links without guessing a current session', () => {
  const feed = fixture();
  feed.executions[0].sessionId = null;
  feed.executions[0].sessionIds = ['session-a', 'session-orphan'];
  const result = projectFeed(feed, now);
  assert.equal(result.executions[0].sessionId, null);
  assert.deepEqual(result.executions[0].sessionIds, ['session-a', 'session-orphan']);
  assert.ok(result.sessions.every(session => session.linked));
  assert.deepEqual(projectFeed(fixture(), now).executions[0].sessionIds, ['session-a']);
});

test('sessionIds rejects duplicate, dangling and inconsistent primary links', () => {
  for (const ids of [['session-a', 'session-a'], ['missing'], [], ['session-a', 'session-orphan'], 'session-a']) {
    const feed = fixture(); feed.executions[0].sessionIds = ids;
    assert.throws(() => projectFeed(feed, now), /Invalid task feed/);
  }
});
