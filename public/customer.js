/* ReqForge customer questionnaire — auto-built from the admin's selection */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const slug = location.pathname.split('/').filter(Boolean)[1] || '';
const DRAFT_KEY = `rf_draft_${slug}`;

const state = {
  data: null,          // { project, modules }
  answers: new Map(),  // questionId -> value (string | string[] | number)
  missing: new Set()
};

async function load() {
  const app = $('#app');
  try {
    const res = await fetch(`/api/public/${encodeURIComponent(slug)}`);
    if (res.status === 410) { renderClosed(await res.json()); return; }
    if (!res.ok) throw new Error('not found');
    state.data = await res.json();
    render();
  } catch {
    app.innerHTML = `
      <div class="closed-box card">
        <div class="big">🔍</div>
        <h1>Questionnaire not found</h1>
        <p>This link isn't valid — check with the person who sent it to you.</p>
      </div>`;
  }
}

function renderClosed(body) {
  $('#app').innerHTML = `
    <div class="closed-box card fade-in">
      <div class="big">🔒</div>
      <h1>${body?.project?.name ? `"${esc(body.project.name)}"` : 'This questionnaire'} is closed</h1>
      <p>${esc(body?.project?.closing || 'Thank you for your interest — this questionnaire is no longer accepting answers.')}</p>
    </div>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render() {
  const { project, modules } = state.data;
  const sectionCount = modules.length + 1; // +1 for "about you"

  $('#app').innerHTML = `
  <header class="cust-header">
    <div class="logo">✓</div>
    <h1>${esc(project.name)}</h1>
    ${project.tagline ? `<p class="tagline">${esc(project.tagline)}</p>` : ''}
    ${project.welcome ? `<div class="welcome">${esc(project.welcome)}</div>` : ''}
  </header>

  <div class="cust-progress"><div class="wrap">
    <div class="plabel"><span>Your progress</span><span data-pct>0%</span></div>
    <div class="progress-track"><div class="progress-bar" data-bar style="width:0%"></div></div>
  </div></div>

  <form class="form-shell">
    <div class="card section-card">
      <div class="sec-head">
        <span class="sec-icon">👤</span>
        <div><div class="sec-num">About you</div><h2>Who are we building this for?</h2></div>
      </div>
      <div style="margin-top:16px">
        <div class="field">
          <label for="cust-name">Your name *</label>
          <input class="input" id="cust-name" placeholder="e.g. Emma Carter" required>
        </div>
        <div class="field">
          <label for="cust-email">Email address *</label>
          <input class="input" id="cust-email" type="email" placeholder="you@company.com" required>
        </div>
      </div>
    </div>

    ${modules.map((m, i) => `
      <div class="card section-card" data-section="${m.id}">
        <div class="sec-head">
          <span class="sec-icon">${m.icon}</span>
          <div><div class="sec-num">Part ${i + 1} of ${sectionCount - 1}</div><h2>${esc(m.title)}</h2></div>
        </div>
        <p class="sec-blurb">${esc(m.blurb)}</p>
        ${m.questions.map(q => questionHTML(q)).join('')}
      </div>`).join('')}

    <div class="submit-area">
      <button class="btn btn-primary" type="submit">Submit my answers →</button>
      <div class="required-note">Fields marked <span style="color:var(--red)">*</span> are required · ticking or typing is enough, there are no wrong answers.</div>
    </div>
  </form>`;

  bindQuestionListeners();

  // Name & email input listeners (for progress & draft saving)
  $('#cust-name')?.addEventListener('input', () => { saveDraft(); updateProgress(); });
  $('#cust-email')?.addEventListener('input', () => { saveDraft(); updateProgress(); });

  // Don't let Enter in a single-line text field submit the whole questionnaire
  $('.form-shell').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'submit') {
      e.preventDefault();
    }
  });
  $('.form-shell').addEventListener('submit', submitForm);

  const restored = restoreDraft();
  if (restored) showDraftBanner();
  updateProgress();
}

function questionHTML(q) {
  const req = q.required ? ' <span class="req">*</span>' : '';
  let input = '';
  if (q.type === 'text') {
    input = `<input class="input qinput" data-q="${q.id}" type="text" placeholder="${esc(q.placeholder || '')}">`;
  } else if (q.type === 'textarea') {
    input = `<textarea class="textarea qinput" data-q="${q.id}" placeholder="${esc(q.placeholder || '')}"></textarea>`;
  } else if (q.type === 'checkbox') {
    input = `<div class="chip-grid qinput">${q.options.map(o =>
      `<label class="chip" data-q="${q.id}" tabindex="0" role="checkbox" aria-checked="false"><span class="tick">✓</span><span class="lbl">${esc(o)}</span></label>`).join('')}</div>`;
  } else if (q.type === 'radio') {
    input = `<div class="chip-grid qinput">${q.options.map(o =>
      `<label class="chip single" data-q="${q.id}" tabindex="0" role="radio" aria-checked="false"><span class="tick">✓</span><span class="lbl">${esc(o)}</span></label>`).join('')}</div>`;
  } else if (q.type === 'rating') {
    input = `<div class="stars qinput" data-rating="${q.id}">
      ${[1, 2, 3, 4, 5].map(n => `<button type="button" class="star-btn" data-r="${n}" aria-label="${n} stars">★</button>`).join('')}
    </div>`;
  }
  return `
  <div class="q" data-qwrap="${q.id}">
    <div class="qlabel">${esc(q.label)}${req}</div>
    ${q.help ? `<div class="qhelp">${esc(q.help)}</div>` : ''}
    ${input}
  </div>`;
}

function bindQuestionListeners() {
  // chips
  $$('.chip').forEach(chip => {
    const handleToggle = () => {
      const qid = chip.dataset.q;
      const val = () => $('.lbl', chip).textContent.trim();
      const single = chip.classList.contains('single');
      if (single) {
        $$(`.chip[data-q="${qid}"]`).forEach(c => {
          c.classList.remove('on');
          c.setAttribute('aria-checked', 'false');
        });
        chip.classList.add('on');
        chip.setAttribute('aria-checked', 'true');
        state.answers.set(qid, val());
      } else {
        const isNowOn = chip.classList.toggle('on');
        chip.setAttribute('aria-checked', isNowOn ? 'true' : 'false');
        const vals = $$(`.chip[data-q="${qid}"].on`).map(c => $('.lbl', c).textContent.trim());
        vals.length ? state.answers.set(qid, vals) : state.answers.delete(qid);
      }
      clearMissing(qid);
      saveDraft();
      updateProgress();
    };

    chip.addEventListener('click', handleToggle);
    chip.addEventListener('keydown', e => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        handleToggle();
      }
    });
  });

  // text/textarea
  $$('[data-q]').forEach(el => {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.addEventListener('input', () => {
        const v = el.value.trim();
        v ? state.answers.set(el.dataset.q, v) : state.answers.delete(el.dataset.q);
        clearMissing(el.dataset.q);
        saveDraft();
        updateProgress();
      });
    }
  });

  // rating
  $$('[data-rating]').forEach(wrap => {
    const qid = wrap.dataset.rating;
    const buttons = $$('.star-btn', wrap);
    const set = n => {
      state.answers.set(qid, n);
      buttons.forEach((b, i) => b.classList.toggle('on', i < n));
      clearMissing(qid);
      saveDraft();
      updateProgress();
    };
    buttons.forEach((b, i) => b.addEventListener('click', () => set(i + 1)));
    wrap.addEventListener('mouseover', e => {
      const n = Number(e.target.dataset.r) || 0;
      buttons.forEach((b, i) => b.classList.toggle('on', i < n));
    });
    wrap.addEventListener('mouseleave', () => {
      const n = Number(state.answers.get(qid)) || 0;
      buttons.forEach((b, i) => b.classList.toggle('on', i < n));
    });
  });
}

function clearMissing(qid) {
  if (!state.missing.delete(qid)) return;
  const wrap = $(`[data-qwrap="${qid}"]`);
  if (wrap) wrap.classList.remove('missing');
}

function updateProgress() {
  const total = totalQuestions();
  const done = totalQuestions(true);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const bar = $('[data-bar]');
  const label = $('[data-pct]');
  if (bar) bar.style.width = pct + '%';
  if (label) label.textContent = pct + '%';
}

function totalQuestions(answeredOnly = false) {
  let n = 0;
  for (const m of state.data.modules) {
    for (const q of m.questions) {
      if (answeredOnly && !isAnswered(q.id)) continue;
      n++;
    }
  }
  return n;
}

function isAnswered(id) {
  const v = state.answers.get(id);
  return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
}

function saveDraft() {
  try {
    const name = $('#cust-name')?.value || '';
    const email = $('#cust-email')?.value || '';
    const answersObj = Object.fromEntries(state.answers.entries());
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ name, email, answers: answersObj }));
  } catch { /* ignore quota errors */ }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

function restoreDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return false;
    const { name, email, answers } = JSON.parse(raw);
    let restoredAny = false;

    if (name && $('#cust-name')) { $('#cust-name').value = name; restoredAny = true; }
    if (email && $('#cust-email')) { $('#cust-email').value = email; restoredAny = true; }

    if (answers && typeof answers === 'object') {
      for (const [qid, val] of Object.entries(answers)) {
        if (val !== undefined && val !== null && val !== '') {
          state.answers.set(qid, val);
          restoredAny = true;

          const input = $(`[data-q="${qid}"]`);
          if (input && (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA')) {
            input.value = val;
          }

          if (Array.isArray(val)) {
            $$(`.chip[data-q="${qid}"]`).forEach(chip => {
              const text = $('.lbl', chip)?.textContent.trim();
              if (val.includes(text)) {
                chip.classList.add('on');
                chip.setAttribute('aria-checked', 'true');
              }
            });
          } else if (typeof val === 'string') {
            $$(`.chip[data-q="${qid}"]`).forEach(chip => {
              const text = $('.lbl', chip)?.textContent.trim();
              if (text === val) {
                chip.classList.add('on');
                chip.setAttribute('aria-checked', 'true');
              }
            });
          } else if (typeof val === 'number') {
            const wrap = $(`[data-rating="${qid}"]`);
            if (wrap) {
              $$('.star-btn', wrap).forEach((b, i) => b.classList.toggle('on', i < val));
            }
          }
        }
      }
    }
    return restoredAny;
  } catch { return false; }
}

function showDraftBanner() {
  const form = $('.form-shell');
  if (!form || $('.draft-banner')) return;
  const banner = document.createElement('div');
  banner.className = 'draft-banner card';
  banner.style.cssText = 'padding:10px 16px;background:var(--grad-soft);border-color:rgba(99,102,241,.3);display:flex;align-items:center;justify-content:space-between;font-size:13px;color:var(--accent);margin-bottom:16px;border-radius:12px;';
  banner.innerHTML = `<span>⚡ Restored your draft answers</span><button type="button" class="btn btn-ghost btn-sm" style="padding:4px 10px;font-size:12px">Clear draft</button>`;
  banner.querySelector('button').onclick = () => {
    clearDraft();
    state.answers.clear();
    location.reload();
  };
  form.prepend(banner);
}

async function submitForm(e) {
  e.preventDefault();
  const name = $('#cust-name').value.trim();
  const email = $('#cust-email').value.trim();

  // client-side required check
  state.missing.clear();
  for (const m of state.data.modules) {
    for (const q of m.questions) {
      if (q.required && !isAnswered(q.id)) {
        state.missing.add(q.id);
        const wrap = $(`[data-qwrap="${q.id}"]`);
        if (wrap) wrap.classList.add('missing');
      }
    }
  }
  if (!name || !email || state.missing.size) {
    if (!name) $('#cust-name').focus();
    else if (!email) $('#cust-email').focus();

    const bar = $('.submit-area');
    const old = bar.querySelector('.err-note');
    if (old) old.remove();
    const note = document.createElement('div');
    note.className = 'required-note err-note';
    note.style.color = 'var(--red)';
    note.style.fontWeight = '600';
    note.textContent = state.missing.size ? 'Please complete the highlighted questions.' : 'Please add your name and email.';
    bar.prepend(note);

    const firstTarget = !name ? $('#cust-name') : !email ? $('#cust-email') : $('.q.missing');
    if (firstTarget) {
      firstTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return;
  }

  const answers = [];
  for (const m of state.data.modules) {
    for (const q of m.questions) {
      if (!isAnswered(q.id)) continue;
      answers.push({ id: q.id, label: q.label, type: q.type, value: state.answers.get(q.id) });
    }
  }

  const btn = $('.submit-area .btn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';

  try {
    const res = await fetch(`/api/public/${encodeURIComponent(slug)}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_name: name, customer_email: email, answers })
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Submission failed');
    clearDraft();
    renderThanks(body.closing);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Submit my answers →';
    const bar = $('.submit-area');
    const note = document.createElement('div');
    note.className = 'required-note err-note';
    note.style.color = 'var(--red)';
    note.style.fontWeight = '600';
    note.textContent = err.message;
    bar.prepend(note);
  }
};

function renderThanks(closing) {
  $('#app').innerHTML = `
  <div class="thanks fade-in">
    <div class="check">✓</div>
    <h1>Thank you — you're all set!</h1>
    <p>${esc(closing || 'Your answers have been received. We\u2019ll be in touch soon.')}</p>
  </div>`;
  document.querySelector('.cust-progress')?.remove();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

load();
