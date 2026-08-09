/* ReqForge admin app — vanilla JS SPA */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  library: null,        // modules from /api/library
  editing: null,        // editor state
  editingId: null,
  savedHash: null,
  signedIn: false,      // true once the session has been confirmed
  adminName: 'Admin'    // admin username (shown in the topbar)
};
window.__state = state; // debug handle

/* ---------------- helpers ---------------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    if (res.status === 401 && !path.startsWith('/api/login')) {
      // Session rejected while navigating: show the sign-in screen, and say why
      // if the session was previously known-good (expired / server restarted).
      renderLogin(state.signedIn ? 'Your session expired — please sign in again to continue.' : null);
      state.signedIn = false;
    }
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(msg, kind = 'ok') {
  const el = $('#toast');
  el.className = `toast ${kind} show`;
  $('.msg', el).textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function copyText(text, label = 'Copied to clipboard') {
  const done = () => toast(label, 'ok');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch { toast('Could not copy — select manually', 'err'); }
  ta.remove();
}

function badge(status) {
  return `<span class="badge badge-${status}">${esc(status)}</span>`;
}
function dateStr(iso) { return new Date(iso + 'Z').toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }

/* ---------------- app shell ---------------- */
function topbar() {
  return `
  <div class="topbar"><div class="wrap topbar-inner">
    <a class="brand" href="#/"><span class="logo">✓</span> ReqForge</a>
    <span class="spacer"></span>
    <span class="user-chip"><span class="avatar">${esc((state.adminName || 'A').slice(0, 1).toUpperCase())}</span>${esc(state.adminName)}</span>
    <button class="btn btn-ghost btn-sm" onclick="doLogout()">Log out</button>
  </div></div>`;
}

async function doLogout() {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* clear locally anyway */ }
  state.signedIn = false;
  renderLogin();
}
window.doLogout = doLogout;

/* ---------------- login ---------------- */
function renderLogin(notice) {
  $('#app').innerHTML = `
  <div class="login-wrap fade-in">
    <form class="card login-card" onsubmit="doLogin(event)">
      <div class="logo-big">✓</div>
      <h1>Welcome to ReqForge</h1>
      <p class="sub">Sign in to build custom requirement questionnaires for your clients — tick or type.</p>
      ${notice ? `<div class="login-notice">⚠️ ${esc(notice)}</div>` : ''}
      <div class="field">
        <input class="input" type="text" name="username" placeholder="Admin username" value="pavit" autocomplete="username" autofocus required>
      </div>
      <div class="field">
        <input class="input" type="password" name="password" placeholder="Password" autocomplete="current-password" required>
      </div>
      <button class="btn btn-primary btn-block" type="submit">Sign in</button>
      <div class="hint">Default admin: <b>pavit</b> · change it with the <span class="mono">ADMIN_USERNAME</span> / <span class="mono">ADMIN_PASSWORD</span> env vars</div>
    </form>
  </div>`;
  setTimeout(() => $('input[name="username"]', $('#app'))?.focus(), 50);
}

window.doLogin = async function (e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await api('/api/login', {
      method: 'POST',
      body: { username: e.target.username.value, password: e.target.password.value }
    });
    location.hash = '#/';
    await boot();
  } catch (err) { toast(err.message, 'err'); }
  finally { btn.disabled = false; }
};

/* ---------------- boot & router ---------------- */
async function boot() {
  try {
    const me = await api('/api/me');
    if (me.admin) state.adminName = me.admin;
    state.signedIn = true;
  } catch (err) {
    if (err.status !== 401) renderLogin(); // 401 already rendered by api() (keeps its notice)
    return;
  }
  if (!state.library) {
    const lib = await api('/api/library');
    state.library = lib.modules;
  }
  route();
}

function route() {
  const hash = location.hash || '#/';
  if (hash.startsWith('#/project/')) renderDetail(hash.split('/')[2]);
  else if (hash.startsWith('#/edit/')) renderEditor(hash.split('/')[2]);
  else if (hash === '#/new') renderEditor(null);
  else renderDashboard();
}
window.addEventListener('hashchange', route);

