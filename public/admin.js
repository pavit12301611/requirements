/* ReqForge admin app — vanilla JS SPA */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  library: null,             // modules from /api/library
  editing: null,             // editor state
  editingId: null,
  editingCustom: null,       // ID of custom question currently being edited
  savedHash: null,
  signedIn: false,           // true once the session has been confirmed
  adminName: 'Admin',        // admin username (shown in the topbar)
  defaultCredentials: false, // true if using default pavit / 5161211 credentials
  dashboardSearch: '',
  dashboardStatusFilter: 'all',
  questionSearch: '',
  projects: null,            // cached dashboard list
  _dashSearchFocus: false,
  _qSearchFocus: false
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
function dateStr(iso) {
  if (!iso) return '';
  const clean = String(iso).includes('T') ? iso : String(iso).replace(' ', 'T') + 'Z';
  const d = new Date(clean);
  return isNaN(d) ? String(iso) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function projectKey(p) { return p?.id ?? p?.slug; }
function isUsableId(id) { return Boolean(id) && id !== 'undefined' && id !== 'null'; }
function customerPath(p) { return `/c/${p.slug}`; }
function previewPath(p) { return p.preview_path || customerPath(p); }
function absUrl(path) {
  try { return new URL(path, location.origin).href; } catch { return path; }
}
// The id of the project currently on screen, whatever URL style got us here.
// Reading `location.hash.split('/')[2]` breaks on the server-rendered path
// routes (/project/7), where the hash is empty and the id ends up "undefined".
function currentProjectId() {
  const [section, rawId] = routeParts();
  if (section !== 'project' || !rawId) return '';
  const id = decodeURIComponent(rawId);
  return isUsableId(id) ? id : '';
}

function routeParts() {
  if ((!location.hash || location.hash === '#' || location.hash === '#/') && location.pathname) {
    const pathParts = location.pathname.split('/').filter(Boolean);
    if (pathParts[0] === 'project' || pathParts[0] === 'edit' || pathParts[0] === 'new') return pathParts;
  }
  const hash = location.hash || '#/';
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
  return trimmed.split('/').filter(Boolean);
}
function snapshotEditing() {
  const e = state.editing;
  if (!e) return '';
  return JSON.stringify({
    meta: e.meta,
    modules: e.modules.map(m => ({ id: m.id, on: m.on, selected: [...m.selected].sort(), customs: m.customs }))
  });
}
function isDirty() {
  return Boolean(state.editing && state.savedHash != null && snapshotEditing() !== state.savedHash);
}
function invalidateProjects() { state.projects = null; }

/* ---------------- app shell ---------------- */
function topbar() {
  return `
  <div class="topbar"><div class="wrap topbar-inner">
    <a class="brand" href="#/"><span class="logo">✓</span> ReqForge</a>
    ${state.defaultCredentials ? `<span class="badge badge-draft" style="font-size:11px;padding:4px 10px;margin-left:8px" title="Set ADMIN_PASSWORD env var to secure">⚠️ Default Credentials</span>` : ''}
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
// The server renders the same SPA for /project/:id, /edit/:id and /new, but the
// app navigates with hashes. If we leave the deep path in the URL it keeps
// winning over the hash (routeParts falls back to the pathname whenever the
// hash is empty or "#/"), so going "home" or deleting a project re-rendered the
// old project and flashed a bogus "Project not found" error. Rewrite the path
// route into its hash equivalent once, up front, so there is a single source of
// truth for the rest of the session. replaceState does not fire hashchange, so
// the caller still routes explicitly.
function normalizePathRoute() {
  const hash = location.hash;
  if (hash && hash !== '#' && hash !== '#/') return;
  const parts = location.pathname.split('/').filter(Boolean);
  if (!['project', 'edit', 'new'].includes(parts[0])) return;
  try {
    history.replaceState(null, '', `${location.origin}/#/${parts.join('/')}`);
  } catch { /* history unavailable — the pathname fallback still routes */ }
}

