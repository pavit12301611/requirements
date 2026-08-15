// Regression test for the "Open" button on a project card.
//
// This suite deliberately runs the admin UI against a REAL Express server and a
// REAL SQLite database (no mocked fetch), because the interesting failures live
// in the seam between the two: the card builds an href from the project id, the
// router parses it back out, and the detail view re-fetches it over HTTP. A
// mocked fetch would happily answer a request for /api/projects/undefined.
//
// Covers: live and draft projects, cards reached through the search filter,
// opening a second project after going back, re-opening the same project,
// arriving via a server-rendered path route, and a project deleted elsewhere.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

process.env.VERCEL = '1';
process.env.DATA_DIR = path.join(os.tmpdir(), `reqopen-${process.pid}-${Date.now()}`);
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const app = (await import('../server.js')).default;
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

let fail = 0;
const check = (n, c, extra = '') => { console.log((c ? 'PASS' : 'FAIL') + ' — ' + n + (c ? '' : '  ' + extra)); if (!c) fail++; };

// --- seed two real projects through the API (as an admin would) ---
async function api(p, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json, token: (res.headers.get('set-cookie') || '').split(';')[0] || null };
}
const login = await api('/api/login', { method: 'POST', body: { username: 'pavit', password: '5161211' } });
const cookie = login.token;
const liveP = (await api('/api/projects', { method: 'POST', cookie, body: { name: 'Café & Bar — München #1', status: 'live' } })).json.project;
const draftP = (await api('/api/projects', { method: 'POST', cookie, body: { name: 'Beta Draft Site', status: 'draft' } })).json.project;
console.log(`fixtures: live id=${liveP.id} slug=${liveP.slug} | draft id=${draftP.id} slug=${draftP.slug}\n`);

const html = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../public/admin.js', import.meta.url), 'utf8');

