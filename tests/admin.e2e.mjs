// Admin E2E: drives the real admin UI (jsdom) against the real backend,
// booting its own server on a random port with a fresh temp database.
// Exercises every user-facing button. Run with: node tests/admin.e2e.mjs
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.VERCEL = '1'; // skip app.listen on import
process.env.DATA_DIR = path.join(os.tmpdir(), `reqforge-e2e-${process.pid}-${Date.now()}`);
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const app = (await import('../server.js')).default;
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;

const ROOT = process.cwd() + '/public';
const html = fs.readFileSync(ROOT + '/admin.html', 'utf8');
const js = fs.readFileSync(ROOT + '/admin.js', 'utf8');

const dom = new JSDOM(html, { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

// ---- cookie jar + real fetch bridge ----
let cookies = '';
window.fetch = async (url, opts = {}) => {
  const headers = { ...(opts.headers || {}) };
  if (cookies) headers.Cookie = cookies;
  const res = await fetch(new URL(url, BASE), { ...opts, headers });
  for (const sc of res.headers.getSetCookie?.() || []) {
    const pair = sc.split(';')[0];
    if (pair.includes('=')) {
      const name = pair.split('=')[0];
      cookies = cookies.split('; ').filter(c => !c.startsWith(name + '=')).concat(pair).join('; ');
    }
  }
  let data = {};
  try { data = await res.json(); } catch { /* no body */ }
  return { ok: res.ok, status: res.status, json: async () => data };
};

window.eval(js);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) failures++; };
const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const input = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };

await sleep(250);

// 1. Login page shows; submit via doLogin (inline onsubmit can't run in jsdom)
check('login form rendered', Boolean(document.querySelector('form.login-card')));
const loginForm = document.querySelector('form.login-card');
const usernameInput = loginForm.elements.namedItem('username');
const passwordInput = loginForm.elements.namedItem('password');
usernameInput.value = 'pavit';
passwordInput.value = '5161211';
// jsdom quirk: named form access (form.username) is undefined here; expose it for doLogin.
Object.defineProperty(loginForm, 'username', { get: () => usernameInput });
Object.defineProperty(loginForm, 'password', { get: () => passwordInput });
const submitEvt = new window.Event('submit', { bubbles: true, cancelable: true });
await window.doLogin.call(window, { target: loginForm, preventDefault: () => {} });
await sleep(500);
check('dashboard after login', Boolean(document.querySelector('.project-grid')));

// 2. New project button (real <a href="#/new"> click → hashchange)
document.querySelector('a[href="#/new"]').click();
await sleep(400);
check('editor opens for new project', Boolean(document.querySelector('[data-save]')));
input(document.querySelector('[data-meta="name"]'), 'E2E Test Project');
input(document.querySelector('[data-meta="tagline"]'), 'E2E tagline');

// 3. Toggle the budget module on by clicking its switch track
click(document.querySelector('[data-module="budget"] .module-head .switch .track'));
await sleep(150);
check('budget module toggled on', window.__state.editing.modules.find(m => m.id === 'budget').on === true);

// 3b. Toggle it off again (button must work both ways)
click(document.querySelector('[data-module="budget"] .module-head .switch .track'));
await sleep(150);
check('budget module toggled off', window.__state.editing.modules.find(m => m.id === 'budget').on === false);

// 3c. Module head click toggles too
click(document.querySelector('[data-module="budget"] [data-toggle-module]'));
await sleep(150);
check('module head toggles module on', window.__state.editing.modules.find(m => m.id === 'budget').on === true);

// 3c2. Select one question inside budget (empty modules are dropped on save by design)
click(document.querySelector('[data-q="budget.budget"] .switch .track'));
await sleep(150);
check('budget question selected', window.__state.editing.modules.find(m => m.id === 'budget').selected.has('budget.budget'));

// 3d. Turn basics ON first (module bodies only render when the module is on)
click(document.querySelector('[data-module="basics"] [data-toggle-module]'));
await sleep(150);
check('basics module toggled on', window.__state.editing.modules.find(m => m.id === 'basics').on === true);

// 3e. Select All
click(document.querySelector('[data-module="basics"] [data-select-all]'));
await sleep(150);
const basics = window.__state.editing.modules.find(m => m.id === 'basics');
check('select all works', basics.selected.size === basics.libQuestions.length);

// 3f. Deselect All
click(document.querySelector('[data-module="basics"] [data-deselect-all]'));
await sleep(150);
check('deselect all works', basics.selected.size === 0);

// 3g. Toggle an individual question switch
click(document.querySelector('[data-q="basics.name"] [data-q-on]'));
await sleep(150);
check('single question toggle on', basics.selected.has('basics.name'));

// 4. Add custom question
click(document.querySelector('[data-module="basics"] [data-add-question]'));
await sleep(150);
const cEditor = document.querySelector('[data-module="basics"] [data-custom-editor]');
check('custom editor visible', cEditor && !cEditor.classList.contains('hidden'));
input(cEditor.querySelector('[data-c-label]'), 'How many locations?');
cEditor.querySelector('[data-c-type]').value = 'radio';
input(cEditor.querySelector('[data-c-options]'), 'One, Two, Three');
click(cEditor.querySelector('[data-c-add]'));
await sleep(150);
check('custom question added', basics.customs.length === 1);

