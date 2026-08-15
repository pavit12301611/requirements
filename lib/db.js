// ReqForge database layer (SQLite via node:sqlite — zero native dependencies).
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LIBRARY } from './library.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isServerless = Boolean(
  process.env.VERCEL ||
  process.env.VERCEL_ENV ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.LAMBDA_TASK_ROOT
);

function resolveDataDir() {
  if (process.env.DATA_DIR) {
    fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
    return process.env.DATA_DIR;
  }
  const localDir = path.join(__dirname, '..', 'data');
  if (isServerless) {
    const tmpDir = path.join('/tmp', 'reqforge-data');
    fs.mkdirSync(tmpDir, { recursive: true });
    return tmpDir;
  }
  try {
    fs.mkdirSync(localDir, { recursive: true });
    const testFile = path.join(localDir, `.write-test-${Date.now()}`);
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return localDir;
  } catch {
    const tmpDir = path.join('/tmp', 'reqforge-data');
    fs.mkdirSync(tmpDir, { recursive: true });
    return tmpDir;
  }
}

const dataDir = resolveDataDir();
const dbPath = path.join(dataDir, 'requirements.db');
const localDbPath = path.join(__dirname, '..', 'data', 'requirements.db');

if (dbPath !== localDbPath && !fs.existsSync(dbPath) && fs.existsSync(localDbPath)) {
  try {
    fs.copyFileSync(localDbPath, dbPath);
  } catch {
    // Ignore copy failures
  }
}

export const db = new DatabaseSync(dbPath);

db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`PRAGMA foreign_keys = ON;`);

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  tagline    TEXT NOT NULL DEFAULT '',
  welcome    TEXT NOT NULL DEFAULT '',
  closing    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'draft',      -- draft | live | closed
  config     TEXT NOT NULL DEFAULT '{}',         -- JSON: { modules: [{ id, questions: [qid | customObj] }] }
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS submissions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  customer_name  TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL DEFAULT '',
  answers        TEXT NOT NULL DEFAULT '[]',     -- JSON: [{ id, label, type, value }]
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export function defaultConfig() {
  return { modules: LIBRARY.map(m => ({ id: m.id, questions: m.questions.map(q => q.id) })) };
}

export function parseConfig(project) {
  const raw = project?.config;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw; // already parsed
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

// Build the list of modules+questions that are actually enabled for a project.
export function resolveModules(project) {
  const cfg = parseConfig(project);
  const selected = Array.isArray(cfg.modules) ? cfg.modules : [];
  const out = [];
  for (const mc of selected) {
    const lib = LIBRARY.find(m => m.id === mc.id);
    if (!lib) continue;
    const questions = [];
    for (const ref of Array.isArray(mc.questions) ? mc.questions : []) {
      if (typeof ref === 'string') {
        const q = lib.questions.find(q => q.id === ref);
        if (q) questions.push({ ...q, custom: false });
      } else if (ref && typeof ref === 'object' && ref.label) {
        questions.push({
          id: ref.id, type: ref.type || 'text', label: ref.label,
          help: ref.help || '', options: Array.isArray(ref.options) ? ref.options : [],
          required: !!ref.required, placeholder: ref.placeholder || '', custom: true
        });
      }
    }
    if (questions.length) {
      out.push({ id: lib.id, title: lib.title, icon: lib.icon, blurb: lib.blurb, questions });
    }
  }
  return out;
}

export function makeSlug(name) {
  const base = String(name || 'project').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  let slug = base;
  let i = 2;
  while (db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

export function rowToProject(row) {
  return {
    id: Number(row.id), slug: row.slug, name: row.name, tagline: row.tagline,
    welcome: row.welcome, closing: row.closing, status: row.status,
    config: parseConfig(row), created_at: row.created_at,
    submissions: row.submissions == null ? undefined : Number(row.submissions)
  };
}

export function rowToSubmission(row) {
  let answers = [];
  try { answers = JSON.parse(row.answers || '[]'); } catch { /* ignore */ }
  return {
    id: row.id, project_id: row.project_id, customer_name: row.customer_name,
    customer_email: row.customer_email, answers, created_at: row.created_at
  };
}

// The database starts empty on purpose: projects are created by the admin
// through the UI (or the API), never baked into the code. Earlier versions
// seeded two fake projects ("The Daily Bloom", "Marcus Reed — Photography")
// into every fresh database, which showed up as real projects in a new
// deployment and had to be deleted by hand.
