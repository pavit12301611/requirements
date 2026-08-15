// Regression test: the admin SPA must behave identically whether it was
// reached by a hash route (#/project/7) or by one of the server-rendered path
// routes (/project/7, /edit/7, /new) — those are real URLs the Express app
// serves, so a customer bookmark or a hard refresh lands on them.
//
// Bugs this guards:
//  1. Per-submission "Delete" and "Copy Markdown" read the project id with
//     `location.hash.split('/')[2]`. On /project/7 the hash is empty, so they
//     called /api/projects/undefined/... and always failed.
//  2. routeParts() falls back to the pathname whenever the hash is empty or
//     "#/". Left in place, the stale path kept winning over later hash
//     navigation, so after deleting a project (or clicking "All projects") the
//     app re-rendered the dead project and flashed "Project not found".
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const ROOT = new URL('../public/', import.meta.url);
const html = fs.readFileSync(new URL('admin.html', ROOT), 'utf8');
const js = fs.readFileSync(new URL('admin.js', ROOT), 'utf8');

const library = [
  { id: 'basics', title: 'About', icon: '🧭', blurb: 'b',
    questions: [{ id: 'basics.name', type: 'text', required: true, label: 'Name?' }] }
];

function makeEnv(startUrl) {
  const dom = new JSDOM(html, { url: startUrl, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const calls = [];
  let deleted = false;
  let project = {
    id: 7, slug: 'acme', name: 'Acme', tagline: 't', welcome: '', closing: '', status: 'draft',
    config: { modules: [{ id: 'basics', questions: ['basics.name'] }] },
    created_at: '2026-08-09 12:00:00', preview_path: '/c/acme?preview=tok'
  };
  let submissions = [{
    id: 55, project_id: 7, customer_name: 'Emma Carter', customer_email: 'e@x.com',
    answers: [{ id: 'basics.name', label: 'Name?', type: 'text', value: 'Acme' }],
    created_at: '2026-08-10 09:00:00'
  }];

  window.fetch = async (url, opts = {}) => {
    calls.push((opts.method || 'GET') + ' ' + url);
    const ok = data => ({ ok: true, status: 200, json: async () => data });
    const notFound = { ok: false, status: 404, json: async () => ({ error: 'Project not found' }) };
    if (url === '/api/me') return ok({ ok: true, admin: 'pavit' });
    if (url === '/api/library') return ok({ modules: library });
    if (url === '/api/projects') return ok({ projects: deleted ? [] : [{ ...project, submissions: submissions.length }] });
    if (url === '/api/projects/7' && opts.method === 'DELETE') { deleted = true; return ok({ ok: true }); }
    if (url === '/api/projects/7') return deleted ? notFound : ok({ project });
    if (url === '/api/projects/7/submissions') return deleted ? notFound : ok({ submissions });
    if (url === '/api/projects/7/submissions/55' && opts.method === 'DELETE') { submissions = []; return ok({ ok: true }); }
    return { ok: false, status: 404, json: async () => ({ error: 'unexpected ' + (opts.method || 'GET') + ' ' + url }) };
  };
  window.confirm = () => true;
  window.eval(js);
  return { window, document: window.document, calls };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const click = (win, el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (cond ? '' : '  ' + extra));
  if (!cond) failures++;
};

// ---- 1. submission actions from the PATH route -------------------------
{
  const { window, document, calls } = makeEnv('https://example.test/project/7');
  await sleep(250);
  check('path route /project/7 renders the detail page', !!document.querySelector('[data-del-project]'));

  const delSub = document.querySelector('[data-del-sub]');
  check('path route: delete-submission button is rendered', !!delSub);
  calls.length = 0;
  click(window, delSub);
  await sleep(200);
  check('path route: delete submission targets the real project id',
    calls.some(c => c === 'DELETE /api/projects/7/submissions/55'), JSON.stringify(calls));
  check('path route: delete submission never sends "undefined"',
    !calls.some(c => c.includes('undefined')), JSON.stringify(calls));
}

// ---- 2. copy-as-markdown from the PATH route ---------------------------
{
  const { window, document, calls } = makeEnv('https://example.test/project/7');
  await sleep(250);
  const md = document.querySelector('[data-copy-markdown]');
  check('path route: copy-markdown button is rendered', !!md);
  calls.length = 0;
  click(window, md);
  await sleep(200);
  check('path route: copy-markdown targets the real project id',
    calls.some(c => c === 'GET /api/projects/7/submissions'), JSON.stringify(calls));
  check('path route: copy-markdown never sends "undefined"',
    !calls.some(c => c.includes('undefined')), JSON.stringify(calls));
}

// ---- 3. the same actions still work on the HASH route ------------------
{
  const { window, document, calls } = makeEnv('https://example.test/');
  await sleep(200);
  window.location.hash = '#/project/7';
  await sleep(200);
  calls.length = 0;
  click(window, document.querySelector('[data-del-sub]'));
  await sleep(200);
  check('hash route: delete submission still targets the real project id',
    calls.some(c => c === 'DELETE /api/projects/7/submissions/55'), JSON.stringify(calls));
}

// ---- 4. deleting a project from a path route ---------------------------
{
  const { window, document, calls } = makeEnv('https://example.test/project/7');
  await sleep(250);
  calls.length = 0;
  click(window, document.querySelector('[data-del-project]'));
  await sleep(400);
  check('path route: delete project issues the DELETE', calls.some(c => c === 'DELETE /api/projects/7'));
  check('path route: delete project does not re-fetch the dead project',
    !calls.some(c => c === 'GET /api/projects/7'), JSON.stringify(calls));
  check('path route: delete project shows a success toast, not an error',
    document.querySelector('#toast').className.includes('ok'),
    'toast=' + document.querySelector('#toast .msg').textContent);
  check('path route: delete project leaves the detail view',
    !document.querySelector('[data-del-project]'));
}

// ---- 5. "All projects" from a path route reaches the dashboard ---------
{
  const { window, document } = makeEnv('https://example.test/project/7');
  await sleep(250);
  window.location.hash = '#/';
  await sleep(250);
  check('path route: "All projects" reaches the dashboard',
    !!document.querySelector('#dash-search') || !!document.querySelector('.empty'),
    'still-on-detail=' + !!document.querySelector('[data-del-project]'));
}

// ---- 6. the deep path is normalised into a hash route ------------------
{
  const { window } = makeEnv('https://example.test/project/7');
  await sleep(250);
  check('path route is rewritten to the equivalent hash route',
    window.location.hash === '#/project/7', 'hash=' + window.location.hash);
}

// ---- 7. /edit/:id and /new keep working --------------------------------
{
  const { window, document } = makeEnv('https://example.test/edit/7');
  await sleep(250);
  check('path route /edit/7 renders the editor', !!document.querySelector('[data-save]'));
  window.location.hash = '#/project/7';
  await sleep(250);
  check('path route: editor → detail navigation works', !!document.querySelector('[data-del-project]'));
}
{
  const { document } = makeEnv('https://example.test/new');
  await sleep(250);
  check('path route /new renders an empty editor', !!document.querySelector('[data-save]'));
}

console.log(failures ? `\n${failures} PATH-ROUTE TEST(S) FAILED` : '\nALL PATH-ROUTE TESTS PASSED');
process.exit(failures ? 1 : 0);
