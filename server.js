// ReqForge — Express backend.
// Admin API (password-protected) + public customer questionnaire API.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  db, makeSlug, rowToProject, rowToSubmission, resolveModules, defaultConfig, storageInfo
} from './lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (zero dependencies). Values in the real environment win.
function loadEnv() {
  let src;
  try { src = fs.readFileSync(path.join(__dirname, '.env'), 'utf8'); }
  catch { return; }
  for (const line of src.split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m || m[1] in process.env) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[m[1]] = val;
  }
}
loadEnv();

const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'pavit').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '5161211';
const DEFAULT_CREDENTIALS = ADMIN_USERNAME === 'pavit' && ADMIN_PASSWORD === '5161211';
const SESSION_COOKIE = 'rf_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days — matches the cookie Max-Age

// Stateless, HMAC-signed session tokens. Nothing is stored server-side, so any
// instance can verify a token it didn't issue: sessions survive restarts,
// `node --watch` reloads and serverless deployments (e.g. Vercel), where each
// request may run in a completely fresh process. (The old in-memory session
// table lost every session in exactly those cases, which bounced admins back
// to the sign-in screen on the next click.)
const SESSION_SECRET = crypto.createHash('sha256')
  .update(process.env.SESSION_SECRET || `reqforge-session|${ADMIN_USERNAME}|${ADMIN_PASSWORD}`)
  .digest();
// Deriving the default secret from the credentials means rotating them
// automatically invalidates every outstanding session.