async function boot() {
  normalizePathRoute();
  try {
    const me = await api('/api/me');
    if (me.admin) state.adminName = me.admin;
    state.defaultCredentials = Boolean(me.defaultCredentials);
    state.signedIn = true;
  } catch (err) {
    if (err.status !== 401) renderLogin();
    return;
  }
  if (!state.library) {
    const lib = await api('/api/library');
    state.library = lib.modules;
  }
  route();
}

function route() {
  const [section, rawId] = routeParts();
  let id = rawId ? decodeURIComponent(rawId) : '';
  if (!isUsableId(id)) id = '';
  if (section === 'project' && id) renderDetail(id);
  else if (section === 'edit' && id) renderEditor(id);
  else if (section === 'new') renderEditor(null);
  else renderDashboard();
}
window.addEventListener('hashchange', e => {
  if (isDirty() && !confirm('You have unsaved changes. Leave without saving?')) {
    history.replaceState(null, '', e.oldURL);
    return;
  }
  state._qSearchFocus = false;
  state._dashSearchFocus = false;
  route();
});
window.addEventListener('beforeunload', e => {
  if (!isDirty()) return;
  e.preventDefault();
  e.returnValue = '';
});

/* ---------------- dashboard ---------------- */
async function renderDashboard({ refetch = true } = {}) {
  try {
    if (refetch || !state.projects) {
      const { projects } = await api('/api/projects');
      state.projects = projects;
    }
  } catch (err) {
    if (err.status === 401) return;
    toast(err.message || 'Could not load projects', 'err');
    return;
  }
  const projects = state.projects || [];

  const filtered = projects.filter(p => {
    const q = state.dashboardSearch.toLowerCase();
    const matchSearch = !q || p.name.toLowerCase().includes(q) || (p.tagline && p.tagline.toLowerCase().includes(q));
    const matchStatus = state.dashboardStatusFilter === 'all' || p.status === state.dashboardStatusFilter;
    return matchSearch && matchStatus;
  });

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
    <div class="card editor-card" style="margin-bottom:18px;padding:14px 18px">
      <div class="row" style="flex-wrap:wrap;gap:12px">
        <div style="flex:1;min-width:220px">
          <input class="input" id="dash-search" placeholder="🔍 Search projects by name or tagline..." value="${esc(state.dashboardSearch)}">
        </div>
        <div style="width:160px">
          <select class="select" id="dash-status">
            <option value="all" ${state.dashboardStatusFilter === 'all' ? 'selected' : ''}>All Statuses</option>
            <option value="live" ${state.dashboardStatusFilter === 'live' ? 'selected' : ''}>Live</option>
            <option value="draft" ${state.dashboardStatusFilter === 'draft' ? 'selected' : ''}>Draft</option>
            <option value="closed" ${state.dashboardStatusFilter === 'closed' ? 'selected' : ''}>Closed</option>
          </select>
        </div>
      </div>
    </div>` : ''}

    ${filtered.length ? `
    <div class="project-grid">
      ${filtered.map(p => `
        <div class="card project-card">
          <div class="p-top">
            <h3>${esc(p.name || 'Untitled project')}</h3>
            ${badge(p.status)}
          </div>
          ${p.tagline ? `<p class="p-tag">${esc(p.tagline)}</p>` : ''}
          ${p.status === 'draft' ? `<p class="p-tag" style="color:var(--amber);font-size:12.5px">Hidden from customers until status is Live</p>` : ''}
          <div class="p-meta">
            <span class="badge badge-count">${p.submissions} submission${p.submissions === 1 ? '' : 's'}</span>
            <span class="badge badge-draft" style="background:#f1f2f7;color:#69708a;border-color:var(--line)">${esc(dateStr(p.created_at))}</span>
          </div>
          <div class="p-foot">
            <a class="btn btn-ghost btn-sm" href="#/project/${encodeURIComponent(projectKey(p))}">Open</a>
            <a class="btn btn-ghost btn-sm" href="#/edit/${encodeURIComponent(projectKey(p))}">Edit questions</a>
            <button class="btn btn-ghost btn-sm" data-duplicate="${esc(String(projectKey(p)))}" title="Duplicate project">📋 Clone</button>
            <a class="btn btn-primary btn-sm" target="_blank" rel="noopener" href="${esc(previewPath(p))}">${p.status === 'live' ? 'View page →' : 'Preview →'}</a>
          </div>
        </div>`).join('')}
    </div>` : projects.length ? `
    <div class="card empty">
      <div class="big">🔍</div>
      <h3>No projects match your filter</h3>
      <p>Try clearing your search or status filter.</p>
      <button class="btn btn-ghost" id="reset-filters">Reset filters</button>
    </div>` : `
    <div class="card empty">
      <div class="big">📋</div>
      <h3>No projects yet</h3>
      <p>Create your first project to generate a customer questionnaire.</p>
      <a class="btn btn-primary" href="#/new">+ New project</a>
    </div>`}
  </div>`;

  $('#dash-search')?.addEventListener('input', e => {
    state.dashboardSearch = e.target.value;
    state._dashSearchFocus = true;
    renderDashboard({ refetch: false });
  });
  $('#dash-status')?.addEventListener('change', e => {
    state.dashboardStatusFilter = e.target.value;
    renderDashboard({ refetch: false });
  });
  $('#reset-filters')?.addEventListener('click', () => {
    state.dashboardSearch = '';
    state.dashboardStatusFilter = 'all';
    state._dashSearchFocus = false;
    renderDashboard({ refetch: false });
  });
  if (state._dashSearchFocus) {
    const search = $('#dash-search');
    if (search) {
      search.focus();
      try { search.setSelectionRange(search.value.length, search.value.length); } catch { /* ignore */ }
    }
  }
}

