// ReqForge — Express backend.
// Admin API (password-protected) + public customer questionnaire API.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  db, makeSlug, rowToProject, rowToSubmission, resolveModules, defaultConfig
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

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
    res.setHeader('Set-Cookie',
      `${SESSION_COOKIE}=${makeSessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
    return res.json({ ok: true });
  }
  sendError(res, 401, 'Wrong username or password');
});

app.post('/api/logout', (_req, res) => {
  // Stateless tokens: dropping the cookie is the logout. (To revoke tokens for
  // every device at once, change ADMIN_PASSWORD or SESSION_SECRET.)
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (isValidSessionToken(req.cookies[SESSION_COOKIE])) {
    return res.json({ ok: true, admin: ADMIN_USERNAME, defaultCredentials: DEFAULT_CREDENTIALS });
  }
  sendError(res, 401, 'Not signed in');
});

function findProjectRow(idOrSlug) {
  if (idOrSlug === null || idOrSlug === undefined || idOrSlug === '') return null;
  const idNum = Number(idOrSlug);
  if (Number.isInteger(idNum) && idNum > 0) {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(idNum);
    if (row) return row;
  }
  return db.prepare('SELECT * FROM projects WHERE slug = ?').get(String(idOrSlug));
}

// ---------------------------------------------------------------- library
import { LIBRARY } from './lib/library.js';
app.get('/api/library', requireAuth, (_req, res) => {
  res.json({ modules: LIBRARY });
});

// ---------------------------------------------------------------- projects (admin)
app.get('/api/projects', requireAuth, (_req, res) => {
  const rows = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM submissions s WHERE s.project_id = p.id) AS submissions
    FROM projects p ORDER BY p.id DESC
  `).all();
  res.json({ projects: rows.map(rowToProject) });
});

app.post('/api/projects', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return sendError(res, 400, 'Project name is required');
  if (name.length > 200) return sendError(res, 400, 'Project name must be 200 characters or fewer');
  const slug = makeSlug(name);
  let config = defaultConfig();
  if (req.body?.config) {
    try { config = normalizeConfig(req.body.config); } catch (e) { return sendError(res, 400, e.message); }
  }
  const status = ['draft', 'live', 'closed'].includes(req.body?.status) ? req.body.status : 'draft';
  const tagline = String(req.body?.tagline || '').trim();
  const welcome = String(req.body?.welcome || '').trim();
  const closing = String(req.body?.closing || '').trim();
  const r = db.prepare(
    'INSERT INTO projects (slug, name, tagline, welcome, closing, status, config) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(slug, name, tagline, welcome, closing, status, JSON.stringify(config));
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(r.lastInsertRowid));
  res.status(201).json({ project: rowToProject(row) });
});

app.get('/api/projects/:id', requireAuth, (req, res) => {
  const row = findProjectRow(req.params.id);
  if (!row) return sendError(res, 404, 'Project not found');
  res.json({ project: rowToProject(row) });
});

app.patch('/api/projects/:id', requireAuth, (req, res) => {
  const row = findProjectRow(req.params.id);
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
        sets.push(`${key} = ?`);
        params.push(String(req.body[key]).trim());
      }
    }
  }
  if (!sets.length) return sendError(res, 400, 'Nothing to update');
  params.push(row.id);
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(row.id);
  res.json({ project: rowToProject(updated) });
});

app.delete('/api/projects/:id', requireAuth, (req, res) => {
  const row = findProjectRow(req.params.id);
  if (!row) return sendError(res, 404, 'Project not found');
  db.prepare('DELETE FROM submissions WHERE project_id = ?').run(row.id);
  const r = db.prepare('DELETE FROM projects WHERE id = ?').run(row.id);
  if (!r.changes) return sendError(res, 404, 'Project not found');
  res.json({ ok: true });
});

app.post('/api/projects/:id/duplicate', requireAuth, (req, res) => {
  const row = findProjectRow(req.params.id);
  if (!row) return sendError(res, 404, 'Project not found');

  const source = rowToProject(row);
  const newName = `Copy of ${source.name}`.slice(0, 200);
  const newSlug = makeSlug(newName);

  const r = db.prepare(
    `INSERT INTO projects (slug, name, tagline, welcome, closing, status, config)
     VALUES (?, ?, ?, ?, ?, 'draft', ?)`
  ).run(newSlug, newName, source.tagline, source.welcome, source.closing, JSON.stringify(source.config));

  const newRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(r.lastInsertRowid));
  res.status(201).json({ project: rowToProject(newRow) });
});

// ---------------------------------------------------------------- submissions (admin)
app.get('/api/projects/:id/submissions', requireAuth, (req, res) => {
  const row = findProjectRow(req.params.id);
  if (!row) return sendError(res, 404, 'Project not found');
  const rows = db.prepare(
    'SELECT * FROM submissions WHERE project_id = ? ORDER BY id DESC'
  ).all(row.id);
  res.json({ submissions: rows.map(rowToSubmission) });
});

app.delete('/api/projects/:id/submissions/:subId', requireAuth, (req, res) => {
  const row = findProjectRow(req.params.id);
  if (!row) return sendError(res, 404, 'Project not found');
  const subId = Number(req.params.subId);
  if (!Number.isInteger(subId)) {
    return sendError(res, 400, 'Invalid ID');
  }
  const r = db.prepare('DELETE FROM submissions WHERE id = ? AND project_id = ?').run(subId, row.id);
  if (!r.changes) return sendError(res, 404, 'Submission not found');
  res.json({ ok: true });
});

// ---------------------------------------------------------------- public customer API
app.get('/api/public/:slug', (req, res) => {
  const row = db.prepare('SELECT * FROM projects WHERE slug = ?').get(req.params.slug);
  if (!row) return sendError(res, 404, 'Questionnaire not found');
  const project = rowToProject(row);
  const isAdmin = isValidSessionToken(req.cookies[SESSION_COOKIE]);
  if (project.status === 'draft' && !isAdmin) {
    // Draft projects are hidden from customers (admin hasn't published yet)
    return sendError(res, 404, 'Questionnaire not found');
  }
  if (project.status === 'closed' && !isAdmin) {
    return res.status(410).json({ error: 'This questionnaire has been closed.', project: { name: project.name, closing: project.closing } });
  }
  res.json({
    project: { id: project.id, slug: project.slug, name: project.name, tagline: project.tagline, welcome: project.welcome, status: project.status },
    modules: resolveModules(project),
    isAdmin
  });
});

app.post('/api/public/:slug/submit', (req, res) => {
  const row = db.prepare('SELECT * FROM projects WHERE slug = ?').get(req.params.slug);
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

  const r = db.prepare(
    'INSERT INTO submissions (project_id, customer_name, customer_email, answers) VALUES (?, ?, ?, ?)'
  ).run(project.id, name, email, JSON.stringify(cleanAnswers));

  res.status(201).json({ ok: true, submissionId: Number(r.lastInsertRowid), closing: project.closing });
});

// ---------------------------------------------------------------- pages
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/c/:slug', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'customer.html')));

app.use((_req, res) => sendError(res, 404, 'Not found'));

if (!process.env.VERCEL && !process.env.VERCEL_ENV && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ReqForge running on http://0.0.0.0:${PORT}`);
    console.log(`  Admin app:     /   (username: ${ADMIN_USERNAME}, password: ${DEFAULT_CREDENTIALS ? '5161211 (default — set ADMIN_USERNAME/ADMIN_PASSWORD env to change)' : 'set via env vars'})`);
    console.log(`  Customer page: /c/<slug>`);
  });
}

export default app;
