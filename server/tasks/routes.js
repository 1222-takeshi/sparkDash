import { createTasksReader } from './feed.js';

export function registerTasksRoutes(app, read = createTasksReader()) {
  app.get('/api/tasks', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.json(await read());
  });
}
