// Regression: creating a project then clicking Open / Preview must work.
// Covers the reported "I just made the project, Open says not found" bug —
// drafts opened in a new tab (no session cookie) need a signed preview token.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

process.env.VERCEL = '1';
process.env.DATA_DIR = path.join(os.tmpdir(), `reqopen-${process.pid}-${Date.now()}`);
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const app = (await import('../server.js')).default;

const server = await new Promise(resolve => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

let failures = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) failures++; };

async function req(p, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, json, token: setCookie ? setCookie.split(';')[0] : null };
}

const login = await req('/api/login', { method: 'POST', body: { username: 'pavit', password: '5161211' } });
const cookie = login.token;
check('login works', login.status === 200 && Boolean(cookie));

// Create a brand-new draft the same way the editor now does (single POST).
const created = await req('/api/projects', {
  method: 'POST',
  cookie,
  body: {
    name: 'Just Made This',
    tagline: 'fresh project',
    welcome: 'Hello\nthere',
    status: 'draft',
    config: { modules: [{ id: 'basics', questions: ['basics.name'] }] }
  }
});
check('create returns 201 with numeric id', created.status === 201 && Number.isInteger(created.json?.project?.id));
check('create returns slug', created.json?.project?.slug === 'just-made-this');
check('create includes preview_path', typeof created.json?.project?.preview_path === 'string' && created.json.project.preview_path.includes('preview='));

const id = created.json.project.id;
const slug = created.json.project.slug;
const previewPath = created.json.project.preview_path;

// Admin Open button = GET /api/projects/:id
const opened = await req(`/api/projects/${id}`, { cookie });
check('Open by id finds the new project', opened.status === 200 && opened.json?.project?.name === 'Just Made This');

const openedSlug = await req(`/api/projects/${slug}`, { cookie });
check('Open by slug finds the new project', openedSlug.status === 200 && openedSlug.json?.project?.id === id);

const missing = await req('/api/projects/undefined', { cookie });
check('undefined id is a 404, not a crash', missing.status === 404);

// Customer page without auth: draft stays hidden
const pub = await req(`/api/public/${slug}`);
check('draft is hidden from customers (404)', pub.status === 404);

// Same draft with the preview token from the project card — no cookie
const previewQs = previewPath.split('?')[1];
const previewed = await req(`/api/public/${slug}?${previewQs}`);
check('preview token opens the new draft without a session cookie', previewed.status === 200 && previewed.json?.project?.name === 'Just Made This');
check('preview token is treated as admin-style access', previewed.json?.isAdmin === true);

const badPreview = await req(`/api/public/${slug}?preview=nope`);
check('bogus preview token is rejected', badPreview.status === 404);

// Frontend: Open href uses the real id; Preview uses preview_path
const html = fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../public/admin.js', import.meta.url), 'utf8');
const project = { ...created.json.project, submissions: 0, created_at: '2026-08-12 12:00:00' };

const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;
window.confirm = () => true;

window.fetch = async (url, opts = {}) => {
  if (url === '/api/me') return { ok: true, status: 200, json: async () => ({ ok: true, admin: 'pavit' }) };
  if (url === '/api/library') return { ok: true, status: 200, json: async () => ({ modules: [] }) };
  if (url === '/api/projects') return { ok: true, status: 200, json: async () => ({ projects: [project] }) };
  if (url === `/api/projects/${id}` || url === `/api/projects/${id}/submissions`) {
    if (String(url).endsWith('/submissions')) return { ok: true, status: 200, json: async () => ({ submissions: [] }) };
    return { ok: true, status: 200, json: async () => ({ project }) };
  }
  return { ok: false, status: 404, json: async () => ({ error: 'Project not found' }) };
};

window.eval(js);
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(150);

const open = document.querySelector('a.btn[href^="#/project/"]');
const preview = [...document.querySelectorAll('.project-card a')].find(a => /Preview|View page/.test(a.textContent));
check('project card Open href uses the new project id', open?.getAttribute('href') === `#/project/${id}`);
check('project card Preview uses the signed preview path', preview?.getAttribute('href') === previewPath);

open.click();
await sleep(150);
check('clicking Open loads the project detail, not a not-found toast',
  document.querySelector('h1')?.textContent.includes('Just Made This') &&
  !document.querySelector('#toast')?.classList.contains('err'));

// Search must keep focus after more than one character (old bug: full re-render stole focus)
window.location.hash = '#/';
await sleep(120);
const search = document.getElementById('dash-search');
search.focus();
search.value = 'Ju';
search.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(40);
check('search input keeps focus after typing', document.activeElement === document.getElementById('dash-search'));
check('search still shows the matching card', document.querySelector('.project-card h3')?.textContent === 'Just Made This');

server.close();
console.log(failures ? `\n${failures} FAILURES` : '\nALL OPEN-PROJECT TESTS PASSED');
process.exit(failures ? 1 : 0);
