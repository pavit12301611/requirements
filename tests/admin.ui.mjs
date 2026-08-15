// Full admin UI suite — every interactive function, driven through the real
// rendered DOM against a real Express server and a real SQLite database.
//
// Each spec clicks what a user clicks and then verifies the result BOTH in the
// UI and in the database, so a handler that updates the screen without
// persisting (or persists without redrawing) fails here.
import {
  startBackend, openAdmin, click, type, waitFor, sleep,
  byText, containingText, cardNamed, toastState
} from './helpers/browser.mjs';

const backend = await startBackend('adminui');
const { base, api } = backend;

let failures = 0;
let currentSpec = '';
const check = (name, cond, extra = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (cond ? '' : '  ' + extra));
  if (!cond) failures++;
};

// Signed-in cookie for fixtures.
const cookie = (await api('/api/login', {
  method: 'POST', body: { username: 'pavit', password: '5161211' }
})).token;

const seed = (name, extra = {}) => api('/api/projects', {
  method: 'POST', cookie,
  body: {
    name, status: 'live',
    config: { modules: [{ id: 'basics', questions: ['basics.name', 'basics.one_liner'] }] },
    ...extra
  }
}).then(r => r.json.project);

// Removes every project so each spec starts from a known state.
async function resetProjects() {
  const { json } = await api('/api/projects', { cookie });
  for (const p of json.projects) await api(`/api/projects/${p.id}`, { method: 'DELETE', cookie });
}

// Boots the SPA already signed in and waits for the first paint.
async function openDashboard(path = '/') {
  const ui = openAdmin(base, { path, cookie });
  await waitFor(() => ui.document.querySelector('.project-card, .empty, #dash-search'));
  return ui;
}

async function spec(title, fn) {
  currentSpec = title;
  console.log(`\n— ${title} —`);
  try { await fn(); }
  catch (err) { check(`${title} (unexpected error)`, false, err.message); }
}

// ===================================================================== LOGIN
await spec('sign in / sign out', async () => {
  const ui = openAdmin(base, { path: '/' });            // signed OUT
  const form = await waitFor(() => ui.document.querySelector('.login-card'));
  check('signed-out visitor gets the login form', !!form);

  // wrong password
  type(ui.window, ui.document.querySelector('input[name="username"]'), 'pavit');
  type(ui.window, ui.document.querySelector('input[name="password"]'), 'wrong-one');
  click(ui.window, ui.document.querySelector('button[type="submit"]'));
  const err = await waitFor(() => toastState(ui.document).kind.includes('err'));
  check('wrong password shows an error and stays on the form', !!err && !!ui.document.querySelector('.login-card'),
    toastState(ui.document).text);

  // right password
  type(ui.window, ui.document.querySelector('input[name="password"]'), '5161211');
  click(ui.window, ui.document.querySelector('button[type="submit"]'));
  const dash = await waitFor(() => ui.document.querySelector('#dash-search, .empty'));
  check('correct password signs in and shows the dashboard', !!dash);
  check('a session cookie was issued', Boolean(ui.cookie));

  // log out
  click(ui.window, byText(ui.document, 'button', 'Log out'));
  await waitFor(() => ui.document.querySelector('.login-card') && !ui.cookie);
  check('Log out returns to the login form', !!ui.document.querySelector('.login-card'));
  check('the session cookie was cleared', !ui.cookie);
  // Regression: the dashboard fetch still in flight when logout fired used to
  // resolve a moment later and repaint the project list over the login screen.
  await sleep(400);
  check('a late-resolving request does not repaint over the login screen',
    !!ui.document.querySelector('.login-card') && !ui.document.querySelector('.project-card'),
    ui.document.querySelector('#app')?.textContent.trim().slice(0, 60));
});