// 4b. Edit the custom question via ✏️
click(document.querySelector('[data-module="basics"] [data-edit-custom]'));
await sleep(150);
const eForm = document.querySelector('[data-module="basics"] [data-edit-custom-form]');
check('custom edit form visible', Boolean(eForm));
input(eForm.querySelector('[data-e-label]'), 'How many locations (edited)?');
click(eForm.querySelector('[data-e-save]'));
await sleep(150);
check('custom question edited', basics.customs[0].label === 'How many locations (edited)?');

// 4c. Cancel add (editor hide)
click(document.querySelector('[data-module="basics"] [data-add-question]'));
await sleep(150);
click(document.querySelector('[data-module="basics"] [data-c-cancel]'));
await sleep(150);
check('custom editor hidden after cancel', document.querySelector('[data-module="basics"] [data-custom-editor]').classList.contains('hidden'));

// 5. Save (new project)
click(document.querySelector('[data-save]'));
await sleep(600);
check('saved → hash now #/edit/<id>', /^#\/edit\/\d+$/.test(window.location.hash));
const projId = window.location.hash.split('/')[2];
check('customer link input present', Boolean(document.querySelector('.share-box input.mono')));

// 5b. Saved state — open backend to verify config round-trip
{
  const res = await fetch(`${BASE}/api/projects/${projId}`, { headers: { Cookie: cookies } });
  const body = await res.json();
  const bm = body.project.config.modules.find(m => m.id === 'basics');
  check('backend persisted custom question', bm && bm.questions.some(q => typeof q === 'object' && q.label === 'How many locations (edited)?'));
  check('backend persisted single-question selection', bm && bm.questions.includes('basics.name'));
  check('backend persisted budget module on', body.project.config.modules.some(m => m.id === 'budget'));
}

// 6. Set status to live via select + save again
const statusSel = document.querySelector('[data-meta="status"]');
statusSel.value = 'live';
statusSel.dispatchEvent(new window.Event('change', { bubbles: true }));
click(document.querySelector('[data-save]'));
await sleep(500);

// 7. Open detail page
document.querySelector(`a[href="#/project/${projId}"]`).click();
await sleep(500);
check('detail page renders', Boolean(document.querySelector('.detail-head')));
check('detail page shows Live badge', document.querySelector('.badge-live') !== null);

// 8. Backend persistence check
{
  const res = await fetch(`${BASE}/api/projects`, { headers: { Cookie: cookies } });
  const list = await res.json();
  const saved = list.projects.find(p => p.id === Number(projId));
  check('saved project persisted in backend', Boolean(saved));
  check('saved project status is live', saved && saved.status === 'live');
  console.log('  → slug:', saved && saved.slug, '| status:', saved && saved.status);
}

// 9. Clone button on the detail page (navigates to the clone's editor)
const dupBtn = document.querySelector('.detail-head [data-duplicate]');
check('clone button on detail page', Boolean(dupBtn));
if (dupBtn) {
  click(dupBtn);
  await sleep(600);
  check('clone navigates to editor', /^#\/edit\/\d+$/.test(window.location.hash));
  check('clone opens a different project', window.location.hash !== `#/edit/${projId}`);
}

// 10. Delete the cloned project from its detail page
const clonedId = window.location.hash.split('/')[2];
window.location.hash = `#/project/${clonedId}`;
await sleep(500);
window.confirm = () => true;
const delBtn = document.querySelector('[data-del-project]');
check('delete button present', Boolean(delBtn));
if (delBtn) {
  delBtn.onclick();
  await sleep(600);
  check('back to dashboard after delete', window.location.hash === '#/' || window.location.hash === '#');
  const res = await fetch(`${BASE}/api/projects/${clonedId}`, { headers: { Cookie: cookies } });
  check('cloned project really deleted (404)', res.status === 404);
}

// 11. Cleanup: delete the E2E project through the UI flow
window.location.hash = `#/project/${projId}`;
await sleep(500);
const delBtn2 = document.querySelector('[data-del-project]');
if (delBtn2) {
  delBtn2.onclick();
  await sleep(600);
  const res = await fetch(`${BASE}/api/projects/${projId}`, { headers: { Cookie: cookies } });
  check('E2E project cleaned up (404)', res.status === 404);
}

// 12. Logout button (jsdom doesn't run inline onclick — call the exposed handler)
await window.doLogout();
await sleep(400);
check('logout returns to login screen', Boolean(document.querySelector('form.login-card')));
const meRes = await fetch(`${BASE}/api/me`, { headers: { Cookie: cookies } });
check('backend session cleared after logout (401)', meRes.status === 401);

server.close();
console.log(failures ? `\n${failures} FAILURES` : '\nALL ADMIN E2E CHECKS PASSED');
process.exit(failures ? 1 : 0);
