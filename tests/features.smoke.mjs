// Test suite for new features: Duplicate Project, Delete Submission, Custom Question options & Rating type.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.VERCEL = '1';
process.env.DATA_DIR = path.join(os.tmpdir(), `reqfeat-${process.pid}-${Date.now()}`);
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const app = (await import('../server.js')).default;

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

// 1. Login
const login = await req('/api/login', { method: 'POST', body: { username: 'pavit', password: '5161211' } });
const cookie = login.token;
check('Login successful', login.status === 200);

// 2. Fetch projects
const projectsRes = await req('/api/projects', { cookie });
const bloomProj = projectsRes.json.projects.find(p => p.slug === 'daily-bloom');
check('Found bloom project', !!bloomProj);

// 3. Test Duplicate Project API
const dupRes = await req(`/api/projects/${bloomProj.id}/duplicate`, { method: 'POST', cookie });
check('Duplicate project endpoint returns 201', dupRes.status === 201);
check('Duplicated project name starts with Copy of', dupRes.json?.project?.name?.startsWith('Copy of'));
check('Duplicated project status is draft', dupRes.json?.project?.status === 'draft');

// 4. Test Submission Creation & Individual Submission Deletion
const submitRes = await req('/api/public/daily-bloom/submit', {
  method: 'POST',
  body: {
    customer_name: 'ToDelete Client',
    customer_email: 'delete@example.com',
    answers: [
      { id: 'basics.name', label: 'Name?', type: 'text', value: 'Bloom' },
      { id: 'basics.one_liner', label: 'Liner?', type: 'textarea', value: 'Flowers' },
      { id: 'pages.pages', label: 'Pages?', type: 'checkbox', value: ['Home'] },
      { id: 'features.features', label: 'Features?', type: 'checkbox', value: ['Contact form'] },
      { id: 'budget.budget', label: 'Budget?', type: 'radio', value: '$3,000 – $7,000' }
    ]
  }
});
check('Submission created', submitRes.status === 201);

const subsRes = await req(`/api/projects/${bloomProj.id}/submissions`, { cookie });
const newSub = subsRes.json.submissions.find(s => s.customer_name === 'ToDelete Client');
check('Found newly created submission', !!newSub);

const delSubRes = await req(`/api/projects/${bloomProj.id}/submissions/${newSub.id}`, { method: 'DELETE', cookie });
check('Delete submission returns 200', delSubRes.status === 200);

const subsAfterRes = await req(`/api/projects/${bloomProj.id}/submissions`, { cookie });
const deletedSubFound = subsAfterRes.json.submissions.some(s => s.id === newSub.id);
check('Submission is removed from database', !deletedSubFound);

// 5. Test Custom Question with Rating & Help/Placeholder in PATCH config
const updatedConfig = {
  modules: [
    {
      id: 'basics',
      questions: [
        'basics.name',
        'basics.one_liner',
        {
          id: 'custom_rating_1',
          type: 'rating',
          label: 'Rate our service',
          help: '1 to 5 stars',
          placeholder: '',
          required: false
        }
      ]
    }
  ]
};

const patchRes = await req(`/api/projects/${bloomProj.id}`, {
  method: 'PATCH',
  cookie,
  body: { config: updatedConfig }
});
check('PATCH with custom rating question accepted', patchRes.status === 200);

const pubRes = await req('/api/public/daily-bloom');
const hasCustomRating = pubRes.json?.modules?.some(m => m.questions.some(q => q.id === 'custom_rating_1' && q.type === 'rating'));
check('Public API renders custom rating question', hasCustomRating);

server.close();
console.log(failures ? `\n${failures} FAILURES` : '\nALL FEATURE TESTS PASSED');
process.exit(failures ? 1 : 0);
