// Storage test: the remote libSQL/Turso backend must serve the full app
// correctly. Uses a local file: libSQL database to exercise the exact same
// code path as a real Turso deployment, without needing credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbFile = path.join(os.tmpdir(), `reqforge-turso-${process.pid}-${Date.now()}.db`);
try { fs.unlinkSync(dbFile); } catch { /* fresh file */ }

// Must be set BEFORE importing the server (db.js reads env at import time).
process.env.VERCEL = '1';
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.TURSO_AUTH_TOKEN;

const { storageInfo } = await import('../lib/db.js');
const app = (await import('../server.js')).default;
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) failures++; };

async function req(p, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json, cookie: res.headers.get('set-cookie')?.split(';')[0] || null };
}

check('storage mode is turso', storageInfo.mode === 'turso');
check('turso storage is not ephemeral', storageInfo.ephemeral === false);

const health = await req('/api/health');
check('health endpoint reports turso', health.json?.storage?.mode === 'turso');

const login = await req('/api/login', { method: 'POST', body: { username: 'pavit', password: '5161211' } });
check('login works on turso backend', login.status === 200 && login.cookie);

const created = await req('/api/projects', {
  method: 'POST', cookie: login.cookie,
  body: {
    name: 'Turso Backend Test', status: 'live',
    config: { modules: [{ id: 'basics', questions: ['basics.name', 'basics.purpose'] }] }
  }
});
check('project created on turso backend', created.status === 201);
const slug = created.json?.project?.slug;
const id = created.json?.project?.id;

const submitted = await req(`/api/public/${slug}/submit`, {
  method: 'POST',
  body: { customer_name: 'Turso Customer', customer_email: 'turso@example.com', answers: [{ id: 'basics.name', value: 'Turso site' }] }
});
check('customer submission stored on turso backend', submitted.status === 201);

const list = await req('/api/projects', { cookie: login.cookie });
const found = list.json?.projects?.find(p => p.id === id);
check('project persisted with submission count', found?.submissions === 1);

const removed = await req(`/api/projects/${id}`, { method: 'DELETE', cookie: login.cookie });
check('project deleted on turso backend', removed.status === 200);

server.close();
console.log(failures ? `\n${failures} FAILURES` : '\nALL TURSO STORAGE TESTS PASSED');
process.exit(failures ? 1 : 0);