// ================================================================ NEW PROJECT
await spec('create a project (+ New project → Save)', async () => {
  await resetProjects();
  const ui = await openDashboard();

  click(ui.window, byText(ui.document, 'a', '+ New project'));
  await waitFor(() => ui.document.querySelector('[data-save]'));

  // Saving with no name must be refused.
  click(ui.window, ui.document.querySelector('[data-save]'));
  await waitFor(() => toastState(ui.document).kind.includes('err'));
  check('Save without a name is rejected', toastState(ui.document).text.includes('name'),
    toastState(ui.document).text);
  check('nothing was written to the database',
    (await api('/api/projects', { cookie })).json.projects.length === 0);

  // Fill the form in and save.
  type(ui.window, ui.document.querySelector('[data-meta="name"]'), 'Nova Bakery');
  type(ui.window, ui.document.querySelector('[data-meta="tagline"]'), 'A crisp new site');
  type(ui.window, ui.document.querySelector('[data-meta="welcome"]'), 'Hi there!');
  type(ui.window, ui.document.querySelector('[data-meta="closing"]'), 'Thanks a lot!');
  type(ui.window, ui.document.querySelector('[data-meta="status"]'), 'live');
  click(ui.window, ui.document.querySelector('[data-save]'));

  const saved = await waitFor(async () => {
    const { json } = await api('/api/projects', { cookie });
    return json.projects.find(p => p.name === 'Nova Bakery');
  });
  check('the project is persisted', !!saved);
  check('every field the user typed was saved',
    saved?.tagline === 'A crisp new site' && saved?.welcome === 'Hi there!' &&
    saved?.closing === 'Thanks a lot!' && saved?.status === 'live',
    JSON.stringify({ t: saved?.tagline, w: saved?.welcome, c: saved?.closing, s: saved?.status }));
  check('a customer slug was generated', saved?.slug === 'nova-bakery', saved?.slug);
});

// ============================================================ MODULE TOGGLES
await spec('question bank: module and question switches', async () => {
  await resetProjects();
  const project = await seed('Toggle Test');
  const ui = await openDashboard(`/edit/${project.id}`);
  await waitFor(() => ui.document.querySelector('[data-module="budget"]'));

  // Turn a whole module on via its switch.
  click(ui.window, ui.document.querySelector('[data-module="budget"] .module-head .switch .track'));
  await waitFor(() => ui.document.querySelector('[data-module="budget"] .module-body'));
  check('module switch reveals the module body',
    !!ui.document.querySelector('[data-module="budget"] .module-body'));

  // Select All / Deselect All.
  click(ui.window, ui.document.querySelector('[data-module="budget"] [data-select-all]'));
  await waitFor(() => ui.window.__state.editing.modules.find(m => m.id === 'budget').selected.size > 0);
  const all = ui.window.__state.editing.modules.find(m => m.id === 'budget');
  check('Select All ticks every question in the module', all.selected.size === all.libQuestions.length,
    `${all.selected.size}/${all.libQuestions.length}`);

  click(ui.window, ui.document.querySelector('[data-module="budget"] [data-deselect-all]'));
  await waitFor(() => ui.window.__state.editing.modules.find(m => m.id === 'budget').selected.size === 0);
  check('Deselect All clears them',
    ui.window.__state.editing.modules.find(m => m.id === 'budget').selected.size === 0);

  // Tick one question by hand, then save and confirm it reached the database.
  // Deselect All re-renders asynchronously (renderEditorShell re-fetches the
  // project), so wait for the redrawn, unticked switch before clicking it —
  // otherwise the click lands on a node that is about to be replaced.
  await waitFor(() => {
    const box = ui.document.querySelector('[data-module="budget"] [data-q="budget.budget"] [data-q-on]');
    return box && !box.checked ? box : null;
  });
  click(ui.window, ui.document.querySelector('[data-module="budget"] [data-q="budget.budget"] .switch .track'));
  await waitFor(() => ui.window.__state.editing.modules.find(m => m.id === 'budget').selected.has('budget.budget'));
  click(ui.window, ui.document.querySelector('[data-save]'));
  await waitFor(() => toastState(ui.document).text.includes('saved'));

  const stored = await waitFor(async () => {
    const { json } = await api(`/api/projects/${project.id}`, { cookie });
    const mod = json.project.config.modules.find(m => m.id === 'budget');
    return mod?.questions.includes('budget.budget') ? mod : null;
  });
  check('the ticked question is persisted', !!stored, JSON.stringify(stored));

  // The customer questionnaire must now serve it.
  const pub = await api(`/api/public/${project.slug}`);
  check('the customer page serves the selected question',
    pub.json.modules.some(m => m.questions.some(q => q.id === 'budget.budget')));
});

