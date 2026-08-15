// Regression test: API error responses must always be JSON.
//
// Bug this guards: a malformed or oversized request body fell through to
// Express' default error handler, which replies with an HTML stack trace. That
// leaked absolute server paths and dependency versions, and the admin UI (which
// does `res.json()` and reads `.error`) surfaced a useless "Request failed"
// instead of the real reason.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.VERCEL = '1';                 // skip app.listen on import
process.env.DATA_DIR = path.join(os.tmpdir(), `reqtest-err-${process.pid}-${Date.now()}`);
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

// Sign in so we reach the route rather than the auth guard.
const login = await fetch(base + '/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'pavit', password: '5161211' })
});
const cookie = login.headers.get('set-cookie').split(';')[0];

async function raw(p, body, { method = 'POST' } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json, ctype: res.headers.get('content-type') || '' };
}

// ---- malformed JSON ----------------------------------------------------
const bad = await raw('/api/projects', '{"name": ');
check('malformed JSON → 400', bad.status === 400, 'status=' + bad.status);
check('malformed JSON → JSON content-type', bad.ctype.includes('application/json'), bad.ctype);
check('malformed JSON → has an error message', Boolean(bad.json?.error), bad.text.slice(0, 120));
check('malformed JSON → no HTML stack trace', !bad.text.includes('<html') && !bad.text.includes('<pre>'), bad.text.slice(0, 120));
check('malformed JSON → does not leak server paths',
  !bad.text.includes('node_modules') && !bad.text.includes(process.cwd()), bad.text.slice(0, 160));

// ---- oversized payload -------------------------------------------------
const huge = JSON.stringify({ name: 'x'.repeat(3 * 1024 * 1024) });
const big = await raw('/api/projects', huge);
check('oversized body → 413', big.status === 413, 'status=' + big.status);
check('oversized body → JSON content-type', big.ctype.includes('application/json'), big.ctype);
check('oversized body → has an error message', Boolean(big.json?.error), big.text.slice(0, 120));
check('oversized body → no HTML stack trace', !big.text.includes('<html') && !big.text.includes('<pre>'), big.text.slice(0, 120));
check('oversized body → does not leak server paths',
  !big.text.includes('node_modules'), big.text.slice(0, 160));

// ---- the public submit endpoint behaves the same ------------------------
const pubBad = await fetch(base + '/api/public/daily-bloom/submit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{oops'
});
const pubText = await pubBad.text();
check('public submit: malformed JSON → 400', pubBad.status === 400, 'status=' + pubBad.status);
check('public submit: malformed JSON → no HTML', !pubText.includes('<html'), pubText.slice(0, 120));

// ---- valid requests are untouched --------------------------------------
const good = await raw('/api/projects', JSON.stringify({ name: 'Error Handler Check' }));
check('valid create still returns 201', good.status === 201, 'status=' + good.status);
check('valid create returns the project', Boolean(good.json?.project?.id), good.text.slice(0, 120));

const unknown = await fetch(base + '/api/definitely-not-a-route', { headers: { Cookie: cookie } });
const unknownJson = await unknown.json().catch(() => null);
check('unknown API route → JSON 404', unknown.status === 404 && Boolean(unknownJson?.error));

server.close();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

console.log(failures ? `\n${failures} ERROR-HANDLING TEST(S) FAILED` : '\nALL ERROR-HANDLING TESTS PASSED');
process.exit(failures ? 1 : 0);