/* ---------------- dashboard ---------------- */
async function renderDashboard() {
  const { projects } = await api('/api/projects');
  $('#app').innerHTML = `
  ${topbar()}
  <div class="wrap fade-in">
    <div class="page-head">
      <div>
        <h1>Your projects</h1>
        <p class="sub">Create a project, pick the questions you want to ask, and send your client the generated link.</p>
      </div>
      <div class="actions">
        <a class="btn btn-primary" href="#/new">+ New project</a>
      </div>
    </div>
    ${projects.length ? `
    <div class="project-grid">
      ${projects.map(p => `
        <div class="card project-card">
          <div class="p-top">
            <h3>${esc(p.name || 'Untitled project')}</h3>
            ${badge(p.status)}
          </div>
          ${p.tagline ? `<p class="p-tag">${esc(p.tagline)}</p>` : ''}
          <div class="p-meta">
            <span class="badge badge-count">${p.submissions} submission${p.submissions === 1 ? '' : 's'}</span>
            <span class="badge badge-draft" style="background:#f1f2f7;color:#69708a;border-color:var(--line)">${esc(dateStr(p.created_at))}</span>
          </div>
          <div class="p-foot">
            <a class="btn btn-ghost btn-sm" href="#/project/${p.id}">Open</a>
            <a class="btn btn-ghost btn-sm" href="#/edit/${p.id}">Edit questions</a>
            <a class="btn btn-primary btn-sm" target="_blank" href="/c/${p.slug}">View page →</a>
          </div>
        </div>`).join('')}
    </div>` : `
    <div class="card empty">
      <div class="big">📋</div>
      <h3>No projects yet</h3>
      <p>Create your first project to generate a customer questionnaire.</p>
      <a class="btn btn-primary" href="#/new">+ New project</a>
    </div>`}
  </div>`;
}

/* ---------------- editor ---------------- */
function buildEditing(project) {
  const cfg = project?.config || { modules: [] };
  const enabled = new Map((cfg.modules || []).map(m => [m.id, m]));
  return {
    meta: {
      name: project?.name || '',
      tagline: project?.tagline || '',
      welcome: project?.welcome || '',
      closing: project?.closing || '',
      status: project?.status || 'draft'
    },
    modules: state.library.map(m => {
      const mc = enabled.get(m.id);
      const selected = new Set((mc?.questions || []).map(q => typeof q === 'string' ? q : q.id));
      const customs = (mc?.questions || []).filter(q => typeof q !== 'string')
        .map(q => ({ ...q, custom: true }));
      return {
        id: m.id, title: m.title, icon: m.icon, blurb: m.blurb,
        on: !!mc, selected, customs, libQuestions: m.questions
      };
    })
  };
}

function renderEditor(id) {
  if (state.editingId !== id || !state.editing) {
    state.editingId = id;
    state.editing = null;
    renderEditorShell(id);
    return;
  }
  renderEditorShell(id);
}

async function renderEditorShell(id) {
  let project = null;
  if (id) {
    try {
      project = (await api(`/api/projects/${id}`)).project;
    } catch (err) {
      // 401 → api() already rendered the login screen; otherwise go back to the list.
      if (err.status !== 401) {
        toast(err.message || 'Could not load project', 'err');
        if (location.hash !== '#/') location.hash = '#/';
      }
      return;
    }
  }
  if (id && !state.editing) state.editing = buildEditing(project);
  else if (!id && !state.editing) state.editing = buildEditing(null);

  const e = state.editing;
  const isNew = !id;
  const link = isNew ? null : `/c/${project.slug}`;

  $('#app').innerHTML = `
  ${topbar()}
  <div class="wrap fade-in">
    <div class="page-head">
      <div>
        <h1>${isNew ? 'New project' : esc(e.meta.name || 'Untitled project')}</h1>
        <p class="sub">Pick the modules and questions your client will answer. Toggle anything on or off, or add your own questions.</p>
      </div>
      <div class="actions">
        <a class="btn btn-ghost" href="#/${isNew ? '' : `project/${id}`}">← Back</a>
        <button class="btn btn-primary" data-save>💾 Save</button>
      </div>
    </div>

    <div class="editor-grid">
      <div class="editor-side">
        ${link ? `
        <div class="card editor-card">
          <h2>🔗 Customer link</h2>
          <div class="share-box">
            <input class="input mono" readonly value="${esc(link)}" onfocus="this.select()">
            <button class="btn btn-ghost btn-sm" data-copy="${esc(link)}">Copy</button>
          </div>
          <p style="font-size:12.5px;color:var(--muted);margin-top:9px">Send this link to your customer — the page is built automatically from your selection.</p>
          <a class="btn btn-primary btn-sm btn-block" style="margin-top:10px" target="_blank" href="${esc(link)}">Open customer page ↗</a>
        </div>` : `
        <div class="card editor-card" style="background:var(--grad-soft);border-style:dashed">
          <h2>💡 How it works</h2>
          <p style="font-size:13.5px;color:#3d435e;line-height:1.6">
            1. Give the project a name and press <b>Save</b>.<br>
            2. Tick the modules & questions you want to ask.<br>
            3. We generate a link for your customer — they tick and type their answers.<br>
            4. Read everything in the project view.
          </p>
        </div>`}

        <div class="card editor-card">
          <h2>✏️ Project details</h2>
          <div class="field"><label>Project name *</label>
            <input class="input" data-meta="name" value="${esc(e.meta.name)}" placeholder="e.g. Acme Bakery — new site">
          </div>
          <div class="field"><label>Short description</label>
            <input class="input" data-meta="tagline" value="${esc(e.meta.tagline)}" placeholder="Shown on the customer page">
          </div>
          <div class="field"><label>Welcome message</label>
            <textarea class="textarea" data-meta="welcome" placeholder="Greet the customer & explain what to do…">${esc(e.meta.welcome)}</textarea>
          </div>
          <div class="field"><label>Thank-you message</label>
            <textarea class="textarea" data-meta="closing" placeholder="Shown after they submit…">${esc(e.meta.closing)}</textarea>
          </div>
          <div class="field"><label>Status</label>
            <select class="select" data-meta="status">
              <option value="draft" ${e.meta.status === 'draft' ? 'selected' : ''}>Draft — hidden from customers</option>
              <option value="live" ${e.meta.status === 'live' ? 'selected' : ''}>Live — link works</option>
              <option value="closed" ${e.meta.status === 'closed' ? 'selected' : ''}>Closed — link shows "closed"</option>
            </select>
          </div>
        </div>
      </div>

      <div class="editor-main">
        <div class="card editor-card">
          <h2>🧩 Question bank <span style="color:var(--muted);font-weight:500;font-size:12.5px">— tick what you want to ask this customer</span></h2>
        </div>
        ${e.modules.map(m => moduleCard(m)).join('')}
      </div>
    </div>
  </div>`;
}