// =========================================================== CUSTOM QUESTIONS
await spec('custom questions: add, edit, reorder, delete', async () => {
  await resetProjects();
  const project = await seed('Custom Q Test');
  const ui = await openDashboard(`/edit/${project.id}`);
  await waitFor(() => ui.document.querySelector('[data-module="basics"] [data-add-question]'));
  const mod = () => ui.document.querySelector('[data-module="basics"]');

  // --- add #1 (a radio, so options matter)
  click(ui.window, mod().querySelector('[data-add-question]'));
  await waitFor(() => !mod().querySelector('[data-custom-editor]').classList.contains('hidden'));

  click(ui.window, mod().querySelector('[data-c-add]'));          // empty label
  await waitFor(() => toastState(ui.document).kind.includes('err'));
  check('a custom question with no text is refused', toastState(ui.document).text.includes('required'),
    toastState(ui.document).text);

  type(ui.window, mod().querySelector('[data-c-label]'), 'Which plan?');
  type(ui.window, mod().querySelector('[data-c-type]'), 'radio');
  click(ui.window, mod().querySelector('[data-c-add]'));          // radio, no options
  await waitFor(() => toastState(ui.document).text.includes('options'));
  check('a choice question with no options is refused', toastState(ui.document).text.includes('options'),
    toastState(ui.document).text);

  type(ui.window, mod().querySelector('[data-c-options]'), 'Basic, Pro, Enterprise');
  click(ui.window, mod().querySelector('[data-c-required]'));     // mark required
  click(ui.window, mod().querySelector('[data-c-add]'));
  await waitFor(() => mod().querySelectorAll('.q-row.custom').length === 1);
  const added = ui.window.__state.editing.modules.find(m => m.id === 'basics').customs[0];
  check('the custom question is added with its options',
    added.label === 'Which plan?' && added.type === 'radio' && added.options.length === 3 && added.required === true,
    JSON.stringify(added));

  // --- add #2, so ordering can be exercised
  click(ui.window, mod().querySelector('[data-add-question]'));
  await waitFor(() => !mod().querySelector('[data-custom-editor]').classList.contains('hidden'));
  type(ui.window, mod().querySelector('[data-c-label]'), 'Any deadline?');
  click(ui.window, mod().querySelector('[data-c-add]'));
  await waitFor(() => mod().querySelectorAll('.q-row.custom').length === 2);
  check('a second custom question is added',
    ui.window.__state.editing.modules.find(m => m.id === 'basics').customs.length === 2);

  // --- reorder: move the second one up
  await waitFor(() => mod().querySelector('[data-move-custom="up"]'));
  click(ui.window, mod().querySelector('[data-move-custom="up"]'));
  await waitFor(() => ui.window.__state.editing.modules.find(m => m.id === 'basics').customs[0].label === 'Any deadline?');
  check('▲ moves a custom question up',
    ui.window.__state.editing.modules.find(m => m.id === 'basics').customs[0].label === 'Any deadline?');

  // --- edit "Any deadline?" (now first) and rename it
  const customs = () => ui.window.__state.editing.modules.find(m => m.id === 'basics').customs;
  const deadlineId = customs()[0].id;
  await waitFor(() => mod().querySelector(`[data-edit-custom="${deadlineId}"]`));
  click(ui.window, mod().querySelector(`[data-edit-custom="${deadlineId}"]`));
  const form = await waitFor(() => mod().querySelector(`[data-edit-custom-form="${deadlineId}"]`));
  check('the edit form opens', !!form);
  type(ui.window, form.querySelector('[data-e-label]'), 'When do you need it?');
  click(ui.window, form.querySelector('[data-e-save]'));
  await waitFor(() => customs().find(q => q.id === deadlineId)?.label === 'When do you need it?');
  check('the edit is applied', customs().find(q => q.id === deadlineId)?.label === 'When do you need it?');

  // --- save, and confirm the customer page serves both
  click(ui.window, ui.document.querySelector('[data-save]'));
  await waitFor(() => toastState(ui.document).text.includes('saved'));
  const pub = await waitFor(async () => {
    const r = await api(`/api/public/${project.slug}`);
    const qs = r.json.modules?.flatMap(m => m.questions) || [];
    return qs.some(q => q.label === 'When do you need it?') ? qs : null;
  });
  check('custom questions reach the customer questionnaire', !!pub);
  check('the radio keeps its options and required flag',
    pub?.some(q => q.label === 'Which plan?' && q.options.length === 3 && q.required === true),
    JSON.stringify(pub?.find(q => q.label === 'Which plan?')));

  // --- delete the renamed one
  await waitFor(() => mod().querySelector(`[data-del-custom="${deadlineId}"]`));
  click(ui.window, mod().querySelector(`[data-del-custom="${deadlineId}"]`));
  await waitFor(() => mod().querySelectorAll('.q-row.custom').length === 1);
  check('✕ removes a custom question', customs().length === 1);

  click(ui.window, ui.document.querySelector('[data-save]'));
  await waitFor(() => toastState(ui.document).text.includes('saved'));
  const after = await waitFor(async () => {
    const r = await api(`/api/public/${project.slug}`);
    const qs = r.json.modules?.flatMap(m => m.questions) || [];
    return qs.length && qs.every(q => q.label !== 'When do you need it?') ? qs : null;
  });
  check('the deletion is persisted', !!after);
});

