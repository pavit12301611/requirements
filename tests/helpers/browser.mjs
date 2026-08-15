// Test harness: runs the real admin UI against a real Express server backed by
// a real SQLite database.
//
// Why not a mocked fetch? Because the interesting failures live in the seam
// between the UI and the backend — a card builds an href from a project id, the
// router parses it back out, a handler re-fetches it over HTTP. A stubbed fetch
// answers /api/projects/undefined just as happily as a valid URL and hides
// exactly the bugs worth catching. Here every click produces a real request,
// hits real SQL, and the assertions can be checked against the database
// afterwards.
//
// Only the browser APIs jsdom genuinely lacks are stubbed (clipboard, object
// URLs, scrollIntoView); application code is never patched.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const PUBLIC = new URL('../../public/', import.meta.url);

// Boots the Express app on an ephemeral port with its own throwaway database.
export async function startBackend(label = 'ui') {
  process.env.VERCEL = '1'; // skip app.listen() on import; we listen ourselves
  process.env.DATA_DIR = path.join(os.tmpdir(), `req-${label}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

  const app = (await import('../../server.js')).default;
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const dataDir = process.env.DATA_DIR;

  return {
    base,
    server,
    stop() {
      server.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
    // Direct API access, for arranging fixtures and verifying what the UI wrote.
    async api(p, { method = 'GET', body, cookie } = {}) {
      const headers = {};
      if (cookie) headers.Cookie = cookie;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(base + p, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
      });
      let json = null;
      try { json = await res.json(); } catch { /* no body */ }
      return { status: res.status, json, token: (res.headers.get('set-cookie') || '').split(';')[0] || null };
    }
  };
}

// Opens the admin SPA in jsdom, wired to the real server.
// `cookie` omitted → the app boots signed out, so the login form can be driven.
export function openAdmin(base, { path: startPath = '/', cookie = null } = {}) {
  const html = fs.readFileSync(new URL('admin.html', PUBLIC), 'utf8');
  const js = fs.readFileSync(new URL('admin.js', PUBLIC), 'utf8');

  // 'dangerously' (not 'outside-only') because the admin markup wires several
  // controls with inline handlers — the login form's onsubmit, the topbar's
  // onclick="doLogout()", onfocus="this.select()". With 'outside-only' jsdom
  // silently ignores those attributes, so a test would "pass" while never
  // exercising the real handler. Nothing untrusted is loaded here: the only
  // scripts are this repo's own public/admin.js.
  const dom = new JSDOM(html, {
    url: new URL(startPath, base).href,
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const { window } = dom;
  const jar = { cookie };            // mutable: login/logout rewrite it
  const requests = [];               // every request the UI made
  const copied = [];                 // clipboard writes
  const downloads = [];              // CSV / object-URL downloads

  // --- browser APIs jsdom does not implement -----------------------------
  window.Element.prototype.scrollIntoView = function () {};
  window.URL.createObjectURL = blob => {
    downloads.push(blob);
    return 'blob:mock/' + downloads.length;
  };
  window.URL.revokeObjectURL = () => {};
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async text => { copied.push(text); } }
  });
  window.confirm = () => true;       // overridable per test
  window.alert = () => {};

  // HTMLFormElement's named getter (`form.username` → the control named
  // "username") is part of the HTML standard and works in every real browser,
  // but jsdom does not implement it. The login handler relies on it
  // (`e.target.username.value`), so without this the form would appear broken
  // in tests only. Populate the named properties in the capture phase, which
  // runs before the form's own inline onsubmit.
  window.document.addEventListener('submit', ev => {
    const form = ev.target;
    if (!form || form.tagName !== 'FORM') return;
    for (const control of form.elements) {
      const key = control.name || control.id;
      if (key && !(key in form)) {
        Object.defineProperty(form, key, { configurable: true, get: () => control });
      }
    }
  }, true);

  // --- real network, with a cookie jar ------------------------------------
  const realFetch = globalThis.fetch;
  window.fetch = async (url, opts = {}) => {
    const abs = new URL(url, base).href;
    requests.push(`${opts.method || 'GET'} ${new URL(abs).pathname}`);
    const headers = { ...(opts.headers || {}) };
    if (jar.cookie) headers.Cookie = jar.cookie;
    const res = await realFetch(abs, { ...opts, headers });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const [pair] = setCookie.split(';');
      jar.cookie = pair.endsWith('=') ? null : pair;   // Max-Age=0 clears it
    }
    return res;
  };

  window.eval(js);

  return {
    window,
    document: window.document,
    requests,
    copied,
    downloads,
    get cookie() { return jar.cookie; },
    // Reads the text of the CSV blob handed to URL.createObjectURL.
    async lastDownloadText() {
      const blob = downloads[downloads.length - 1];
      return blob ? await blob.text() : null;
    }
  };
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// A real synthetic click. jsdom follows in-page hash hrefs on anchors by
// itself, so navigation is genuine rather than simulated.
export const click = (win, el) => {
  if (!el) throw new Error('click: element not found');
  return el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
};

// Types into an input/textarea/select the way a user does, firing the events
// the app listens for.
export const type = (win, el, value) => {
  if (!el) throw new Error('type: element not found');
  el.value = value;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
};

// Waits until `fn()` is truthy (or the timeout expires) instead of sleeping a
// fixed amount — keeps the suite fast and free of arbitrary races.
export async function waitFor(fn, { timeout = 4000, interval = 25 } = {}) {
  const started = Date.now();
  for (;;) {
    let value;
    // `fn` may be async (e.g. it polls the database over HTTP). Awaiting is
    // essential: a bare Promise is always truthy, so without this the very
    // first call would "succeed" instantly and the assertion after it would
    // read a value that had not settled yet.
    try { value = await fn(); } catch { value = false; }
    if (value) return value;
    if (Date.now() - started > timeout) return null;
    await sleep(interval);
  }
}

// Convenience selectors shared by the specs.
export const byText = (root, selector, text) =>
  [...root.querySelectorAll(selector)].find(el => el.textContent.trim() === text);
export const containingText = (root, selector, text) =>
  [...root.querySelectorAll(selector)].find(el => el.textContent.includes(text));
export const cardNamed = (doc, name) =>
  [...doc.querySelectorAll('.project-card')].find(c => c.querySelector('h3')?.textContent === name);
export const toastState = doc => ({
  text: doc.querySelector('#toast .msg')?.textContent || '',
  kind: doc.querySelector('#toast')?.className || ''
});
