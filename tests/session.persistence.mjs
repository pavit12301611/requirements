// Session persistence regression test.
//
// Reproduces the reported bug end-to-end: sign in, then click "Open" /
// "Edit questions" → the admin SPA bounces to the sign-in screen while the URL
// stays on the requested route. Root cause was the in-memory session table:
// any restart or new serverless instance lost every session, so the next
// authed request 401'd. Signed stateless session cookies must survive a fresh
// server process.
//
// Strategy: boot server process A on a throwaway DATA_DIR, log in, kill it,
// boot a completely fresh server process B (same env credentials), and reuse
// the cookie A issued. It must still authenticate.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const DATA_DIR = path.join(os.tmpdir(), `reqsess-${process.pid}-${Date.now()}`);
fs.mkdirSync(DATA_DIR, { recursive: true });

let failures = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name); if (!cond) failures++; };

function startServer(port) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(port), DATA_DIR };
    delete env.VERCEL; delete env.VERCEL_ENV; delete env.AWS_LAMBDA_FUNCTION_NAME; // must call app.listen()
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`server on :${port} did not start`)); }, 15000);
    let out = '';
    child.stdout.on('data', chunk => {
      out += chunk;
      if (out.includes('ReqForge running')) { clearTimeout(timer); resolve(child); }
    });
    child.stderr.on('data', () => { /* experimental sqlite warning etc. */ });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`server on :${port} exited early (${code})`)); });
  });
}

async function req(base, p, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, json, token: setCookie ? setCookie.split(';')[0] : null };
}

const portA = 41000 + (process.pid % 4000);
const portB = portA + 2000;
let serverA, serverB;

try {
  // ---- process A: log in -------------------------------------------------
  serverA = await startServer(portA);
  const base = `http://127.0.0.1:${portA}`;
  const login = await req(base, '/api/login', { method: 'POST', body: { username: 'pavit', password: '5161211' } });
  check('login on process A succeeds', login.status === 200 && Boolean(login.token));
  const cookie = login.token;

  const meA = await req(base, '/api/me', { cookie });
  check('cookie authenticates on process A', meA.status === 200);

  // The database starts empty, so create the project the "Open" route needs.
  // Both processes share DATA_DIR, so process B sees it too.
  const createdA = await req(base, '/api/projects', {
    method: 'POST', cookie,
    body: { name: 'Session Test Project', status: 'live' }
  });
  check('project created on process A', createdA.status === 201);
  const projectId = createdA.json.project.id;

  serverA.kill('SIGKILL');

  // ---- process B: same cookie, completely fresh process ------------------
  // (equivalent to a Vercel instance hop, a `node --watch` reload or a restart)
  serverB = await startServer(portB);
  const baseB = `http://127.0.0.1:${portB}`;
  const meB = await req(baseB, '/api/me', { cookie });
  check('session survives a fresh server process', meB.status === 200 && meB.json?.admin === 'pavit');

  const projectsB = await req(baseB, '/api/projects', { cookie });
  check('projects list authenticates on process B', projectsB.status === 200 && Array.isArray(projectsB.json?.projects));

  check('project created on A is visible on B', projectsB.json.projects.some(p => p.id === projectId));

  const oneB = await req(baseB, `/api/projects/${projectId}`, { cookie });
  check('project detail authenticates on process B (the "Open" button route)', oneB.status === 200);

  // ---- tampered / bogus cookies still rejected ----------------------------
  const parts = cookie.split('.');
  parts[parts.length - 1] = 'A' + parts[parts.length - 1].slice(1); // corrupt the signature
  const tampered = await req(baseB, '/api/me', { cookie: parts.join('.') });
  check('tampered signature rejected (401)', tampered.status === 401);

  const forgedPayload = `admin.${Date.now()}.deadbeef.${'x'.repeat(43)}`;
  const forged = await req(baseB, '/api/me', { cookie: `rf_session=${forgedPayload}` });
  check('forged token rejected (401)', forged.status === 401);

  const old = `admin.${Date.now() - 1000 * 60 * 60 * 24 * 31}.deadbeef.${'x'.repeat(43)}`; // 31 days old
  const expired = await req(baseB, '/api/me', { cookie: `rf_session=${old}` });
  check('expired token rejected (401)', expired.status === 401);

  const none = await req(baseB, '/api/me');
  check('no cookie rejected (401)', none.status === 401);
} finally {
  serverA?.kill('SIGKILL');
  serverB?.kill('SIGKILL');
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL SESSION PERSISTENCE TESTS PASSED');
process.exit(failures ? 1 : 0);