function moduleCard(m) {
  const on = m.on;
  return `
  <div class="module-card ${on ? 'on' : ''}" data-module="${m.id}">
    <div class="module-head" data-toggle-module>
      <span class="module-icon">${m.icon}</span>
      <div class="module-title">
        <h3>${esc(m.title)}</h3>
        <p>${esc(m.blurb)}</p>
      </div>
      <label class="switch">
        <input type="checkbox" data-module-on ${on ? 'checked' : ''}>
        <span class="track"></span>
      </label>
    </div>
    ${on ? `
    <div class="module-body">
      ${m.libQuestions.map(q => `
        <div class="q-row" data-q="${q.id}">
          <span class="q-type">${q.type}</span>
          <span class="q-label">${esc(q.label)}${q.required ? ' <span style="color:var(--red)">*</span>' : ''}</span>
          <label class="switch small">
            <input type="checkbox" data-q-on ${m.selected.has(q.id) ? 'checked' : ''}>
            <span class="track"></span>
          </label>
        </div>`).join('')}
      ${m.customs.map(q => `
        <div class="q-row custom" data-custom="${q.id}">
          <span class="q-type">${q.type}</span>
          <span class="q-label">✏️ ${esc(q.label)}</span>
          <button class="q-del" data-del-custom="${q.id}" title="Remove">✕</button>
        </div>`).join('')}
      <button class="add-q" data-add-question>+ Add custom question</button>
      <div class="custom-editor hidden" data-custom-editor>
        <input class="input" data-c-label placeholder="Your question (e.g. How many locations do you have?)">
        <div class="row2">
          <select class="select" data-c-type>
            <option value="text">Short text</option>
            <option value="textarea">Long text</option>
            <option value="checkbox">Tick boxes (multi-select)</option>
            <option value="radio">Single choice</option>
          </select>
          <input class="input" data-c-options placeholder="Options, comma separated (for tick boxes / single choice)">
        </div>
        <div class="mini"><input type="checkbox" data-c-required id="req-${m.id}"> <label for="req-${m.id}">Required</label>
          <span class="spacer"></span>
          <button class="btn btn-primary btn-sm" data-c-add>Add question</button>
          <button class="btn btn-ghost btn-sm" data-c-cancel>Cancel</button>
        </div>
      </div>
    </div>` : ''}
  </div>`;
}

