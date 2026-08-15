// Customer-side E2E: drives the real customer questionnaire against the real
// backend, booting its own server on a random port with a fresh temp database.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.VERCEL = '1'; // skip app.listen on import
process.env.DATA_DIR = path.join(os.tmpdir(), `reqforge-cust-e2e-${process.pid}-${Date.now()}`);
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const app = (await import('../server.js')).default;
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;

const ROOT = process.cwd() + '/public';
const html = fs.readFileSync(ROOT + '/customer.html', 'utf8');
const js = fs.readFileSync(ROOT + '/customer.js', 'utf8');

let failures = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

// ---- admin login to create a live project for the customer test ----
let cookies = '';
const rawLogin = await fetch(`${BASE}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'pavit', password: '5161211' })
});
for (const sc of rawLogin.headers.getSetCookie()) {
  const pair = sc.split(';')[0];
  if (pair.includes('=')) cookies = cookies.split('; ').filter(c => !c.startsWith(pair.split('=')[0] + '=')).concat(pair).join('; ');
}
const createRes = await fetch(`${BASE}/api/projects`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookies },
  body: JSON.stringify({
    name: 'Customer E2E Project', status: 'live',
    config: {
      modules: [
        { id: 'basics', questions: ['basics.name', 'basics.purpose'] },
        { id: 'budget', questions: ['budget.budget'] }
      ]
    }
  })
});
const created = await createRes.json();
const project = created.project;
const slug = project.slug;
console.log('  → test project:', slug);

const dom = new JSDOM(html, { url: `${BASE}/c/${slug}`, runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

// forward fetch to real server (no admin cookies — customer view)
window.fetch = async (url, opts = {}) => {
  const res = await fetch(new URL(url, BASE), { ...opts, headers: opts.headers || {} });
  let data = {}; try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, json: async () => data };
};

window.eval(js);
await sleep(400);

check('customer page renders questionnaire', Boolean(document.querySelector('.form-shell')));
check('project name shown', document.querySelector('.cust-header h1')?.textContent === 'Customer E2E Project');
check('about-you section present', Boolean(document.querySelector('#cust-name')));
check('modules render', document.querySelectorAll('.section-card').length === 3); // about-you + 2 modules

// required question from basics (name is required)
check('required marker on basics.name', document.querySelector('[data-qwrap="basics.name"] .req') !== null);

// fill name/email
const nameInput = document.querySelector('#cust-name');
const emailInput = document.querySelector('#cust-email');
const type = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
type(nameInput, 'Test Customer');
type(emailInput, 'customer@example.com');

// answer checkbox basics.purpose (click a chip)
const purposeChip = document.querySelector('.chip[data-q="basics.purpose"]');
click(purposeChip);
await sleep(50);
check('checkbox chip toggled on', purposeChip.classList.contains('on'));

// answer radio budget.budget
const budgetChip = document.querySelector('.chip[data-q="budget.budget"]');
click(budgetChip);
await sleep(50);
check('radio chip toggled on', budgetChip.classList.contains('on'));

// click the same radio again — must STAY on (single-choice)
click(budgetChip);
await sleep(50);
check('radio chip stays selected when re-clicked', budgetChip.classList.contains('on'));

// answer text basics.name
const qName = document.querySelector('input[data-q="basics.name"]');
type(qName, 'My Cool Website');
check('progress updated', Number(document.querySelector('[data-pct]').textContent.replace('%', '')) > 0);

// submit
const form = document.querySelector('.form-shell');
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(600);
check('thanks screen after submit', Boolean(document.querySelector('.thanks')));

// verify submission landed in the backend
const subsRes = await fetch(`${BASE}/api/projects/${project.id}/submissions`, { headers: { Cookie: cookies } });
const subs = await subsRes.json();
check('submission stored in backend', subs.submissions.length === 1);
const sub = subs.submissions[0];
check('customer name stored', sub.customer_name === 'Test Customer');
check('answers stored', sub.answers.length === 3); // basics.name, basics.purpose, budget.budget
const purpose = sub.answers.find(a => a.id === 'basics.purpose');
check('checkbox answer value array', Array.isArray(purpose.value) && purpose.value.length === 1);
const budget = sub.answers.find(a => a.id === 'budget.budget');
check('radio answer value string', budget.value === 'Under $1,000');

// submit again via the API — repeat submissions must be allowed
const secondSub = await fetch(`${BASE}/api/public/${slug}/submit`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    customer_name: 'Second Customer', customer_email: 'second@example.com',
    answers: [{ id: 'basics.name', value: 'Another project' }, { id: 'budget.budget', value: 'Under $1,000' }]
  })
});
check('second submission accepted (201)', secondSub.status === 201);
{
  const subsRes2 = await fetch(`${BASE}/api/projects/${project.id}/submissions`, { headers: { Cookie: cookies } });
  const subs2 = await subsRes2.json();
  check('two submissions now stored', subs2.submissions.length === 2);
}

// draft visibility: create a draft project, customer must get 404
const draftRes = await fetch(`${BASE}/api/projects`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookies },
  body: JSON.stringify({ name: 'Draft E2E', status: 'draft', config: { modules: [{ id: 'basics', questions: ['basics.name'] }] } })
});
const draft = await draftRes.json();
const draftPublic = await fetch(`${BASE}/api/public/${draft.project.slug}`);
check('draft hidden from customer (404)', draftPublic.status === 404);
const draftSubmit = await fetch(`${BASE}/api/public/${draft.project.slug}/submit`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ customer_name: 'x', customer_email: 'x@y.com', answers: [] })
});
check('draft submit rejected (404)', draftSubmit.status === 404);

// closed project: customer gets 410
await fetch(`${BASE}/api/projects/${draft.project.id}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookies },
  body: JSON.stringify({ status: 'closed' })
});
const closedPublic = await fetch(`${BASE}/api/public/${draft.project.slug}`);
check('closed project returns 410', closedPublic.status === 410);

// preview link must open the draft project (signed token)
const previewPage = await fetch(`${BASE}${draft.project.preview_path}`);
check('preview page link opens (200)', previewPage.status === 200);
const previewToken = draft.project.preview_path.split('?preview=')[1];
const previewRes = await fetch(`${BASE}/api/public/${draft.project.slug}?preview=${previewToken}`);
check('preview API returns the draft (200)', previewRes.status === 200);
const previewBody = await previewRes.json();
check('preview API marks isAdmin', previewBody.isAdmin === true);

// required-field validation: submit with a missing required answer → 400 with errors
const missingRes = await fetch(`${BASE}/api/public/${slug}/submit`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ customer_name: 'Bad', customer_email: 'bad@example.com', answers: [{ id: 'basics.purpose', value: ['Sell products or services'] }] })
});
const missingBody = await missingRes.json();
check('missing required answer rejected (400)', missingRes.status === 400);
check('missing required lists basics.name', (missingBody.errors || []).some(e => e.id === 'basics.name'));

// invalid email rejected
const badEmail = await fetch(`${BASE}/api/public/${slug}/submit`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ customer_name: 'x', customer_email: 'nope', answers: [] })
});
check('invalid email rejected (400)', badEmail.status === 400);

// cleanup
await fetch(`${BASE}/api/projects/${project.id}`, { method: 'DELETE', headers: { Cookie: cookies } });
await fetch(`${BASE}/api/projects/${draft.project.id}`, { method: 'DELETE', headers: { Cookie: cookies } });

server.close();
console.log(failures ? `\n${failures} FAILURES` : '\nALL CUSTOMER E2E CHECKS PASSED');
process.exit(failures ? 1 : 0);
