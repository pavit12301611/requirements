// Integration test for the ReqForge backend (boots the real Express app in-process).
// Covers status visibility (draft/live/closed) + login password coercion — the bugs
// that the jsdom-only smoke tests can't reach.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Configure BEFORE importing the server (it reads env at import time).
process.env.VERCEL = '1';                                        // skip app.listen on import
process.env.DATA_DIR = path.join(os.tmpdir(), `reqtest-${process.pid}-${Date.now()}`);
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const app = (await import('../server.js')).default;
const { createLiveProject, createDraftProject } = await import('./helpers/fixtures.mjs');

const server = await new Promise((resolve) => {
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
  const token = setCookie ? setCookie.split(';')[0] : null;
  return { status: res.status, json, token };
}

// ---- login -------------------------------------------------------------
const badLogin = await req('/api/login', { method: 'POST', body: { username: 'pavit', password: 'nope' } });
check('wrong password rejected (401)', badLogin.status === 401);

// password sent as a JSON number must still match (string coercion fix)
const numLogin = await req('/api/login', { method: 'POST', body: { username: 'pavit', password: 5161211 } });
check('numeric password accepted (coerced)', numLogin.status === 200 && numLogin.json?.ok === true);
const cookie = numLogin.token;

const strLogin = await req('/api/login', { method: 'POST', body: { username: 'pavit', password: '5161211' } });
check('string password accepted', strLogin.status === 200);

// ---- fixtures ----------------------------------------------------------
// The database starts empty, so build the projects this suite needs.
const liveProject = await createLiveProject(req, cookie);
const draftProject = await createDraftProject(req, cookie);
const liveSlug = liveProject.slug;
const draftSlug = draftProject.slug;
check('fixture: live project created', liveProject.status === 'live' && Boolean(liveSlug));
check('fixture: draft project created', draftProject.status === 'draft' && Boolean(draftSlug));

// ---- status visibility -------------------------------------------------
// live project → 200
const livePub = await req(`/api/public/${liveSlug}`);
check('live project is public (200)', livePub.status === 200 && Array.isArray(livePub.json?.modules));

// draft project → 404 (hidden from customers)
const draftPub = await req(`/api/public/${draftSlug}`);
check('draft project hidden (404)', draftPub.status === 404);

// draft project rejects submissions too
const draftSubmit = await req(`/api/public/${draftSlug}/submit`, {
  method: 'POST',
  body: { customer_name: 'X', customer_email: 'x@y.com', answers: [] }
});
check('draft project rejects submit (404)', draftSubmit.status === 404);

// flip the draft project to closed → 410 with closing message
const draftProj = draftProject;
await req(`/api/projects/${draftProj.id}`, {
  method: 'PATCH', cookie,
  body: { status: 'closed', closing: 'Sorry, submissions are over.' }
});
const closedPub = await req(`/api/public/${draftSlug}`);
check('closed project returns 410', closedPub.status === 410);
check('closed project carries closing message', closedPub.json?.project?.closing === 'Sorry, submissions are over.');

// closed project rejects submissions
const closedSubmit = await req(`/api/public/${draftSlug}/submit`, {
  method: 'POST', body: { customer_name: 'X', customer_email: 'x@y.com', answers: [] }
});
check('closed project rejects submit (410)', closedSubmit.status === 410);

// ---- customer submission on a live project ----------------------------
const okSubmit = await req(`/api/public/${liveSlug}/submit`, {
  method: 'POST',
  body: {
    customer_name: 'Test Client',
    customer_email: 'client@example.com',
    answers: [
      { id: 'basics.name', label: 'Name?', type: 'text', value: 'Bloom' },
      { id: 'basics.one_liner', label: 'Liner?', type: 'textarea', value: 'Flowers' },
      { id: 'pages.pages', label: 'Pages?', type: 'checkbox', value: ['Home'] },
      { id: 'features.features', label: 'Features?', type: 'checkbox', value: ['Contact form'] },
      { id: 'budget.budget', label: 'Budget?', type: 'radio', value: '$3,000 – $7,000' },
      { id: 'goals.must_haves', label: 'Must?', type: 'textarea', value: 'x' }
    ]
  }
});
check('live submission accepted (201)', okSubmit.status === 201 && okSubmit.json?.ok === true);

// submission shows up in the admin list
const liveSubs = await req(`/api/projects/${liveProject.id}/submissions`, { cookie });
const found = liveSubs.json.submissions.some(s => s.customer_name === 'Test Client');
check('submission visible to admin', found);

// invalid email rejected
const badEmail = await req(`/api/public/${liveSlug}/submit`, {
  method: 'POST',
  body: { customer_name: 'X', customer_email: 'not-an-email', answers: [] }
});
check('invalid email rejected (400)', badEmail.status === 400);

server.close();
console.log(failures ? `\n${failures} FAILURES` : '\nALL SERVER TESTS PASSED');
process.exit(failures ? 1 : 0);
