// Regression test: a fresh database must contain NO projects.
//
// Bug this guards: lib/db.js used to run seedDemo() on import, inserting two
// hardcoded projects ("The Daily Bloom" and "Marcus Reed — Photography", plus a
// fake submission) into every new database. A brand-new deployment therefore
// opened on somebody else's demo data, which the admin had to delete by hand —
// and on serverless hosts, where /tmp is wiped, they came back.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.VERCEL = '1';                 // skip app.listen on import
process.env.DATA_DIR = path.join(os.tmpdir(), `reqtest-noseed-${process.pid}-${Date.now()}`);
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const app = (await import('../server.js')).default;
const server = await new Promise(resolve => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (cond ? '' : '  ' + extra));
  if (!cond) failures++;
};

async function req(p, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json, token: (res.headers.get('set-cookie') || '').split(';')[0] || null };
}

const login = await req('/api/login', { method: 'POST', body: { username: 'pavit', password: '5161211' } });
const cookie = login.token;

// ---- the dashboard starts empty ----------------------------------------
const list = await req('/api/projects', { cookie });
check('a fresh install has zero projects', list.json?.projects?.length === 0,
  'got ' + JSON.stringify(list.json?.projects?.map(p => p.slug)));

// ---- the old demo slugs must not resolve --------------------------------
for (const slug of ['daily-bloom', 'photo-portfolio']) {
  const pub = await req(`/api/public/${slug}`);
  check(`demo slug "${slug}" is not seeded`, pub.status === 404, 'status=' + pub.status);
}

// ---- no stray submissions ----------------------------------------------
const created = await req('/api/projects', {
  method: 'POST', cookie,
  body: { name: 'First Real Project', status: 'live', config: { modules: [{ id: 'basics', questions: ['basics.name', 'basics.one_liner'] }] } }
});
check('admin can create the first project', created.status === 201);
const subs = await req(`/api/projects/${created.json.project.id}/submissions`, { cookie });
check('a new project starts with no submissions', subs.json?.submissions?.length === 0);

// ---- the project the admin made is the only one -------------------------
const after = await req('/api/projects', { cookie });
check('only the admin-created project exists', after.json?.projects?.length === 1,
  'got ' + JSON.stringify(after.json?.projects?.map(p => p.slug)));
check('it keeps the name the admin chose', after.json?.projects?.[0]?.name === 'First Real Project');

// ---- restarting must not re-seed ----------------------------------------
// Deleting every project has to leave the dashboard empty: seeding ran on
// import, so anything that re-imports the module must not bring demos back.
await req(`/api/projects/${created.json.project.id}`, { method: 'DELETE', cookie });
const emptied = await req('/api/projects', { cookie });
check('deleting the last project leaves the dashboard empty', emptied.json?.projects?.length === 0,
  'got ' + JSON.stringify(emptied.json?.projects?.map(p => p.slug)));

server.close();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

console.log(failures ? `\n${failures} NO-SEED TEST(S) FAILED` : '\nALL NO-SEED TESTS PASSED');
process.exit(failures ? 1 : 0);
