// ReqForge database layer.
//
// Two interchangeable backends behind one small async interface:
//   1. Local SQLite file (node:sqlite) — the default. Used on your own
//      machine and any single-instance host with a persistent disk.
//   2. Turso / libSQL (remote SQLite) — enabled with TURSO_DATABASE_URL +
//      TURSO_AUTH_TOKEN. Required for serverless platforms (Vercel etc.)
//      where the local filesystem is ephemeral: without a remote database,
//      every cold start resets to the demo data and writes can disappear.
//
// Every exported query helper is async so callers work identically on both
// backends.
import { DatabaseSync } from 'node:sqlite';
import { createClient } from '@libsql/client';
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

const TURSO_URL = String(process.env.TURSO_DATABASE_URL || '').trim();
const TURSO_TOKEN = String(process.env.TURSO_AUTH_TOKEN || '').trim();
// Remote libsql/Turso URLs need a token; local file: URLs (useful for testing
// and for running the libsql code path locally) do not.
const useTurso = Boolean(TURSO_URL && (TURSO_TOKEN || TURSO_URL.startsWith('file:')));

export const storageInfo = {
  mode: useTurso ? 'turso' : (isServerless ? 'serverless-tmp' : 'file'),
  ephemeral: !useTurso && isServerless
};

// ---------------------------------------------------------------- schema
const SCHEMA = `
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
`;

// ---------------------------------------------------------------- backend 1: local file
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

function openLocalDatabase(dbPath) {
  let d;
  try {
    d = new DatabaseSync(dbPath);
    d.exec(SCHEMA);
    // Sanity-check the schema so a half-written or mismatched file is
    // treated as corrupt instead of failing on the first real query.
    d.prepare('SELECT id, slug, name, tagline, welcome, closing, status, config, created_at FROM projects LIMIT 1').get();
    d.prepare('SELECT id, project_id, customer_name, customer_email, answers, created_at FROM submissions LIMIT 1').get();
    return d;
  } catch (err) {
    try { d?.close(); } catch { /* ignore */ }
    const backup = `${dbPath}.corrupt-${Date.now()}`;
    try {
      if (fs.existsSync(dbPath)) fs.renameSync(dbPath, backup);
      console.error(`[reqforge] Database at ${dbPath} was unreadable (${err.message}).`);
      console.error(`[reqforge] Moved it to ${backup} and starting fresh.`);
    } catch (moveErr) {
      console.error(`[reqforge] Database at ${dbPath} is unreadable and could not be moved: ${moveErr.message}`);
      throw err;
    }
    d = new DatabaseSync(dbPath);
    d.exec(SCHEMA);
    return d;
  }
}