// Boot a browser-like env whose fetch talks to the real server, carrying cookies.
function boot(startPath = '/') {
  const dom = new JSDOM(html, { url: base + startPath, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  const realFetch = globalThis.fetch;
  window.fetch = (u, opts = {}) => realFetch(new URL(u, base).href, { ...opts, headers: { ...(opts.headers || {}), Cookie: cookie } });
  window.confirm = () => true;
  window.eval(js);
  return { window, document: window.document };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Pure synthetic click — jsdom follows in-page hash hrefs itself, exactly like a
// browser, so this is the real user path with nothing simulated.
const click = (win, el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));

// ---------- 1. dashboard renders both cards ----------
{
  const { window, document } = boot('/');
  await sleep(400);
  const cards = document.querySelectorAll('.project-card');
  check('dashboard shows both projects', cards.length === 2, 'count=' + cards.length);

  const opens = [...document.querySelectorAll('.p-foot a')].filter(a => a.textContent.trim() === 'Open');
  check('every card has an Open button', opens.length === 2, 'count=' + opens.length);
  console.log('   Open hrefs:', opens.map(a => a.getAttribute('href')).join(' , '));

  // click Open on the FIRST card
  const firstCardName = document.querySelector('.project-card h3').textContent;
  click(window, opens[0]);
  await sleep(500);
  const heading = document.querySelector('h1')?.textContent;
  check('Open navigates to the project detail page', !!document.querySelector('[data-del-project]'),
    'heading=' + heading);
  check('detail page shows the right project', heading === firstCardName,
    `expected="${firstCardName}" got="${heading}"`);
  check('no error toast after Open',
    !document.querySelector('#toast').className.includes('err'),
    'toast=' + document.querySelector('#toast .msg').textContent);
}

// ---------- 2. Open works for BOTH live and draft ----------
for (const proj of [liveP, draftP]) {
  const { window, document } = boot('/');
  await sleep(400);
  const card = [...document.querySelectorAll('.project-card')].find(c => c.querySelector('h3').textContent === proj.name);
  const open = [...card.querySelectorAll('a')].find(a => a.textContent.trim() === 'Open');
  click(window, open);
  await sleep(500);
  check(`Open works for ${proj.status} project "${proj.name}"`,
    document.querySelector('h1')?.textContent === proj.name,
    'got=' + document.querySelector('h1')?.textContent + ' toast=' + document.querySelector('#toast .msg').textContent);
}

// ---------- 3. Open AFTER using the search filter ----------
{
  const { window, document } = boot('/');
  await sleep(400);
  const search = document.querySelector('#dash-search');
  search.value = 'Beta';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(300);
  const cards = document.querySelectorAll('.project-card');
  check('search narrows to one card', cards.length === 1, 'count=' + cards.length);
  const open = [...cards[0].querySelectorAll('a')].find(a => a.textContent.trim() === 'Open');
  click(window, open);
  await sleep(500);
  check('Open works on a filtered card', document.querySelector('h1')?.textContent === 'Beta Draft Site',
    'got=' + document.querySelector('h1')?.textContent);
}

// ---------- 4. Open → back → Open a DIFFERENT project ----------
{
  const { window, document } = boot('/');
  await sleep(400);
  let opens = [...document.querySelectorAll('.p-foot a')].filter(a => a.textContent.trim() === 'Open');
  click(window, opens[0]);
  await sleep(500);
  const first = document.querySelector('h1').textContent;

  const back = [...document.querySelectorAll('a')].find(a => a.textContent.includes('All projects'));
  click(window, back);
  await sleep(500);
  check('back to dashboard from detail', !!document.querySelector('#dash-search'));

  opens = [...document.querySelectorAll('.p-foot a')].filter(a => a.textContent.trim() === 'Open');
  click(window, opens[1]);
  await sleep(500);
  const second = document.querySelector('h1').textContent;
  check('Open on a second, different project works', second !== first && !!document.querySelector('[data-del-project]'),
    `first="${first}" second="${second}"`);
}

// ---------- 5. Open the SAME project twice in a row ----------
{
  const { window, document } = boot('/');
  await sleep(400);
  const opens = [...document.querySelectorAll('.p-foot a')].filter(a => a.textContent.trim() === 'Open');
  click(window, opens[0]);
  await sleep(400);
  const back = [...document.querySelectorAll('a')].find(a => a.textContent.includes('All projects'));
  click(window, back);
  await sleep(400);
  const opens2 = [...document.querySelectorAll('.p-foot a')].filter(a => a.textContent.trim() === 'Open');
  click(window, opens2[0]);
  await sleep(400);
  check('re-opening the same project still works', !!document.querySelector('[data-del-project]'),
    'toast=' + document.querySelector('#toast .msg').textContent);
}

// ---------- 6. Open from a PATH-route entry (/project/:id already open) ----------
{
  const { window, document } = boot(`/project/${liveP.id}`);
  await sleep(500);
  check('path entry renders detail', !!document.querySelector('[data-del-project]'));
  const back = [...document.querySelectorAll('a')].find(a => a.textContent.includes('All projects'));
  click(window, back);
  await sleep(500);
  const opens = [...document.querySelectorAll('.p-foot a')].filter(a => a.textContent.trim() === 'Open');
  check('dashboard reachable from a path-route detail', opens.length === 2, 'count=' + opens.length);
  if (opens.length) {
    click(window, opens[1]);
    await sleep(500);
    check('Open works after arriving via a path route', !!document.querySelector('[data-del-project]'),
      'toast=' + document.querySelector('#toast .msg').textContent);
  }
}

// ---------- 7. a project deleted in another tab ----------
{
  const { window, document } = boot('/');
  await sleep(400);
  await api(`/api/projects/${draftP.id}`, { method: 'DELETE', cookie });   // vanishes server-side
  const card = [...document.querySelectorAll('.project-card')].find(c => c.querySelector('h3').textContent === 'Beta Draft Site');
  const open = [...card.querySelectorAll('a')].find(a => a.textContent.trim() === 'Open');
  click(window, open);
  await sleep(600);
  check('stale Open shows an error instead of a blank page',
    document.querySelector('#toast').className.includes('err') || !!document.querySelector('#dash-search'),
    'toast=' + document.querySelector('#toast .msg').textContent);
}

server.close();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(fail ? `\n${fail} OPEN-BUTTON TEST(S) FAILED` : '\nALL OPEN-BUTTON TESTS PASSED');
process.exit(fail ? 1 : 0);
