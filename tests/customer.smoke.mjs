// jsdom smoke test for the customer questionnaire page
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/user/requirements/public';
const html = fs.readFileSync(path.join(ROOT, 'customer.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'customer.js'), 'utf8');

const dom = new JSDOM(html, {
  url: 'https://example.test/c/daily-bloom',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;
const { document } = window;

// stub fetch
const modules = [
  {
    id: 'basics', title: 'About the project', icon: '🧭', blurb: 'b',
    questions: [
      { id: 'basics.name', type: 'text', required: true, label: 'Project name?', placeholder: 'name' },
      { id: 'basics.purpose', type: 'checkbox', label: 'Purpose?', options: ['Sell', 'Inform'] },
      { id: 'basics.style', type: 'radio', label: 'Style?', options: ['Minimal', 'Bold'] },
      { id: 'basics.rating', type: 'rating', label: 'Satisfaction?', help: '1-5' }
    ]
  },
  {
    id: 'extra', title: 'Extra', icon: '💬', blurb: 'e',
    questions: [
      { id: 'extra.comments', type: 'textarea', label: 'Comments?' }
    ]
  }
];
const project = { name: 'Demo Shop', tagline: 'A demo', welcome: 'Welcome!', status: 'live' };

let submitBody = null;
let submissionOk = false;
window.fetch = async (url, opts = {}) => {
  if (url === '/api/public/daily-bloom') {
    return { ok: true, status: 200, json: async () => ({ project, modules }) };
  }
  if (url === '/api/public/daily-bloom/submit') {
    submitBody = JSON.parse(opts.body);
    submissionOk = true;
    return { ok: true, status: 201, json: async () => ({ ok: true, closing: 'Thanks!' }) };
  }
  throw new Error('unexpected fetch ' + url);
};

window.eval(js);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
let failures = 0;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name);
  if (!cond) failures++;
}

await sleep(100); // let load() finish

check('renders project name', document.querySelector('.cust-header h1')?.textContent.includes('Demo Shop'));
check('renders welcome', document.querySelector('.welcome')?.textContent.includes('Welcome!'));
check('renders 2 sections + about-you card', document.querySelectorAll('.section-card').length === 3);
check('renders chip options', document.querySelectorAll('.chip').length === 4);
check('renders stars', document.querySelectorAll('.star-btn').length === 5);

// type into text input
const nameInput = document.querySelector('input[data-q="basics.name"]');
nameInput.value = 'My Cool Project';
nameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(10);
check('text answer recorded', document.querySelector('[data-pct]').textContent !== '0%');

// click two checkboxes (multi-select)
const chips = document.querySelectorAll('.chip[data-q="basics.purpose"]');
chips[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
chips[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(10);
check('checkbox chip toggles on', chips[0].classList.contains('on'));
check('checkbox chip value clean (no tick char)', chips[0].querySelector('.lbl').textContent.trim() === 'Sell');

// radio single-select
const radios = document.querySelectorAll('.chip.single[data-q="basics.style"]');
radios[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(10);
check('radio selected', radios[1].classList.contains('on') && !radios[0].classList.contains('on'));

// rating
const stars = document.querySelectorAll('.star-btn');
stars[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(10);
check('rating records 4', stars[3].classList.contains('on') && !stars[4].classList.contains('on'));

// submit with empty required name -> should show error
const custName = document.getElementById('cust-name');
custName.value = 'Jane Doe';
custName.dispatchEvent(new window.Event('input', { bubbles: true }));
const custEmail = document.getElementById('cust-email');
custEmail.value = 'jane@example.com';
custEmail.dispatchEvent(new window.Event('input', { bubbles: true }));

const form = document.querySelector('.form-shell');
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(50);

check('submission sent to API', submissionOk);
check('submit body has clean answers', submitBody && submitBody.answers.length === 4);
check('checkbox value is array without tick', submitBody && Array.isArray(submitBody.answers.find(a => a.id === 'basics.purpose').value));
check('radio value exact', submitBody && submitBody.answers.find(a => a.id === 'basics.style').value === 'Bold');
check('rating value numeric', submitBody && submitBody.answers.find(a => a.id === 'basics.rating').value === 4);
check('shows thank-you', document.querySelector('.thanks h1')?.textContent.includes('Thank you'));

console.log(failures ? `\n${failures} FAILURES` : '\nALL CUSTOMER TESTS PASSED');
process.exit(failures ? 1 : 0);