// ---- editor interactions (event delegation) ----
document.addEventListener('click', async e => {
  const app = $('#app');
  if (!app || !app.contains(e.target)) return;

  const modEl = e.target.closest('[data-module]');
  const editing = state.editing;
  if (!editing || !modEl) return;
  const modId = modEl.dataset.module;
  const mod = editing.modules.find(m => m.id === modId);
  if (!mod) return;

  // module head click → toggle (ignore clicks that land on the switch itself;
  // those are handled by the [data-module-on] branch below to avoid double-toggling)
  if (e.target.closest('[data-toggle-module]') && !e.target.closest('.switch')) {
    mod.on = !mod.on;
    renderEditorShell(state.editingId);
    return;
  }
  // toggle switch inside the module head → mirror the native checkbox state
  const modSwitch = e.target.closest('[data-module-on]');
  if (modSwitch) {
    mod.on = modSwitch.checked;
    renderEditorShell(state.editingId);
    return;
  }
  const qToggle = e.target.closest('[data-q-on]');
  if (qToggle) {
    const qId = e.target.closest('[data-q]').dataset.q;
    qToggle.checked ? mod.selected.add(qId) : mod.selected.delete(qId);
    return;
  }
  if (e.target.closest('[data-add-question]')) {
    modEl.querySelector('[data-custom-editor]').classList.remove('hidden');
    modEl.querySelector('[data-c-label]').focus();
    return;
  }
  if (e.target.closest('[data-c-cancel]')) {
    modEl.querySelector('[data-custom-editor]').classList.add('hidden');
    return;
  }
  if (e.target.closest('[data-c-add]')) {
    const label = modEl.querySelector('[data-c-label]').value.trim();
    const type = modEl.querySelector('[data-c-type]').value;
    const optsRaw = modEl.querySelector('[data-c-options]').value;
    const required = modEl.querySelector('[data-c-required]').checked;
    if (!label) { toast('Question text is required', 'err'); return; }
    if ((type === 'checkbox' || type === 'radio') && !optsRaw.trim()) {
      toast('Add options (comma separated)', 'err'); return;
    }
    const options = optsRaw.split(',').map(s => s.trim()).filter(Boolean);
    const q = { id: 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), custom: true, type, label, options, required };
    mod.customs.push(q);
    renderEditorShell(state.editingId);
    toast('Custom question added', 'ok');
    return;
  }
  const del = e.target.closest('[data-del-custom]');
  if (del) {
    mod.customs = mod.customs.filter(q => q.id !== del.dataset.delCustom);
    renderEditorShell(state.editingId);
    return;
  }
});

function updateMeta(e) {
  const el = e.target.closest('[data-meta]');
  if (el && state.editing) state.editing.meta[el.dataset.meta] = el.value;
}
document.addEventListener('input', updateMeta);
document.addEventListener('change', updateMeta);

// ---- save ----
document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-save]');
  if (!btn) return;
  const editing = state.editing;
  const meta = editing.meta;
  if (!meta.name.trim()) { toast('Give the project a name first', 'err'); return; }

  const config = {
    modules: editing.modules.filter(m => m.on).map(m => ({
      id: m.id,
      questions: [
        ...m.libQuestions.filter(q => m.selected.has(q.id)).map(q => q.id),
        ...m.customs.map(q => ({ id: q.id, type: q.type, label: q.label, options: q.options, required: q.required }))
      ]
    }))
  };

  try {
    if (state.editingId) {
      const { project } = await api(`/api/projects/${state.editingId}`, { method: 'PATCH', body: { ...meta, config } });
      state.editing = buildEditing(project);
      toast('Project saved ✓', 'ok');
      if (location.hash !== `#/edit/${project.id}`) location.hash = `#/edit/${project.id}`;
    } else {
      const { project } = await api('/api/projects', { method: 'POST', body: { name: meta.name } });
      await api(`/api/projects/${project.id}`, { method: 'PATCH', body: { ...meta, config } });
      state.editing = null;
      location.hash = `#/edit/${project.id}`;
      toast('Project created — link ready ✓', 'ok');
    }
  } catch (err) { toast(err.message, 'err'); }
});

document.addEventListener('click', e => {
  const cp = e.target.closest('[data-copy]');
  if (cp) copyText(cp.dataset.copy, 'Link copied ✓');
});