// ================================================================ EDITOR MISC
await spec('editor: question search and the unsaved-changes guard', async () => {
  await resetProjects();
  const project = await seed('Search Test');
  const ui = await openDashboard(`/edit/${project.id}`);
  await waitFor(() => ui.document.querySelector('#q-search'));

  type(ui.window, ui.document.querySelector('#q-search'), 'budget');
  await waitFor(() => ui.document.querySelectorAll('.module-card').length === 1);
  const cards = ui.document.querySelectorAll('.module-card');
  check('searching narrows the question bank', cards.length === 1, 'count=' + cards.length);
  check('the matching module is the one shown',
    cards[0]?.getAttribute('data-module') === 'budget', cards[0]?.getAttribute('data-module'));
  check('the search box keeps focus while typing',
    ui.document.activeElement === ui.document.querySelector('#q-search'));

  type(ui.window, ui.document.querySelector('#q-search'), '');
  await waitFor(() => ui.document.querySelectorAll('.module-card').length > 1);
  check('clearing the search restores every module',
    ui.document.querySelectorAll('.module-card').length > 1);

  // Dirty-state guard: make a change, then try to navigate away and refuse.
  click(ui.window, ui.document.querySelector('[data-module="design"] .module-head .switch .track'));
  await waitFor(() => ui.window.__state.editing.modules.find(m => m.id === 'design').on);
  ui.window.confirm = () => false;                    // user clicks "stay"
  ui.window.location.hash = '#/';
  await waitFor(() => ui.document.querySelector('[data-save]'), { timeout: 600 });
  check('leaving with unsaved changes asks first and can be cancelled',
    !!ui.document.querySelector('[data-save]'));
});

