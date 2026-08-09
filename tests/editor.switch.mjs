// Editor toggle regression test.
// Verifies the per-question and per-module switch handlers run when the visible
// switch (the .track inside the <label>) is clicked — the real user path.
// (Note: jsdom does not reproduce the stopPropagation edge-case that broke this in
// real browsers, so this guards the handler logic itself; the stopPropagation was
// removed from the markup to fix the real-browser behaviour.)
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const ROOT = '/home/user/requirements/public';
const html = fs.readFileSync(ROOT + '/admin.html', 'utf8');
const js = fs.readFileSync(ROOT + '/admin.js', 'utf8');

const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

const library = [
  { id: 'basics', title: 'About', icon: '🧭', blurb: 'b',
    questions: [
      { id: 'basics.name', type: 'text', required: true, label: 'Name?' },
      { id: 'basics.purpose', type: 'checkbox', label: 'Purpose?', options: ['A', 'B'] }
    ] },
  { id: 'budget', title: 'Budget', icon: '💰', blurb: 'm',
    questions: [{ id: 'budget.budget', type: 'radio', label: 'Budget?', options: ['A', 'B'] }] }
];
let project = { id: 7, slug: 'acme', name: 'Acme', tagline: '', welcome: '', closing: '', status: 'draft',
  config: { modules: [{ id: 'basics', questions: [] }] }, created_at: '2026-08-09 12:00:00' };
let patched = null;

window.fetch = async (url, opts = {}) => {
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (url === '/api/me') return { ok: true, status: 200, json: async () => ({ ok: true }) };
  if (url === '/api/library') return { ok: true, status: 200, json: async () => ({ modules: library }) };
  if (url === '/api/projects') return { ok: true, status: 200, json: async () => ({ projects: [{ ...project, submissions: 0 }] }) };
  if (url === '/api/projects/7' && opts.method === 'PATCH') {
    patched = body; project = { ...project, ...body, config: body.config ?? project.config };
    return { ok: true, status: 200, json: async () => ({ project }) };
  }
  if (url === '/api/projects/7') return { ok: true, status: 200, json: async () => ({ project }) };
  if (url === '/api/projects/7/submissions') return { ok: true, status: 200, json: async () => ({ submissions: [] }) };
  throw new Error('unexpected ' + url);
};

window.eval(js);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) failures++; };

await sleep(120);
window.location.hash = '#/edit/7';
await sleep(120);

// 1. Toggle the BUDGET MODULE on by clicking its head switch track (real-user path)
function budgetSwitchTrack() {
  return document.querySelector('[data-module="budget"] .module-head .switch .track');
}
budgetSwitchTrack().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(40);
check('module switch toggles module ON', window.__state.editing.modules.find(m => m.id === 'budget').on === true);

// 2. Select a question by clicking its switch track (real-user path)
const qSwitchTrack = document.querySelector('[data-module="budget"] [data-q="budget.budget"] .switch .track');
qSwitchTrack.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(40);
check('question switch selects the question',
  window.__state.editing.modules.find(m => m.id === 'budget').selected.has('budget.budget'));

// 3. Toggle the same module OFF via the switch, then back ON to confirm idempotency.
//    (Re-query each time: renderEditorShell rebuilds the DOM, detaching the old node.)
budgetSwitchTrack().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(40);
check('module switch toggles module OFF', window.__state.editing.modules.find(m => m.id === 'budget').on === false);
budgetSwitchTrack().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(40);
check('module switch toggles module ON again (selection preserved)',
  window.__state.editing.modules.find(m => m.id === 'budget').on === true &&
  window.__state.editing.modules.find(m => m.id === 'budget').selected.has('budget.budget'));

// 4. Save and confirm the switch-selected question is persisted
document.querySelector('[data-save]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(80);
check('saved config includes switch-selected question',
  patched?.config?.modules.find(m => m.id === 'budget')?.questions.includes('budget.budget'));

console.log(failures ? `\n${failures} FAILURES` : '\nALL EDITOR SWITCH TESTS PASSED');
process.exit(failures ? 1 : 0);