// duplicate event listener
document.addEventListener('click', async e => {
  const dupBtn = e.target.closest('[data-duplicate]');
  if (!dupBtn) return;
  const id = dupBtn.dataset.duplicate;
  dupBtn.disabled = true;
  try {
    const { project } = await api(`/api/projects/${id}/duplicate`, { method: 'POST' });
    invalidateProjects();
    toast(`Cloned project as "${project.name}" ✓`, 'ok');
    if (!location.hash || location.hash === '#' || location.hash === '#/') renderDashboard();
    else location.hash = `#/edit/${project.id}`;
  } catch (err) { toast(err.message, 'err'); }
  finally { dupBtn.disabled = false; }
});

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
      if (err.status !== 401) {
        toast(err.message || 'Could not load project', 'err');
        if (location.hash !== '#/') location.hash = '#/';
      }
      return;
    }
  }
  if (id && !state.editing) {
    state.editing = buildEditing(project);
    state.savedHash = snapshotEditing();
  } else if (!id && !state.editing) {
    state.editing = buildEditing(null);
    state.savedHash = snapshotEditing();
  }

  paintEditor(id, project);
}

function paintEditor(id, project) {
  const e = state.editing;
  const isNew = !id;
  const shareUrl = isNew ? null : absUrl(customerPath(project));
  const openUrl = isNew ? null : previewPath(project);
  const scrollY = window.scrollY;

  const qSearch = state.questionSearch.toLowerCase();
  const visibleModules = e.modules.filter(m => {
    if (!qSearch) return true;
    const matchMod = m.title.toLowerCase().includes(qSearch) || m.blurb.toLowerCase().includes(qSearch);
    const matchQ = m.libQuestions.some(q => q.label.toLowerCase().includes(qSearch)) ||
      m.customs.some(q => q.label.toLowerCase().includes(qSearch));
    return matchMod || matchQ;
  });

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
        ${shareUrl ? `
        <div class="card editor-card">
          <h2>🔗 Customer link</h2>
          <div class="share-box">
            <input class="input mono" readonly value="${esc(shareUrl)}" onfocus="this.select()">
            <button class="btn btn-ghost btn-sm" data-copy="${esc(shareUrl)}">Copy</button>
          </div>
          <p style="font-size:12.5px;color:var(--muted);margin-top:9px">${e.meta.status === 'live' ? 'Send this link to your customer — the page is built automatically from your selection.' : 'Drafts are hidden from customers. Use Preview to check the page, then set status to Live before sharing.'}</p>
          <a class="btn btn-primary btn-sm btn-block" style="margin-top:10px" target="_blank" rel="noopener" href="${esc(openUrl)}">${e.meta.status === 'live' ? 'Open customer page ↗' : 'Preview customer page ↗'}</a>
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
        <div class="card editor-card" style="padding:16px 20px">
          <h2>🧩 Question bank <span style="color:var(--muted);font-weight:500;font-size:12.5px">— tick what you want to ask this customer</span></h2>
          <div style="margin-top:10px">
            <input class="input" id="q-search" placeholder="🔍 Search questions... (e.g. budget, logo, payment, domain)" value="${esc(state.questionSearch)}">
          </div>
        </div>
        ${visibleModules.map(m => moduleCard(m, qSearch)).join('')}
      </div>
    </div>
  </div>`;

  $('#q-search')?.addEventListener('input', e => {
    state.questionSearch = e.target.value;
    state._qSearchFocus = true;
    paintEditor(id, project);
  });
  if (state._qSearchFocus) {
    const qs = $('#q-search');
    if (qs) {
      qs.focus();
      try { qs.setSelectionRange(qs.value.length, qs.value.length); } catch { /* ignore */ }
    }
  }
  window.scrollTo(0, scrollY);
}

function moduleCard(m, qSearch = '') {
  const on = m.on;
  const filteredLib = qSearch
    ? m.libQuestions.filter(q => q.label.toLowerCase().includes(qSearch) || m.title.toLowerCase().includes(qSearch))
    : m.libQuestions;
  const filteredCustom = qSearch
    ? m.customs.filter(q => q.label.toLowerCase().includes(qSearch) || m.title.toLowerCase().includes(qSearch))
    : m.customs;

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
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0 10px;border-bottom:1px solid #f1f2f8;margin-bottom:4px">
        <span data-sel-count style="font-size:12px;color:var(--muted);font-weight:600">${m.selected.size} of ${m.libQuestions.length} selected</span>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:11px" data-select-all="${m.id}">Select All</button>
          <button class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:11px" data-deselect-all="${m.id}">Deselect All</button>
        </div>
      </div>

      ${filteredLib.map(q => `
        <div class="q-row" data-q="${q.id}">
          <span class="q-type">${q.type}</span>
          <span class="q-label">${esc(q.label)}${q.required ? ' <span style="color:var(--red)">*</span>' : ''}</span>
          <label class="switch small">
            <input type="checkbox" data-q-on ${m.selected.has(q.id) ? 'checked' : ''}>
            <span class="track"></span>
          </label>
        </div>`).join('')}

      ${filteredCustom.map((q, idx) => `
        ${state.editingCustom === q.id ? customEditForm(q, m.id) : `
        <div class="q-row custom" data-custom="${q.id}">
          <span class="q-type">${q.type}</span>
          <span class="q-label">✏️ ${esc(q.label)}${q.required ? ' <span style="color:var(--red)">*</span>' : ''}</span>
          <div style="display:flex;gap:4px;align-items:center">
            ${idx > 0 ? `<button class="btn btn-ghost btn-sm" style="padding:2px 6px;font-size:11px" data-move-custom="up" data-cid="${q.id}">▲</button>` : ''}
            ${idx < m.customs.length - 1 ? `<button class="btn btn-ghost btn-sm" style="padding:2px 6px;font-size:11px" data-move-custom="down" data-cid="${q.id}">▼</button>` : ''}
            <button class="btn btn-ghost btn-sm" style="padding:2px 6px;font-size:11px" data-edit-custom="${q.id}" title="Edit question">✏️</button>
            <button class="q-del" data-del-custom="${q.id}" title="Remove">✕</button>
          </div>
        </div>`}
      `).join('')}

      <button class="add-q" data-add-question>+ Add custom question</button>

      <div class="custom-editor hidden" data-custom-editor>
        <input class="input" data-c-label placeholder="Your question (e.g. How many locations do you have?)">
        <div class="row2">
          <select class="select" data-c-type>
            <option value="text">Short text</option>
            <option value="textarea">Long text</option>
            <option value="checkbox">Tick boxes (multi-select)</option>
            <option value="radio">Single choice</option>
            <option value="rating">1–5 Star Rating</option>
          </select>
          <input class="input" data-c-options placeholder="Options, comma separated (for tick boxes / single choice)">
        </div>
        <div class="row2">
          <input class="input" data-c-help placeholder="Help text / instructions (optional)">
          <input class="input" data-c-placeholder placeholder="Input placeholder text (optional)">
        </div>
        <div class="mini">
          <input type="checkbox" data-c-required id="req-${m.id}"> <label for="req-${m.id}">Required</label>
          <span class="spacer"></span>
          <button class="btn btn-primary btn-sm" data-c-add>Add question</button>
          <button class="btn btn-ghost btn-sm" data-c-cancel>Cancel</button>
        </div>
      </div>
    </div>` : ''}
  </div>`;
}

function customEditForm(q, modId) {
  return `
  <div class="custom-editor" data-edit-custom-form="${q.id}" style="margin:8px 0">
    <div style="font-weight:600;font-size:13px;color:var(--accent);margin-bottom:4px">✏️ Edit Custom Question</div>
    <input class="input" data-e-label value="${esc(q.label)}" placeholder="Question text">
    <div class="row2">
      <select class="select" data-e-type>
        <option value="text" ${q.type === 'text' ? 'selected' : ''}>Short text</option>
        <option value="textarea" ${q.type === 'textarea' ? 'selected' : ''}>Long text</option>
        <option value="checkbox" ${q.type === 'checkbox' ? 'selected' : ''}>Tick boxes (multi-select)</option>
        <option value="radio" ${q.type === 'radio' ? 'selected' : ''}>Single choice</option>
        <option value="rating" ${q.type === 'rating' ? 'selected' : ''}>1–5 Star Rating</option>
      </select>
      <input class="input" data-e-options value="${esc((q.options || []).join(', '))}" placeholder="Options, comma separated">
    </div>
    <div class="row2">
      <input class="input" data-e-help value="${esc(q.help || '')}" placeholder="Help text / instructions (optional)">
      <input class="input" data-e-placeholder value="${esc(q.placeholder || '')}" placeholder="Input placeholder text (optional)">
    </div>
    <div class="mini">
      <input type="checkbox" data-e-required id="ereq-${q.id}" ${q.required ? 'checked' : ''}>
      <label for="ereq-${q.id}">Required</label>
      <span class="spacer"></span>
      <button class="btn btn-primary btn-sm" data-e-save="${q.id}">Save changes</button>
      <button class="btn btn-ghost btn-sm" data-e-cancel="${q.id}">Cancel</button>
    </div>
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

  // select all / deselect all
  const selAll = e.target.closest('[data-select-all]');
  if (selAll) {
    mod.libQuestions.forEach(q => mod.selected.add(q.id));
    renderEditorShell(state.editingId);
    return;
  }
  const deselAll = e.target.closest('[data-deselect-all]');
  if (deselAll) {
    mod.selected.clear();
    renderEditorShell(state.editingId);
    return;
  }

  // module head click
  if (e.target.closest('[data-toggle-module]') && !e.target.closest('.switch')) {
    mod.on = !mod.on;
    renderEditorShell(state.editingId);
    return;
  }
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
    const countEl = modEl.querySelector('[data-sel-count]');
    if (countEl) countEl.textContent = `${mod.selected.size} of ${mod.libQuestions.length} selected`;
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
    const help = modEl.querySelector('[data-c-help]').value.trim();
    const placeholder = modEl.querySelector('[data-c-placeholder]').value.trim();
    const required = modEl.querySelector('[data-c-required]').checked;
    if (!label) { toast('Question text is required', 'err'); return; }
    if ((type === 'checkbox' || type === 'radio') && !optsRaw.trim()) {
      toast('Add options (comma separated)', 'err'); return;
    }
    const options = optsRaw.split(',').map(s => s.trim()).filter(Boolean);
    const q = { id: 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), custom: true, type, label, options, help, placeholder, required };
    mod.customs.push(q);
    renderEditorShell(state.editingId);
    toast('Custom question added ✓', 'ok');
    return;
  }

  // Edit custom question button
  const editBtn = e.target.closest('[data-edit-custom]');
  if (editBtn) {
    state.editingCustom = editBtn.dataset.editCustom;
    renderEditorShell(state.editingId);
    return;
  }
  const editCancelBtn = e.target.closest('[data-e-cancel]');
  if (editCancelBtn) {
    state.editingCustom = null;
    renderEditorShell(state.editingId);
    return;
  }
  const editSaveBtn = e.target.closest('[data-e-save]');
  if (editSaveBtn) {
    const qid = editSaveBtn.dataset.eSave;
    const q = mod.customs.find(cq => qid === cq.id);
    if (q) {
      const form = modEl.querySelector(`[data-edit-custom-form="${qid}"]`);
      const label = form.querySelector('[data-e-label]').value.trim();
      const type = form.querySelector('[data-e-type]').value;
      const optsRaw = form.querySelector('[data-e-options]').value;
      const help = form.querySelector('[data-e-help]').value.trim();
      const placeholder = form.querySelector('[data-e-placeholder]').value.trim();
      const required = form.querySelector('[data-e-required]').checked;
      if (!label) { toast('Question text is required', 'err'); return; }
      if ((type === 'checkbox' || type === 'radio') && !optsRaw.trim()) {
        toast('Add options (comma separated)', 'err'); return;
      }
      q.label = label;
      q.type = type;
      q.options = optsRaw.split(',').map(s => s.trim()).filter(Boolean);
      q.help = help;
      q.placeholder = placeholder;
      q.required = required;
    }
    state.editingCustom = null;
    renderEditorShell(state.editingId);
    toast('Custom question updated ✓', 'ok');
    return;
  }

  // Move custom question up/down
  const moveBtn = e.target.closest('[data-move-custom]');
  if (moveBtn) {
    const dir = moveBtn.dataset.moveCustom;
    const cid = moveBtn.dataset.cid;
    const idx = mod.customs.findIndex(cq => cq.id === cid);
    if (idx > -1) {
      if (dir === 'up' && idx > 0) {
        const temp = mod.customs[idx - 1];
        mod.customs[idx - 1] = mod.customs[idx];
        mod.customs[idx] = temp;
      } else if (dir === 'down' && idx < mod.customs.length - 1) {
        const temp = mod.customs[idx + 1];
        mod.customs[idx + 1] = mod.customs[idx];
        mod.customs[idx] = temp;
      }
      renderEditorShell(state.editingId);
    }
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
        ...m.customs.map(q => ({ id: q.id, type: q.type, label: q.label, options: q.options, help: q.help, placeholder: q.placeholder, required: q.required }))
      ]
    }))
  };

  try {
    invalidateProjects();
    if (state.editingId) {
      const { project } = await api(`/api/projects/${state.editingId}`, { method: 'PATCH', body: { ...meta, config } });
      state.editing = buildEditing(project);
      state.savedHash = snapshotEditing();
      toast('Project saved ✓', 'ok');
      if (location.hash !== `#/edit/${project.id}`) location.hash = `#/edit/${project.id}`;
      else paintEditor(String(project.id), project);
    } else {
      const { project } = await api('/api/projects', { method: 'POST', body: { ...meta, config } });
      state.editing = null;
      state.editingCustom = null;
      state.savedHash = null;
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
    if (err.status !== 401) {
      toast(err.message || 'Could not load project', 'err');
      if (location.hash !== '#/') location.hash = '#/';
      else renderDashboard();
    }
    return;
  }
  const shareUrl = absUrl(customerPath(project));
  const openUrl = previewPath(project);
  const enabled = (project.config?.modules || []).length;
  const totalQ = (project.config?.modules || []).reduce((n, m) => n + (m.questions || []).length, 0);

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
          <button class="btn btn-ghost" data-duplicate="${project.id}">📋 Clone</button>
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
            <input class="input mono" readonly value="${esc(shareUrl)}" onfocus="this.select()">
            <button class="btn btn-ghost btn-sm" data-copy="${esc(shareUrl)}">Copy</button>
          </div>
          <a class="btn btn-primary btn-sm" target="_blank" rel="noopener" href="${esc(openUrl)}">${project.status === 'live' ? 'Open →' : 'Preview →'}</a>
        </div>
      </div>
    </div>

    ${subs.length ? renderAnalyticsSummary(subs) : ''}

    <div style="display:flex;align-items:center;justify-content:space-between;margin:26px 0 14px">
      <h2 style="font-size:17px;margin:0">💌 Submissions <span style="color:var(--muted);font-weight:500">(${subs.length})</span></h2>
      ${subs.length ? `<button class="btn btn-ghost btn-sm" id="export-csv">📥 Export CSV</button>` : ''}
    </div>

    ${subs.length ? `
    <div class="submission-list" style="padding-top:0">
      ${subs.map((s, i) => subCard(s, i)).join('')}
    </div>` : `
    <div class="card empty">
      <div class="big">🕐</div>
      <h3>No answers yet</h3>
      <p>Send the customer link to your client and their answers will appear here.</p>
      <button class="btn btn-primary" data-copy="${esc(shareUrl)}">Copy customer link</button>
    </div>`}
  </div>`;

  // Attach CSV export
  $('#export-csv')?.addEventListener('click', () => exportSubmissionsCSV(project, subs));

  const del = $('#app').querySelector('[data-del-project]');
  if (del) del.onclick = async () => {
    if (!confirm(`Delete "${project.name}" and all ${subs.length} submission(s)?`)) return;
    try {
      await api(`/api/projects/${project.id}`, { method: 'DELETE' });
      invalidateProjects();
      location.hash = '#/';
      toast('Project deleted', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
}

function renderAnalyticsSummary(subs) {
  // Aggregate choice and rating answers across all submissions
  const counts = new Map(); // questionLabel -> Map(choice -> count)
  const ratings = new Map(); // questionLabel -> array of numbers

  for (const s of subs) {
    for (const a of (s.answers || [])) {
      if (a.type === 'checkbox' && Array.isArray(a.value)) {
        if (!counts.has(a.label)) counts.set(a.label, new Map());
        const m = counts.get(a.label);
        for (const v of a.value) m.set(v, (m.get(v) || 0) + 1);
      } else if (a.type === 'radio' && typeof a.value === 'string') {
        if (!counts.has(a.label)) counts.set(a.label, new Map());
        const m = counts.get(a.label);
        m.set(a.value, (m.get(a.value) || 0) + 1);
      } else if (a.type === 'rating') {
        if (!ratings.has(a.label)) ratings.set(a.label, []);
        ratings.get(a.label).push(Number(a.value));
      }
    }
  }

  if (counts.size === 0 && ratings.size === 0) return '';

  return `
  <div class="card editor-card" style="margin-top:20px;padding:20px">
    <h2 style="font-size:16px;margin-bottom:14px">📊 Response Breakdown</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(300px, 1fr));gap:16px">
      ${[...counts.entries()].map(([label, choiceMap]) => {
        const total = [...choiceMap.values()].reduce((a, b) => a + b, 0);
        return `
        <div style="background:#f8f9fe;border:1px solid var(--line);border-radius:12px;padding:14px">
          <div style="font-size:13px;font-weight:700;margin-bottom:10px">${esc(label)}</div>
          ${[...choiceMap.entries()].sort((a, b) => b[1] - a[1]).map(([choice, cnt]) => {
            const pct = Math.round((cnt / total) * 100);
            return `
            <div style="margin-bottom:8px">
              <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--ink);margin-bottom:3px">
                <span>${esc(choice)}</span>
                <span style="font-weight:600">${cnt} (${pct}%)</span>
              </div>
              <div class="progress-track" style="height:6px"><div class="progress-bar" style="width:${pct}%"></div></div>
            </div>`;
          }).join('')}
        </div>`;
      }).join('')}

      ${[...ratings.entries()].map(([label, vals]) => {
        const avg = (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
        return `
        <div style="background:#f8f9fe;border:1px solid var(--line);border-radius:12px;padding:14px">
          <div style="font-size:13px;font-weight:700;margin-bottom:8px">${esc(label)}</div>
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:28px;font-weight:800;color:var(--amber)">${avg}</span>
            <span style="font-size:13px;color:var(--muted)">out of 5 stars (${vals.length} rating${vals.length === 1 ? '' : 's'})</span>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function subCard(s, i) {
  const initials = s.customer_name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  const answered = s.answers.length;
  return `
  <div class="sub-card" data-sub="${s.id}">
    <div style="display:flex;align-items:center;background:#fff">
      <button class="sub-head" style="flex:1">
        <span class="sub-avatar">${esc(initials)}</span>
        <span>
          <span class="who">${esc(s.customer_name)} ${s.customer_email ? `<span style="color:var(--muted);font-weight:500">· ${esc(s.customer_email)}</span>` : ''}</span>
          <div class="when">${esc(dateStr(s.created_at))} · ${answered} answer${answered === 1 ? '' : 's'}</div>
        </span>
        <span class="chev">▾</span>
      </button>
      <div style="display:flex;gap:6px;padding-right:14px">
        <button class="btn btn-ghost btn-sm" data-copy-markdown="${s.id}" title="Copy submission as Markdown">📋 Markdown</button>
        <button class="btn btn-danger btn-sm" data-del-sub="${s.id}" title="Delete submission">🗑️</button>
      </div>
    </div>
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

// Delete individual submission & Copy Markdown
document.addEventListener('click', async e => {
  const delSubBtn = e.target.closest('[data-del-sub]');
  if (delSubBtn) {
    const subId = delSubBtn.dataset.delSub;
    const projId = currentProjectId();
    if (!projId) { toast('Could not tell which project this is — reload the page.', 'err'); return; }
    if (!confirm('Delete this submission?')) return;
    try {
      await api(`/api/projects/${projId}/submissions/${subId}`, { method: 'DELETE' });
      toast('Submission deleted ✓', 'ok');
      renderDetail(projId);
    } catch (err) { toast(err.message, 'err'); }
    return;
  }

  const copyMdBtn = e.target.closest('[data-copy-markdown]');
  if (copyMdBtn) {
    const subId = Number(copyMdBtn.dataset.copyMarkdown);
    const projId = currentProjectId();
    if (!projId) { toast('Could not tell which project this is — reload the page.', 'err'); return; }
    try {
      const subs = await api(`/api/projects/${projId}/submissions`).then(r => r.submissions);
      const sub = subs.find(s => s.id === subId);
      if (sub) {
        const md = getSubmissionMarkdown(sub);
        copyText(md, 'Submission copied as Markdown ✓');
      }
    } catch (err) { toast(err.message, 'err'); }
  }
});

function getSubmissionMarkdown(s) {
  let md = `# Submission from ${s.customer_name} (${s.customer_email || 'No email'})\n`;
  md += `*Submitted at: ${s.created_at}*\n\n`;
  for (const a of s.answers) {
    md += `### ${a.label}\n`;
    if (Array.isArray(a.value)) md += a.value.map(v => `- ${v}`).join('\n') + '\n\n';
    else md += `${a.value}\n\n`;
  }
  return md;
}

function exportSubmissionsCSV(project, subs) {
  if (!subs.length) return;
  // Collect all unique question labels
  const questionLabels = [];
  const labelSet = new Set();
  for (const s of subs) {
    for (const a of s.answers) {
      if (!labelSet.has(a.label)) {
        labelSet.add(a.label);
        questionLabels.push(a.label);
      }
    }
  }

  const headers = ['Submission ID', 'Customer Name', 'Customer Email', 'Submitted At', ...questionLabels];
  const rows = [headers];

  for (const s of subs) {
    const answerMap = new Map();
    for (const a of s.answers) {
      const val = Array.isArray(a.value) ? a.value.join('; ') : String(a.value ?? '');
      answerMap.set(a.label, val);
    }
    const row = [
      s.id,
      s.customer_name,
      s.customer_email,
      s.created_at,
      ...questionLabels.map(l => answerMap.get(l) || '')
    ];
    rows.push(row);
  }

  const csvContent = rows.map(r => r.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `submissions-${project.slug || 'project'}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  toast('Exported CSV ✓', 'ok');
}

/* ---------------- go ---------------- */
boot();