function signPayload(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

function makeSessionToken() {
  const payload = `admin.${Date.now()}.${crypto.randomBytes(16).toString('base64url')}`;
  return `${payload}.${signPayload(payload)}`;
}

function isValidSessionToken(token) {
  if (typeof token !== 'string' || !token || token.length > 512) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const [kind, issuedRaw] = payload.split('.');
  const issued = Number(issuedRaw);
  if (kind !== 'admin' || !Number.isFinite(issued)) return false;
  if (issued > Date.now() + 60_000 || Date.now() - issued > SESSION_TTL_MS) return false;
  const expected = signPayload(payload);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Signed preview links let an admin open a draft/closed questionnaire in a new
// tab even when the session cookie is not sent (third-party iframe previews,
// partitioned cookies, some mobile browsers). Tokens are scoped to one slug.
const PREVIEW_TTL_MS = 1000 * 60 * 60 * 24;

function makePreviewToken(slug) {
  const payload = `preview.${slug}.${Date.now() + PREVIEW_TTL_MS}`;
  return `${payload}.${signPayload(payload)}`;
}

function isValidPreviewToken(token, slug) {
  if (typeof token !== 'string' || !token || token.length > 512) return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const m = payload.match(/^preview\.(.+)\.(\d+)$/);
  if (!m || m[1] !== String(slug)) return false;
  const exp = Number(m[2]);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expected = signPayload(payload);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function presentProject(project) {
  if (!project?.slug) return project;
  return {
    ...project,
    preview_path: `/c/${encodeURIComponent(project.slug)}?preview=${makePreviewToken(project.slug)}`
  };
}

function publicAccess(req, slug) {
  if (isValidSessionToken(req.cookies[SESSION_COOKIE])) return 'admin';
  const preview = req.query?.preview;
  if (preview && isValidPreviewToken(String(preview), slug)) return 'preview';
  return null;
}

function sessionCookie(req, token) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = proto === 'https' || Boolean(req.secure);
  const base = token
    ? `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`
    : `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  return secure ? `${base}; Secure` : base;
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Async route handlers must not be allowed to turn a rejected promise into a
// process crash — funnel every error into a JSON response instead.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------- helpers
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) {
      const key = part.slice(0, i).trim();
      const rawVal = part.slice(i + 1).trim();
      try {
        out[key] = decodeURIComponent(rawVal);
      } catch {
        out[key] = rawVal;
      }
    }
  }
  return out;
}
app.use((req, _res, next) => { req.cookies = parseCookies(req); next(); });

function requireAuth(req, res, next) {
  if (isValidSessionToken(req.cookies[SESSION_COOKIE])) return next();
  res.status(401).json({ error: 'Not signed in' });
}

function sendError(res, status, message) {
  res.status(status).json({ error: message });
}

const isBlank = v => v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
const QUESTION_TYPES = new Set(['text', 'textarea', 'checkbox', 'radio', 'rating']);

// Keep project configurations well-formed even when the API is called directly.
// Built-in questions are stored as IDs; custom questions are stored as a small,
// validated object alongside the selected module.
function normalizeConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || !Array.isArray(config.modules)) {
    throw new Error('Config must include a modules array.');
  }
  const modules = [];
  const seenModules = new Set();
  for (const moduleConfig of config.modules) {
    const module = LIBRARY.find(m => m.id === moduleConfig?.id);
    if (!module || seenModules.has(module.id)) continue;
    seenModules.add(module.id);
    const questions = [];
    const seenQuestions = new Set();
    for (const question of Array.isArray(moduleConfig.questions) ? moduleConfig.questions : []) {
      if (typeof question === 'string') {
        if (module.questions.some(q => q.id === question) && !seenQuestions.has(question)) {
          questions.push(question);
          seenQuestions.add(question);
        }
        continue;
      }
      if (!question || typeof question !== 'object') continue;
      const id = String(question.id || '').trim();
      const label = String(question.label || '').trim();
      const type = String(question.type || 'text');
      const options = Array.isArray(question.options)
        ? question.options.map(option => String(option).trim()).filter(Boolean).slice(0, 50)
        : [];
      if (!id || !label || id.length > 100 || label.length > 500 || !QUESTION_TYPES.has(type) || seenQuestions.has(id)) continue;
      if ((type === 'checkbox' || type === 'radio') && !options.length) continue;
      questions.push({ id, type, label, help: String(question.help || '').slice(0, 1000), options, required: Boolean(question.required), placeholder: String(question.placeholder || '').slice(0, 500) });
      seenQuestions.add(id);
    }
    if (questions.length) modules.push({ id: module.id, questions });
  }
  return { modules };
}

// ---------------------------------------------------------------- auth
app.post('/api/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password ?? '');
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    res.setHeader('Set-Cookie', sessionCookie(req, makeSessionToken()));
    return res.json({ ok: true });
  }
  sendError(res, 401, 'Wrong username or password');
});

app.post('/api/logout', (req, res) => {
  // Stateless tokens: dropping the cookie is the logout. (To revoke tokens for
  // every device at once, change ADMIN_PASSWORD or SESSION_SECRET.)
  res.setHeader('Set-Cookie', sessionCookie(req, ''));
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (isValidSessionToken(req.cookies[SESSION_COOKIE])) {
    return res.json({ ok: true, admin: ADMIN_USERNAME, defaultCredentials: DEFAULT_CREDENTIALS, storage: storageInfo });
  }
  sendError(res, 401, 'Not signed in');
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, storage: storageInfo, node: process.version });
});

async function findProjectRow(idOrSlug) {
  if (idOrSlug === null || idOrSlug === undefined || idOrSlug === '') return null;
  const idNum = Number(idOrSlug);
  if (Number.isInteger(idNum) && idNum > 0) {
    const row = await db.get('SELECT * FROM projects WHERE id = ?', idNum);
    if (row) return row;
  }
  return db.get('SELECT * FROM projects WHERE slug = ?', String(idOrSlug));
}

// ---------------------------------------------------------------- library
import { LIBRARY } from './lib/library.js';
app.get('/api/library', requireAuth, (_req, res) => {
  res.json({ modules: LIBRARY });
});

// ---------------------------------------------------------------- projects (admin)
app.get('/api/projects', requireAuth, wrap(async (_req, res) => {
  const rows = await db.all(`
    SELECT p.*, (SELECT COUNT(*) FROM submissions s WHERE s.project_id = p.id) AS submissions
    FROM projects p ORDER BY p.id DESC
  `);
  res.json({ projects: rows.map(row => presentProject(rowToProject(row))) });
}));

app.post('/api/projects', requireAuth, wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return sendError(res, 400, 'Project name is required');
  if (name.length > 200) return sendError(res, 400, 'Project name must be 200 characters or fewer');
  const slug = await makeSlug(name);
  let config = defaultConfig();
  if (req.body?.config) {
    try { config = normalizeConfig(req.body.config); } catch (e) { return sendError(res, 400, e.message); }
  }
  const status = ['draft', 'live', 'closed'].includes(req.body?.status) ? req.body.status : 'draft';
  const tagline = String(req.body?.tagline || '').trim().slice(0, 5000);
  const welcome = String(req.body?.welcome || '').trim().slice(0, 5000);
  const closing = String(req.body?.closing || '').trim().slice(0, 5000);
  const r = await db.run(
    'INSERT INTO projects (slug, name, tagline, welcome, closing, status, config) VALUES (?, ?, ?, ?, ?, ?, ?)',
    slug, name, tagline, welcome, closing, status, JSON.stringify(config)
  );
  const row = await db.get('SELECT * FROM projects WHERE id = ?', Number(r.lastInsertRowid));
  res.status(201).json({ project: presentProject(rowToProject(row)) });
}));

app.get('/api/projects/:id', requireAuth, wrap(async (req, res) => {
  const row = await findProjectRow(req.params.id);
  if (!row) return sendError(res, 404, 'Project not found');
  res.json({ project: presentProject(rowToProject(row)) });
}));

app.patch('/api/projects/:id', requireAuth, wrap(async (req, res) => {
  const row = await findProjectRow(req.params.id);
  if (!row) return sendError(res, 404, 'Project not found');

  const allowed = ['name', 'tagline', 'welcome', 'closing', 'status', 'config'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (req.body && req.body[key] !== undefined) {
      if (key === 'config') {
        let config;
        try { config = normalizeConfig(req.body[key]); }
        catch (error) { return sendError(res, 400, error.message); }
        sets.push('config = ?');
        params.push(JSON.stringify(config));
      } else if (key === 'status') {
        if (!['draft', 'live', 'closed'].includes(req.body[key])) return sendError(res, 400, 'Invalid status');
        sets.push('status = ?');
        params.push(req.body[key]);
      } else {
        const text = String(req.body[key]).trim();
        const max = key === 'name' ? 200 : 5000;
        if (key === 'name' && !text) return sendError(res, 400, 'Project name is required');
        if (text.length > max) return sendError(res, 400, `${key} must be ${max} characters or fewer`);
        sets.push(`${key} = ?`);
        params.push(text);
      }
    }
  }
  if (!sets.length) return sendError(res, 400, 'Nothing to update');
  params.push(row.id);
  await db.run(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, ...params);
  const updated = await db.get('SELECT * FROM projects WHERE id = ?', row.id);
  res.json({ project: presentProject(rowToProject(updated)) });
}));

app.delete('/api/projects/:id', requireAuth, wrap(async (req, res) => {
  const row = await findProjectRow(req.params.id);
  if (!row) return sendError(res, 404, 'Project not found');
  await db.run('DELETE FROM submissions WHERE project_id = ?', row.id);
  const r = await db.run('DELETE FROM projects WHERE id = ?', row.id);
  if (!r.changes) return sendError(res, 404, 'Project not found');
  res.json({ ok: true });
}));

app.post('/api/projects/:id/duplicate', requireAuth, wrap(async (req, res) => {
  const row = await findProjectRow(req.params.id);
  if (!row) return sendError(res, 404, 'Project not found');

  const source = rowToProject(row);
  const newName = `Copy of ${source.name}`.slice(0, 200);
  const newSlug = await makeSlug(newName);

  const r = await db.run(
    `INSERT INTO projects (slug, name, tagline, welcome, closing, status, config)
     VALUES (?, ?, ?, ?, ?, 'draft', ?)`,
    newSlug, newName, source.tagline, source.welcome, source.closing, JSON.stringify(source.config)
  );

  const newRow = await db.get('SELECT * FROM projects WHERE id = ?', Number(r.lastInsertRowid));
  res.status(201).json({ project: presentProject(rowToProject(newRow)) });
}));

// ---------------------------------------------------------------- submissions (admin)
app.get('/api/projects/:id/submissions', requireAuth, wrap(async (req, res) => {
  const row = await findProjectRow(req.params.id);
  if (!row) return sendError(res, 404, 'Project not found');
  const rows = await db.all(
    'SELECT * FROM submissions WHERE project_id = ? ORDER BY id DESC',
    row.id
  );
  res.json({ submissions: rows.map(rowToSubmission) });
}));

app.delete('/api/projects/:id/submissions/:subId', requireAuth, wrap(async (req, res) => {
  const row = await findProjectRow(req.params.id);
  if (!row) return sendError(res, 404, 'Project not found');
  const subId = Number(req.params.subId);
  if (!Number.isInteger(subId)) {
    return sendError(res, 400, 'Invalid ID');
  }
  const r = await db.run('DELETE FROM submissions WHERE id = ? AND project_id = ?', subId, row.id);
  if (!r.changes) return sendError(res, 404, 'Submission not found');
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- public customer API
app.get('/api/public/:slug', wrap(async (req, res) => {
  const row = await db.get('SELECT * FROM projects WHERE slug = ?', req.params.slug);
  if (!row) return sendError(res, 404, 'Questionnaire not found');
  const project = rowToProject(row);
  const access = publicAccess(req, project.slug);
  if (project.status === 'draft' && !access) {
    // Draft projects are hidden from customers (admin hasn't published yet)
    return sendError(res, 404, 'Questionnaire not found');
  }
  if (project.status === 'closed' && !access) {
    return res.status(410).json({ error: 'This questionnaire has been closed.', project: { name: project.name, closing: project.closing } });
  }
  res.json({
    project: { id: project.id, slug: project.slug, name: project.name, tagline: project.tagline, welcome: project.welcome, status: project.status },
    modules: resolveModules(project),
    isAdmin: Boolean(access)
  });
}));

app.post('/api/public/:slug/submit', wrap(async (req, res) => {
  const row = await db.get('SELECT * FROM projects WHERE slug = ?', req.params.slug);
  if (!row) return sendError(res, 404, 'Questionnaire not found');
  const project = rowToProject(row);
  const isAdmin = isValidSessionToken(req.cookies[SESSION_COOKIE]);
  if (project.status === 'draft' && !isAdmin) return sendError(res, 404, 'Questionnaire not found');
  if (project.status === 'closed' && !isAdmin) return sendError(res, 410, 'This questionnaire has been closed.');

  const body = req.body || {};
  const name = String(body.customer_name || '').trim().slice(0, 200);
  const email = String(body.customer_email || '').trim().slice(0, 200);
  const answers = Array.isArray(body.answers) ? body.answers : [];

  if (!name) return sendError(res, 400, 'Please tell us your name.');
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return sendError(res, 400, 'Please provide a valid email address.');

  // Only accept answers to questions currently enabled by the project. Labels,
  // types and options come from the project configuration, never from the client.
  const modules = resolveModules(project);
  const questions = new Map();
  for (const module of modules) for (const question of module.questions) questions.set(question.id, question);
  const supplied = new Map();
  for (const answer of answers) {
    if (!answer || typeof answer !== 'object') continue;
    const id = String(answer.id || '');
    if (questions.has(id) && !supplied.has(id) && !isBlank(answer.value)) supplied.set(id, answer.value);
  }
  const errors = [...questions.values()]
    .filter(question => question.required && !supplied.has(question.id))
    .map(question => ({ id: question.id, label: question.label }));
  if (errors.length) return res.status(400).json({ error: 'Some required questions are missing.', errors });

  const cleanAnswers = [];
  for (const [id, value] of supplied) {
    const question = questions.get(id);
    let cleanValue;
    if (question.type === 'checkbox') {
      if (!Array.isArray(value)) continue;
      cleanValue = [...new Set(value.map(v => String(v)).filter(v => question.options.includes(v)))];
      if (!cleanValue.length) continue;
    } else if (question.type === 'radio') {
      cleanValue = String(value);
      if (!question.options.includes(cleanValue)) continue;
    } else if (question.type === 'rating') {
      cleanValue = Number(value);
      if (!Number.isInteger(cleanValue) || cleanValue < 1 || cleanValue > 5) continue;
    } else {
      cleanValue = String(value).trim().slice(0, 10000);
      if (!cleanValue) continue;
    }
    cleanAnswers.push({ id, label: question.label, type: question.type, value: cleanValue });
  }

  // A malformed required answer (such as a non-existent radio option) must not
  // pass validation merely because it contained a value.
  const invalidRequired = [...questions.values()].filter(question => question.required && !cleanAnswers.some(answer => answer.id === question.id));
  if (invalidRequired.length) return res.status(400).json({ error: 'Some required answers are invalid.', errors: invalidRequired.map(q => ({ id: q.id, label: q.label })) });

  const r = await db.run(
    'INSERT INTO submissions (project_id, customer_name, customer_email, answers) VALUES (?, ?, ?, ?)',
    project.id, name, email, JSON.stringify(cleanAnswers)
  );

  res.status(201).json({ ok: true, submissionId: Number(r.lastInsertRowid), closing: project.closing });
}));

// ---------------------------------------------------------------- pages
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get(['/project/:id', '/edit/:id', '/new'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/c/:slug', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'customer.html')));

app.use((_req, res) => sendError(res, 404, 'Not found'));

// Express error middleware: JSON body-parse failures and any async-handler
// error land here as a JSON response instead of a crash or an HTML error page.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400)) {
    return sendError(res, 400, 'Invalid JSON body');
  }
  if (err?.type === 'entity.too.large') {
    return sendError(res, 413, 'Request body too large');
  }
  console.error('[reqforge] Unhandled error:', err);
  if (res.headersSent) return res.end();
  sendError(res, 500, 'Something went wrong');
});

if (!process.env.VERCEL && !process.env.VERCEL_ENV && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ReqForge running on http://0.0.0.0:${PORT}`);
    console.log(`  Storage:       ${storageInfo.mode}${storageInfo.ephemeral ? ' (EPHEMERAL — data resets)' : ''}`);
    console.log(`  Admin app:     /   (username: ${ADMIN_USERNAME}, password: ${DEFAULT_CREDENTIALS ? '5161211 (default — set ADMIN_USERNAME/ADMIN_PASSWORD env to change)' : 'set via env vars'})`);
    console.log(`  Customer page: /c/<slug>`);
  });
}

export default app;