// ---------------------------------------------------------------- backend 2: turso / libsql
async function createTursoClient() {
  const client = createClient(TURSO_TOKEN
    ? { url: TURSO_URL, authToken: TURSO_TOKEN }
    : { url: TURSO_URL });
  // libSQL executes one statement per call — create the schema statement by
  // statement (IF NOT EXISTS keeps it idempotent across cold starts).
  for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
    await client.execute(stmt);
  }
  return {
    async get(sql, ...params) {
      const r = await client.execute({ sql, args: params });
      return r.rows[0];
    },
    async all(sql, ...params) {
      const r = await client.execute({ sql, args: params });
      return r.rows;
    },
    async run(sql, ...params) {
      const r = await client.execute({ sql, args: params });
      return { changes: Number(r.rowsAffected), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    async exec(sql) {
      await client.execute(sql);
    }
  };
}

// ---------------------------------------------------------------- unified async interface
let engine;
if (useTurso) {
  engine = await createTursoClient();
} else {
  const dataDir = resolveDataDir();
  const dbPath = path.join(dataDir, 'requirements.db');
  const localDbPath = path.join(__dirname, '..', 'data', 'requirements.db');

  if (dbPath !== localDbPath && !fs.existsSync(dbPath) && fs.existsSync(localDbPath)) {
    try { fs.copyFileSync(localDbPath, dbPath); } catch { /* ignore copy failures */ }
  }

  const local = openLocalDatabase(dbPath);
  try { local.exec('PRAGMA journal_mode = WAL;'); } catch { /* ignore */ }
  try { local.exec('PRAGMA busy_timeout = 5000;'); } catch { /* ignore */ }
  try { local.exec('PRAGMA foreign_keys = ON;'); } catch { /* ignore */ }

  engine = {
    async get(sql, ...params) { return local.prepare(sql).get(...params); },
    async all(sql, ...params) { return local.prepare(sql).all(...params); },
    async run(sql, ...params) { return local.prepare(sql).run(...params); },
    async exec(sql) { local.exec(sql); }
  };
}

export const db = engine;

if (useTurso) {
  console.log(`[reqforge] Using remote Turso database (${TURSO_URL.replace(/\/\/[^@/]+@/, '//***@')})`);
} else if (storageInfo.ephemeral) {
  console.warn('[reqforge] WARNING: running on serverless storage (/tmp) — data is DEMO ONLY and resets between instances.');
  console.warn('[reqforge] Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN for durable data (see README).');
} else {
  console.log(`[reqforge] Using local database (${storageInfo.mode})`);
}

// ---------------------------------------------------------------- helpers
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

export async function makeSlug(name) {
  const base = String(name || 'project').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  let slug = base;
  let i = 2;
  while (await db.get('SELECT id FROM projects WHERE slug = ?', slug)) {
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

// ---------------------------------------------------------------- demo seed
// Seeding is idempotent (fixed slugs + ON CONFLICT DO NOTHING) so it is safe
// to run on every serverless cold start and on a freshly created remote DB.
async function seedDemo() {
  const n = (await db.get('SELECT COUNT(*) AS n FROM projects'))?.n;
  if (n > 0) return;

  const insertProject = (slug, name, tagline, welcome, closing, status, config) =>
    db.run(
      `INSERT INTO projects (slug, name, tagline, welcome, closing, status, config)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO NOTHING`,
      slug, name, tagline, welcome, closing, status, config
    );

  const insertSubmission = (projectId, customerName, customerEmail, answers) =>
    db.run(
      'INSERT INTO submissions (project_id, customer_name, customer_email, answers) VALUES (?, ?, ?, ?)',
      projectId, customerName, customerEmail, answers
    );

  // --- Demo project 1: flower shop, live, with a real-looking submission
  const shopConfig = {
    modules: [
      { id: 'basics',    questions: ['basics.name', 'basics.one_liner', 'basics.purpose', 'basics.audience', 'basics.current_site'] },
      { id: 'pages',     questions: ['pages.pages', 'pages.structure', 'pages.sections'] },
      { id: 'features',  questions: ['features.features', 'features.important', 'features.integrations'] },
      { id: 'design',    questions: ['design.style', 'design.colors', 'design.logos', 'design.vibe', 'design.inspiration'] },
      { id: 'budget',    questions: ['budget.budget', 'budget.monthly'] },
      { id: 'timeline',  questions: ['timeline.deadline', 'timeline.speed', 'timeline.phases'] },
      { id: 'ecommerce', questions: ['ecommerce.products', 'ecommerce.type', 'ecommerce.payments', 'ecommerce.shipping'] }
    ]
  };
  const shop = await insertProject(
    'daily-bloom', 'The Daily Bloom',
    'A new website & online shop for a local flower studio',
    'Hi Emma! 👋 Thanks for choosing The Daily Bloom. This questionnaire helps us understand exactly what you need so we can build the perfect site for you. Tick or type what applies — it takes about 5 minutes.',
    '🎉 Thank you! Your answers are in. We’ll be in touch within 1 business day to walk through the next steps.',
    'live', JSON.stringify(shopConfig)
  );
  const shopId = Number(shop.lastInsertRowid);

  if (shop.changes > 0) {
    const shopAnswers = [
      { id: 'basics.name', label: 'What is the name of your project or business?', type: 'text', value: 'The Daily Bloom' },
      { id: 'basics.one_liner', label: 'Describe your project in one or two sentences.', type: 'textarea', value: 'Online flower shop delivering same-day bouquets in Austin, plus wedding flower bookings.' },
      { id: 'basics.purpose', label: 'What is the main purpose of the website?', type: 'checkbox', value: ['Sell products or services', 'Generate leads / enquiries'] },
      { id: 'basics.audience', label: 'Who is your target audience? Describe them (age, location, interests…).', type: 'textarea', value: 'Local couples aged 25–40 planning weddings, plus corporate clients ordering for offices.' },
      { id: 'basics.current_site', label: 'Do you have an existing website?', type: 'radio', value: 'Yes, but I want a redesign' },
      { id: 'pages.pages', label: 'Tick every page the website should include.', type: 'checkbox', value: ['Home', 'About', 'Products / Shop', 'Gallery', 'Blog / News', 'Contact'] },
      { id: 'pages.structure', label: 'Should the site be a single page or a multi-page site?', type: 'radio', value: 'Multi-page' },
      { id: 'pages.sections', label: 'Which sections should the HOMEPAGE include?', type: 'checkbox', value: ['Hero / intro', 'Services / what we do', 'Portfolio / examples', 'Testimonials', 'Contact form', 'Map & location'] },
      { id: 'features.features', label: 'Tick every feature the website needs.', type: 'checkbox', value: ['Payments / checkout', 'Booking / calendar system', 'Image gallery', 'Newsletter signup', 'Google Maps'] },
      { id: 'features.important', label: 'Which features are the most important? Rank them or explain why.', type: 'textarea', value: '1) Same-day delivery calendar, 2) easy checkout with Stripe, 3) Instagram gallery feed.' },
      { id: 'features.integrations', label: 'Should it integrate with any of these tools?', type: 'checkbox', value: ['Google Analytics', 'Email marketing (Mailchimp, Klaviyo…)', 'Payment gateway (Stripe, PayPal…)', 'Social media'] },
      { id: 'design.style', label: 'Which design style appeals to you most?', type: 'radio', value: 'Bold & colorful' },
      { id: 'design.colors', label: 'Do you have brand colors? (hex codes, names, or a description)', type: 'text', value: 'Sage green #6B8E6B, cream #F7F3E8, terracotta accents' },
      { id: 'design.logos', label: 'Do you have a logo?', type: 'radio', value: 'Yes, I have files' },
      { id: 'design.vibe', label: 'Describe the feeling the site should give visitors.', type: 'text', value: 'Warm, fresh, trustworthy, a little playful' },
      { id: 'design.inspiration', label: 'Links to websites you like — and what you like about them.', type: 'textarea', value: 'https://www.farmgirlflowers.com — love the photo-led homepage and soft colors.' },
      { id: 'ecommerce.products', label: 'How many products will you sell?', type: 'radio', value: '11–50' },
      { id: 'ecommerce.type', label: 'Are you selling physical products, digital products, or both?', type: 'radio', value: 'Physical products' },
      { id: 'ecommerce.payments', label: 'Which payment methods should be accepted?', type: 'checkbox', value: ['Credit / debit card', 'Apple Pay / Google Pay'] },
      { id: 'ecommerce.shipping', label: 'Any shipping or delivery requirements?', type: 'textarea', value: 'Same-day local delivery for orders before 2pm; pickup at the studio also offered.' },
      { id: 'budget.budget', label: 'What is your budget for this project?', type: 'radio', value: '$3,000 – $7,000' },
      { id: 'budget.monthly', label: 'Do you expect ongoing monthly costs (hosting, maintenance, updates)?', type: 'radio', value: 'Yes, budgeted for' },
      { id: 'timeline.deadline', label: 'When do you need the website live? (date)', type: 'text', value: '2026-10-15' },
      { id: 'timeline.speed', label: 'How urgent is this project?', type: 'radio', value: 'Within a month' },
      { id: 'timeline.phases', label: 'Is a phased launch OK (launch the core site first, add features later)?', type: 'radio', value: 'Yes' }
    ];
    await insertSubmission(shopId, 'Emma Carter', 'emma@thedailybloom.com', JSON.stringify(shopAnswers));
  }

  // --- Demo project 2: photographer portfolio, draft, no submissions yet
  const photoConfig = {
    modules: [
      { id: 'basics',   questions: ['basics.name', 'basics.one_liner', 'basics.audience', 'basics.current_site'] },
      { id: 'pages',    questions: ['pages.pages', 'pages.sections'] },
      { id: 'design',   questions: ['design.style', 'design.vibe', 'design.images'] },
      { id: 'goals',    questions: ['goals.success', 'goals.must_haves', 'goals.cta'] },
      { id: 'timeline', questions: ['timeline.speed', 'timeline.phases'] },
      { id: 'marketing', questions: ['marketing.seo', 'marketing.social'] }
    ]
  };
  await insertProject(
    'photo-portfolio', 'Marcus Reed — Photography',
    'Portfolio site to book wedding & portrait shoots',
    'Thanks for your interest! Answer the questions below so I can build you a portfolio that books clients.',
    'Thanks! I’ll get back to you shortly.',
    'draft', JSON.stringify(photoConfig)
  );
}

// Ensure schema + demo data exist before the server starts accepting requests.
await seedDemo();