/* ---------------- project detail ---------------- */
async function renderDetail(id) {
  let project, subs;
  try {
    [project, subs] = await Promise.all([
      api(`/api/projects/${id}`).then(r => r.project),
      api(`/api/projects/${id}/submissions`).then(r => r.submissions)
    ]);
  } catch (err) {
    // 401 → api() already rendered the login screen; don't clobber it.
    // Other failures (e.g. 404 after the project was deleted) → back to the list.
    if (err.status !== 401) {
      toast(err.message || 'Could not load project', 'err');
      if (location.hash !== '#/') location.hash = '#/';
      else renderDashboard();
    }
    return;
  }
  const link = `/c/${project.slug}`;
  const enabled = (project.config.modules || []).length;
  const totalQ = (project.config.modules || []).reduce((n, m) => n + m.questions.length, 0);

  $('#app').innerHTML = `
  ${topbar()}
  <div class="wrap fade-in">
    <div class="detail-head">
      <div class="d-top">
        <div>
          <h1>${esc(project.name || 'Untitled project')}</h1>
          ${project.tagline ? `<p class="d-tag">${esc(project.tagline)}</p>` : ''}
        </div>
        <div class="d-actions">
          <a class="btn btn-ghost" href="#/"><span style="font-size:15px">←</span> All projects</a>
          <a class="btn btn-ghost" href="#/edit/${project.id}">✏️ Edit questions</a>
          <button class="btn btn-danger btn-sm" data-del-project>Delete</button>
        </div>
      </div>
      <div class="card editor-card">
        <div class="row" style="flex-wrap:wrap">
          <span class="badge badge-${project.status}">${project.status}</span>
          <span class="badge badge-count">${enabled} modules · ${totalQ} questions</span>
          <span class="badge badge-draft" style="background:#f1f2f7;color:#69708a;border-color:var(--line)">created ${esc(dateStr(project.created_at))}</span>
          <span class="spacer"></span>
          <span style="font-size:13px;color:var(--muted);font-weight:600">Customer link:</span>
          <div class="share-box" style="min-width:300px;flex:1">
            <input class="input mono" readonly value="${esc(link)}" onfocus="this.select()">
            <button class="btn btn-ghost btn-sm" data-copy="${esc(link)}">Copy</button>
          </div>
          <a class="btn btn-primary btn-sm" target="_blank" href="${esc(link)}">Open →</a>
        </div>
      </div>
    </div>

    <h2 style="font-size:17px;margin:26px 0 14px">💌 Submissions <span style="color:var(--muted);font-weight:500">(${subs.length})</span></h2>
    ${subs.length ? `
    <div class="submission-list" style="padding-top:0">
      ${subs.map((s, i) => subCard(s, i)).join('')}
    </div>` : `
    <div class="card empty">
      <div class="big">🕐</div>
      <h3>No answers yet</h3>
      <p>Send the customer link to your client and their answers will appear here.</p>
      <button class="btn btn-primary" data-copy="${esc(link)}">Copy customer link</button>
    </div>`}
  </div>`;

  const del = $('#app').querySelector('[data-del-project]');
  if (del) del.onclick = async () => {
    if (!confirm(`Delete "${project.name}" and all ${subs.length} submission(s)?`)) return;
    try {
      await api(`/api/projects/${project.id}`, { method: 'DELETE' });
      location.hash = '#/';
      toast('Project deleted', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
}

function subCard(s, i) {
  const initials = s.customer_name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  const answered = s.answers.length;
  return `
  <div class="sub-card" data-sub="${s.id}">
    <button class="sub-head">
      <span class="sub-avatar">${esc(initials)}</span>
      <span>
        <span class="who">${esc(s.customer_name)} ${s.customer_email ? `<span style="color:var(--muted);font-weight:500">· ${esc(s.customer_email)}</span>` : ''}</span>
        <div class="when">${esc(dateStr(s.created_at))} · ${answered} answer${answered === 1 ? '' : 's'}</div>
      </span>
      <span class="chev">▾</span>
    </button>
    <div class="sub-body">
      ${s.answers.map(a => `
        <div class="answer-row">
          <div class="q">${esc(a.label)}</div>
          <div class="a">${renderAnswer(a)}</div>
        </div>`).join('')}
      ${!s.answers.length ? '<p style="color:var(--muted);font-size:13.5px;padding:12px 0">No answers recorded.</p>' : ''}
    </div>
  </div>`;
}

function renderAnswer(a) {
  if (a.type === 'rating') {
    const n = Number(a.value) || 0;
    return `<span class="stars" style="gap:2px">${[1, 2, 3, 4, 5].map(i => `<span class="star-btn ${i <= n ? 'on' : ''}" style="font-size:18px">★</span>`).join('')}</span>`;
  }
  if (Array.isArray(a.value)) {
    return a.value.map(v => `<span class="chip" style="border-color:rgba(99,102,241,.35);background:var(--grad-soft);color:#4f46e5">${esc(v)}</span>`).join('');
  }
  return esc(a.value);
}

// submission expand
document.addEventListener('click', e => {
  const head = e.target.closest('[data-sub] .sub-head');
  if (head) head.closest('.sub-card').classList.toggle('open');
});

/* ---------------- go ---------------- */
boot();