// =================================================================== DASHBOARD
await spec('dashboard: search, status filter, reset', async () => {
  await resetProjects();
  await seed('Alpha Site', { status: 'live' });
  await seed('Beta Site', { status: 'draft' });
  await seed('Gamma Shop', { status: 'closed' });
  const ui = await openDashboard();
  await waitFor(() => ui.document.querySelectorAll('.project-card').length === 3);
  check('every project is listed', ui.document.querySelectorAll('.project-card').length === 3);

  type(ui.window, ui.document.querySelector('#dash-search'), 'Beta');
  await waitFor(() => ui.document.querySelectorAll('.project-card').length === 1);
  check('search filters by name', !!cardNamed(ui.document, 'Beta Site'));
  check('the search box keeps focus',
    ui.document.activeElement === ui.document.querySelector('#dash-search'));

  type(ui.window, ui.document.querySelector('#dash-search'), '');
  await waitFor(() => ui.document.querySelectorAll('.project-card').length === 3);

  type(ui.window, ui.document.querySelector('#dash-status'), 'closed');
  await waitFor(() => ui.document.querySelectorAll('.project-card').length === 1);
  check('the status filter works', !!cardNamed(ui.document, 'Gamma Shop'));

  // A filter that matches nothing offers a reset.
  type(ui.window, ui.document.querySelector('#dash-search'), 'zzzz');
  await waitFor(() => ui.document.querySelector('#reset-filters'));
  check('an empty result offers "Reset filters"', !!ui.document.querySelector('#reset-filters'));
  click(ui.window, ui.document.querySelector('#reset-filters'));
  await waitFor(() => ui.document.querySelectorAll('.project-card').length === 3);
  check('Reset filters restores the full list',
    ui.document.querySelectorAll('.project-card').length === 3);
});

// ======================================================= CLONE / EDIT / DELETE
await spec('project card: Clone, Edit questions, Delete', async () => {
  await resetProjects();
  const project = await seed('Clone Me');
  const ui = await openDashboard();
  await waitFor(() => cardNamed(ui.document, 'Clone Me'));

  // --- Clone
  click(ui.window, cardNamed(ui.document, 'Clone Me').querySelector('[data-duplicate]'));
  const copy = await waitFor(async () => {
    const { json } = await api('/api/projects', { cookie });
    return json.projects.find(p => p.name === 'Copy of Clone Me');
  });
  check('Clone creates a copy in the database', !!copy);
  check('the copy starts as a draft', copy?.status === 'draft', copy?.status);
  check('the copy keeps the questions', JSON.stringify(copy?.config) === JSON.stringify(project.config));

  // --- Edit questions
  const ui2 = await openDashboard();
  await waitFor(() => cardNamed(ui2.document, 'Clone Me'));
  click(ui2.window, byText(cardNamed(ui2.document, 'Clone Me'), 'a', 'Edit questions'));
  await waitFor(() => ui2.document.querySelector('[data-save]'));
  check('"Edit questions" opens the editor for that project',
    ui2.document.querySelector('[data-meta="name"]')?.value === 'Clone Me',
    ui2.document.querySelector('[data-meta="name"]')?.value);

  // --- Delete (from the detail page)
  const ui3 = await openDashboard(`/project/${project.id}`);
  await waitFor(() => ui3.document.querySelector('[data-del-project]'));
  click(ui3.window, ui3.document.querySelector('[data-del-project]'));
  const gone = await waitFor(async () => {
    const { json } = await api('/api/projects', { cookie });
    return json.projects.every(p => p.id !== project.id);
  });
  check('Delete removes the project from the database', !!gone);
  await waitFor(() => !ui3.document.querySelector('[data-del-project]'));
  check('Delete leaves the detail page', !ui3.document.querySelector('[data-del-project]'));
  check('Delete does not show an error toast', !toastState(ui3.document).kind.includes('err'),
    toastState(ui3.document).text);
});

// ================================================================ SHARE LINKS
await spec('copy buttons and the customer link', async () => {
  await resetProjects();
  const project = await seed('Link Test');
  const ui = await openDashboard(`/project/${project.id}`);
  await waitFor(() => ui.document.querySelector('[data-copy]'));

  click(ui.window, ui.document.querySelector('[data-copy]'));
  await waitFor(() => ui.copied.length > 0);
  check('Copy puts the customer link on the clipboard',
    ui.copied[0]?.includes(`/c/${project.slug}`), ui.copied[0]);
  check('a confirmation toast is shown', toastState(ui.document).text.toLowerCase().includes('copied'),
    toastState(ui.document).text);

  const openLink = containingText(ui.document, 'a', 'Open →') || containingText(ui.document, 'a', 'Preview →');
  check('the page offers a link to the live questionnaire', !!openLink);
  const href = openLink?.getAttribute('href') || '';
  check('that link points at this project\'s customer page', href.includes(`/c/${project.slug}`), href);

  // The link must actually serve the questionnaire.
  const res = await fetch(new URL(href, base).href);
  check('following the link returns the customer page', res.status === 200, 'status=' + res.status);
});

