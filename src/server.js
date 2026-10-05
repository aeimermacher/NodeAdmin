import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as auth from './auth.js';
import * as services from './services.js';
import { startMonitor } from './monitor.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;

if (!PASSWORD_HASH) {
  console.error('ADMIN_PASSWORD_HASH is not set. Generate one with: npm run hash-password');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});

app.use(express.json({ limit: '32kb' }));

// CSRF protection: a custom header cannot be sent cross-origin without a CORS preflight.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'NodeAdmin') {
    return res.status(403).json({ error: 'Missing X-Requested-With header' });
  }
  next();
});

app.get('/api/me', (req, res) => {
  res.json({ authenticated: Boolean(auth.getSession(req)) });
});

app.post('/api/login', async (req, res) => {
  if (auth.isRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many failed attempts, try again later' });
  }
  if (!(await auth.verifyPassword(req.body?.password ?? '', PASSWORD_HASH))) {
    auth.recordFailedLogin(req.ip);
    return res.status(401).json({ error: 'Invalid password' });
  }
  auth.clearFailedLogins(req.ip);
  auth.startSession(req, res);
  res.json({ authenticated: true });
});

app.post('/api/logout', (req, res) => {
  auth.endSession(req, res);
  res.status(204).end();
});

app.use('/api', (req, res, next) => {
  if (!auth.getSession(req)) return res.status(401).json({ error: 'Not authenticated' });
  next();
});

app.get('/api/services', async (req, res) => {
  res.json(await services.list());
});

app.post('/api/services', async (req, res) => {
  res.status(201).json(await services.create(req.body ?? {}));
});

app.post('/api/services/import', async (req, res) => {
  res.status(201).json(await services.importUnit(req.body ?? {}));
});

app.get('/api/units', async (req, res) => {
  res.json(await services.listUnits(req.query.scope));
});

app.delete('/api/services/:name', async (req, res) => {
  await services.remove(req.params.name);
  res.status(204).end();
});

app.get('/api/services/:name/repository', async (req, res) => {
  res.json(await services.repository(req.params.name));
});

app.patch('/api/services/:name', async (req, res) => {
  res.json(await services.changeRepository(req.params.name, req.body ?? {}));
});

app.post('/api/services/:name/:action', async (req, res) => {
  res.json(await services.action(req.params.name, req.params.action));
});

app.get('/api/services/:name/logs', async (req, res) => {
  res.type('text/plain').send(await services.logs(req.params.name, req.query.lines));
});

app.get('/api/services/:name/readme', async (req, res) => {
  res.json(await services.readme(req.params.name));
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));

app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, HOST, () => {
  console.log(`NodeAdmin listening on http://${HOST}:${PORT}`);
  startMonitor();
});
