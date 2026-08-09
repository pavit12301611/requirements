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
    id: row.id, slug: row.slug, name: row.name, tagline: row.tagline,
    welcome: row.welcome, closing: row.closing, status: row.status,
    config: parseConfig(row), created_at: row.created_at,
    submissions: row.submissions ?? undefined
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
function seedDemo() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
  if (count > 0) return;

  const insertProject = db.prepare(
    `INSERT INTO projects (slug, name, tagline, welcome, closing, status, config) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertSubmission = db.prepare(
    `INSERT INTO submissions (project_id, customer_name, customer_email, answers) VALUES (?, ?, ?, ?)`
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
  const shop = insertProject.run(
    'daily-bloom', 'The Daily Bloom',
    'A new website & online shop for a local flower studio',
    'Hi Emma! 👋 Thanks for choosing The Daily Bloom. This questionnaire helps us understand exactly what you need so we can build the perfect site for you. Tick or type what applies — it takes about 5 minutes.',
    '🎉 Thank you! Your answers are in. We\u2019ll be in touch within 1 business day to walk through the next steps.',
    'live', JSON.stringify(shopConfig)
  );
  const shopId = Number(shop.lastInsertRowid);

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
  insertSubmission.run(shopId, 'Emma Carter', 'emma@thedailybloom.com', JSON.stringify(shopAnswers));

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
  insertProject.run(
    'photo-portfolio', 'Marcus Reed — Photography',
    'Portfolio site to book wedding & portrait shoots',
    'Thanks for your interest! Answer the questions below so I can build you a portfolio that books clients.',
    'Thanks! I\u2019ll get back to you shortly.',
    'draft', JSON.stringify(photoConfig)
  );
}

seedDemo();
