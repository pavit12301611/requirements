// jsdom smoke test for the ReqForge admin app
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/user/requirements/public';
const html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'admin.js'), 'utf8');

const dom = new JSDOM(html, {
  url: 'https://example.test/',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;
const { document } = window;

const library = [
  {
    id: 'basics', title: 'About the project', icon: '🧭', blurb: 'b',
    questions: [
      { id: 'basics.name', type: 'text', required: true, label: 'Project name?' },
      { id: 'basics.purpose', type: 'checkbox', label: 'Purpose?', options: ['Sell', 'Inform'] }
    ]
  },
  {
    id: 'budget', title: 'Budget', icon: '💰', blurb: 'm',
    questions: [{ id: 'budget.budget', type: 'radio', label: 'Budget?', options: ['A', 'B'] }]
  }
];

let project = {
  id: 7, slug: 'acme', name: 'Acme', tagline: 't', welcome: '', closing: '', status: 'draft',
  config: { modules: [{ id: 'basics', questions: ['basics.name'] }] },
  created_at: '2026-08-09 12:00:00'
};
let submissions = [];
let patched = null;

window.fetch = async (url, opts = {}) => {
  const body = opts.body ? JSON.parse(opts.body) : null;
  const json = async () => { throw new Error('no body'); };
  if (url === '/api/me') return { ok: true, status: 200, json: async () => ({ ok: true }) };
  if (url === '/api/library') return { ok: true, status: 200, json: async () => ({ modules: library }) };
  if (url === '/api/projects') return { ok: true, status: 200, json: async () => ({ projects: [{ ...project, submissions: submissions.length }] }) };
  if (url === '/api/projects/7' && opts.method === 'PATCH') {
    patched = body;
    project = { ...project, ...body, config: body.config ?? project.config };
    return { ok: true, status: 200, json: async () => ({ project }) };
  }
  if (url === '/api/projects/7') return { ok: true, status: 200, json: async () => ({ project }) };
  if (url === '/api/projects/7/submissions') return { ok: true, status: 200, json: async () => ({ submissions }) };
  throw new Error('unexpected fetch ' + url + ' ' + (opts.method || 'GET'));
};

window.eval(js);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) failures++; };

await sleep(120);

// boot() should have called /api/me and landed on dashboard (default hash '#/')
check('dashboard rendered', document.querySelector('.page-head h1')?.textContent.includes('Your projects'));
check('project card shows name', [...document.querySelectorAll('.project-card h3')].some(h => h.textContent === 'Acme'));

// go to editor
window.location.hash = '#/edit/7';
await sleep(120);
check('editor rendered', !!document.querySelector('.editor-card h2'));
check('editor shows customer link', document.querySelector('.share-box .input')?.value?.endsWith('/c/acme'));
check('module cards rendered', document.querySelectorAll('.module-card').length === 2);
check('basics module on (has body)', !!document.querySelector('[data-module="basics"] .module-body'));
check('budget module off by default', !document.querySelector('[data-module="budget"] .module-body'));

// toggle budget module on via head click
document.querySelector('[data-module="budget"] [data-toggle-module]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(30);
check('budget body appears after toggle', !!document.querySelector('[data-module="budget"] .module-body'));

// toggle a question on (budget.budget)
const budgetQ = document.querySelector('[data-module="budget"] [data-q="budget.budget"] [data-q-on]');
budgetQ.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(30);

// add a custom question
document.querySelector('[data-module="basics"] [data-add-question]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(30);
const editor = document.querySelector('[data-module="basics"] [data-custom-editor]');
check('custom editor visible', !editor.classList.contains('hidden'));
editor.querySelector('[data-c-label]').value = 'How many locations?';
editor.querySelector('[data-c-type]').value = 'radio';
editor.querySelector('[data-c-options]').value = 'One, Two, Three';
editor.querySelector('[data-c-add]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(30);
check('custom question row appears', [...document.querySelectorAll('[data-module="basics"] .q-row.custom')].some(r => r.textContent.includes('How many locations?')));

// save
window.addEventListener('error', e => console.log('WINDOW ERROR:', e.message));
window.addEventListener('unhandledrejection', e => console.log('UNHANDLED REJECTION:', e.reason?.message || e.reason));
const nameInput = document.querySelector('[data-meta="name"]');
nameInput.value = 'Acme Corp';
nameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
console.log('state.editing.meta.name =', window.__state?.editing?.meta?.name);
document.querySelector('[data-save]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(120);

check('PATCH sent', !!patched);
check('PATCH includes name', patched?.name === 'Acme Corp');
check('PATCH config has budget module', patched?.config?.modules.some(m => m.id === 'budget'));
check('PATCH config budget question selected', patched?.config?.modules.find(m => m.id === 'budget').questions.includes('budget.budget'));
check('PATCH config has custom question', patched?.config?.modules.find(m => m.id === 'basics').questions.some(q => typeof q === 'object' && q.label === 'How many locations?'));

// detail view with a submission
project.config = patched.config;
project.status = 'live';
submissions = [{
  id: 1, customer_name: 'Jane Doe', customer_email: 'jane@x.com', created_at: '2026-08-09 13:00:00',
  answers: [
    { id: 'basics.name', label: 'Project name?', type: 'text', value: 'Acme' },
    { id: 'basics.purpose', label: 'Purpose?', type: 'checkbox', value: ['Sell', 'Inform'] }
  ]
}];
window.location.hash = '#/project/7';
await sleep(120);
check('detail shows submission', document.querySelector('.sub-card .who')?.textContent.includes('Jane Doe'));
check('detail shows chips for checkbox answer', !!document.querySelector('.sub-body .chip'));
check('detail shows link', document.querySelector('.share-box .input')?.value?.endsWith('/c/acme'));

console.log(failures ? `\n${failures} FAILURES` : '\nALL ADMIN TESTS PASSED');
process.exit(failures ? 1 : 0);