// ================================================================ SUBMISSIONS
await spec('submissions: expand, copy markdown, delete, CSV export', async () => {
  await resetProjects();
  const project = await seed('Answers Inc');
  await api(`/api/public/${project.slug}/submit`, {
    method: 'POST',
    body: {
      customer_name: 'Emma Carter', customer_email: 'emma@x.com',
      answers: [
        { id: 'basics.name', value: 'Emma Ltd' },
        { id: 'basics.one_liner', value: 'We sell flowers' }
      ]
    }
  });
  await api(`/api/public/${project.slug}/submit`, {
    method: 'POST',
    body: {
      customer_name: 'Raj Patel', customer_email: 'raj@y.com',
      answers: [
        { id: 'basics.name', value: 'Patel Co' },
        { id: 'basics.one_liner', value: 'We build things' }
      ]
    }
  });

  const ui = await openDashboard(`/project/${project.id}`);
  await waitFor(() => ui.document.querySelectorAll('.sub-card').length === 2);
  check('both submissions are listed', ui.document.querySelectorAll('.sub-card').length === 2);
  check('the answers are rendered',
    ui.document.body.textContent.includes('Emma Ltd') && ui.document.body.textContent.includes('Patel Co'));

  // expand
  click(ui.window, ui.document.querySelector('.sub-card .sub-head'));
  await waitFor(() => ui.document.querySelector('.sub-card').classList.contains('open'));
  check('clicking a submission expands it', ui.document.querySelector('.sub-card').classList.contains('open'));

  // copy as markdown
  click(ui.window, ui.document.querySelector('[data-copy-markdown]'));
  await waitFor(() => ui.copied.length > 0);
  const md = ui.copied[ui.copied.length - 1] || '';
  check('Copy Markdown copies that submission', md.includes('Emma Carter') || md.includes('Raj Patel'), md.slice(0, 80));
  check('the markdown contains the answers', md.includes('Emma Ltd') || md.includes('Patel Co'), md.slice(0, 120));

  // CSV export
  click(ui.window, ui.document.querySelector('#export-csv'));
  await waitFor(() => ui.downloads.length > 0);
  const csv = await ui.lastDownloadText();
  check('Export CSV produces a file', !!csv);
  check('the CSV holds both customers',
    csv?.includes('Emma Carter') && csv?.includes('Raj Patel'), (csv || '').slice(0, 120));
  check('the CSV has a header row', csv?.split('\n')[0].includes('Customer Name'), (csv || '').split('\n')[0]);

  // delete one
  click(ui.window, ui.document.querySelector('[data-del-sub]'));
  const left = await waitFor(async () => {
    const { json } = await api(`/api/projects/${project.id}/submissions`, { cookie });
    return json.submissions.length === 1 ? json.submissions : null;
  });
  check('deleting a submission removes it from the database', !!left);
  await waitFor(() => ui.document.querySelectorAll('.sub-card').length === 1);
  check('the list refreshes after the delete', ui.document.querySelectorAll('.sub-card').length === 1);
});

// =================================================================== ANALYTICS
await spec('response breakdown', async () => {
  await resetProjects();
  const project = await seed('Stats Co', {
    config: { modules: [{ id: 'basics', questions: ['basics.name', 'basics.one_liner', 'basics.purpose'] }] }
  });
  for (const choice of [['Sell products or services'], ['Sell products or services'], ['Generate leads / enquiries']]) {
    await api(`/api/public/${project.slug}/submit`, {
      method: 'POST',
      body: {
        customer_name: 'C' + Math.random().toString(36).slice(2, 6),
        customer_email: 'c@x.com',
        answers: [
          { id: 'basics.name', value: 'N' },
          { id: 'basics.one_liner', value: 'L' },
          { id: 'basics.purpose', value: choice }
        ]
      }
    });
  }
  const ui = await openDashboard(`/project/${project.id}`);
  await waitFor(() => ui.document.body.textContent.includes('Response Breakdown'));
  check('the breakdown panel is shown', ui.document.body.textContent.includes('Response Breakdown'));
  check('it counts the most common answer',
    ui.document.body.textContent.includes('2 (67%)'),
    (ui.document.querySelector('.editor-card')?.textContent || '').replace(/\s+/g, ' ').slice(0, 160));
});

// ================================================================== NAVIGATION
await spec('navigation between dashboard, detail and editor', async () => {
  await resetProjects();
  const project = await seed('Nav Test');
  const ui = await openDashboard();
  await waitFor(() => cardNamed(ui.document, 'Nav Test'));

  click(ui.window, byText(cardNamed(ui.document, 'Nav Test'), 'a', 'Open'));
  await waitFor(() => ui.document.querySelector('[data-del-project]'));
  check('Open goes to the project detail', ui.document.querySelector('h1')?.textContent === 'Nav Test');

  click(ui.window, containingText(ui.document, 'a', 'Edit questions'));
  await waitFor(() => ui.document.querySelector('[data-save]'));
  check('detail → editor works', !!ui.document.querySelector('[data-save]'));

  click(ui.window, containingText(ui.document, 'a', 'Back'));
  await waitFor(() => ui.document.querySelector('[data-del-project]'));
  check('editor → back to detail works', !!ui.document.querySelector('[data-del-project]'));

  click(ui.window, containingText(ui.document, 'a', 'All projects'));
  await waitFor(() => ui.document.querySelector('#dash-search'));
  check('detail → dashboard works', !!ui.document.querySelector('#dash-search'));

  click(ui.window, ui.document.querySelector('.brand'));
  await waitFor(() => ui.document.querySelector('#dash-search'));
  check('the logo returns to the dashboard', !!ui.document.querySelector('#dash-search'));

  // deep-link straight into the editor
  const ui2 = await openDashboard(`/edit/${project.id}`);
  await waitFor(() => ui2.document.querySelector('[data-save]'));
  check('a deep link to /edit/:id opens that project',
    ui2.document.querySelector('[data-meta="name"]')?.value === 'Nav Test');
});

// ====================================================================== EMPTY
await spec('empty state', async () => {
  await resetProjects();
  const ui = await openDashboard();
  await waitFor(() => ui.document.querySelector('.empty'));
  check('a fresh install shows the empty state', !!ui.document.querySelector('.empty'));
  check('it invites you to create a project',
    ui.document.querySelector('.empty').textContent.includes('No projects yet'));
  check('no project cards are rendered', ui.document.querySelectorAll('.project-card').length === 0);
  click(ui.window, byText(ui.document.querySelector('.empty'), 'a', '+ New project'));
  await waitFor(() => ui.document.querySelector('[data-save]'));
  check('its "+ New project" button opens the editor', !!ui.document.querySelector('[data-save]'));
});

// =================================================================== SECURITY
await spec('session expiry is handled in the UI', async () => {
  await resetProjects();
  await seed('Session Test');
  const ui = await openDashboard();
  await waitFor(() => cardNamed(ui.document, 'Session Test'));

  // The cookie goes stale (logged out elsewhere, server restarted, …).
  ui.window.fetch = async (url, opts = {}) =>
    fetch(new URL(url, base).href, { ...opts, headers: { ...(opts.headers || {}), Cookie: 'rf_session=bogus' } });
  ui.window.location.hash = '#/project/1';

  const form = await waitFor(() => ui.document.querySelector('.login-card'));
  check('an expired session bounces the user to the login form', !!form);
  // Regression: the detail view fires two requests at once (Promise.all). Both
  // 401'd, and the second re-render wiped the explanation the first had shown.
  await sleep(400);
  check('the reason is explained', (ui.document.querySelector('.login-notice')?.textContent || '').includes('expired'),
    ui.document.querySelector('.login-notice')?.textContent || '(no notice)');
});

backend.stop();
console.log(failures ? `\n${failures} ADMIN UI TEST(S) FAILED` : '\nALL ADMIN UI TESTS PASSED');
process.exit(failures ? 1 : 0);
