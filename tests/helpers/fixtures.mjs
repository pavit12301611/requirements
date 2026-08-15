// Shared test fixtures.
//
// The database ships empty — projects are created by the admin, not baked into
// the code — so tests create whatever data they need through the public API.
// That also makes each suite self-contained: it no longer silently depends on
// demo rows that a fresh deployment does not have.

// Mirrors the old "flower shop" demo: a live project covering enough modules to
// exercise every question type.
export const shopConfig = {
  modules: [
    { id: 'basics', questions: ['basics.name', 'basics.one_liner', 'basics.purpose', 'basics.audience', 'basics.current_site'] },
    { id: 'pages', questions: ['pages.pages', 'pages.structure', 'pages.sections'] },
    { id: 'features', questions: ['features.features', 'features.important', 'features.integrations'] },
    { id: 'design', questions: ['design.style', 'design.colors', 'design.logos', 'design.vibe', 'design.inspiration'] },
    { id: 'budget', questions: ['budget.budget', 'budget.monthly'] },
    { id: 'timeline', questions: ['timeline.deadline', 'timeline.speed', 'timeline.phases'] },
    { id: 'ecommerce', questions: ['ecommerce.products', 'ecommerce.type', 'ecommerce.payments', 'ecommerce.shipping'] },
    { id: 'goals', questions: ['goals.success', 'goals.must_haves', 'goals.cta'] }
  ]
};

export const portfolioConfig = {
  modules: [
    { id: 'basics', questions: ['basics.name', 'basics.one_liner', 'basics.audience', 'basics.current_site'] },
    { id: 'pages', questions: ['pages.pages', 'pages.sections'] },
    { id: 'design', questions: ['design.style', 'design.vibe', 'design.images'] },
    { id: 'goals', questions: ['goals.success', 'goals.must_haves', 'goals.cta'] }
  ]
};

// Answers satisfying every required question in `shopConfig`.
export const shopAnswers = [
  { id: 'basics.name', label: 'Name?', type: 'text', value: 'Bloom' },
  { id: 'basics.one_liner', label: 'Liner?', type: 'textarea', value: 'Flowers' },
  { id: 'pages.pages', label: 'Pages?', type: 'checkbox', value: ['Home'] },
  { id: 'features.features', label: 'Features?', type: 'checkbox', value: ['Contact form'] },
  { id: 'budget.budget', label: 'Budget?', type: 'radio', value: '$3,000 – $7,000' },
  { id: 'goals.must_haves', label: 'Must?', type: 'textarea', value: 'x' }
];

// Creates a project and returns it. `req` is the suite's request helper.
export async function createProject(req, cookie, overrides = {}) {
  const res = await req('/api/projects', {
    method: 'POST',
    cookie,
    body: {
      name: 'Test Project',
      tagline: 'A test project',
      welcome: 'Welcome!',
      closing: 'Thanks!',
      status: 'live',
      config: shopConfig,
      ...overrides
    }
  });
  if (res.status !== 201) {
    throw new Error(`fixture: could not create project (${res.status}) ${JSON.stringify(res.json)}`);
  }
  return res.json.project;
}

// A live project that accepts submissions, standing in for the old demo shop.
export function createLiveProject(req, cookie, overrides = {}) {
  return createProject(req, cookie, { name: 'The Daily Bloom', status: 'live', config: shopConfig, ...overrides });
}

// A draft project, standing in for the old demo portfolio.
export function createDraftProject(req, cookie, overrides = {}) {
  return createProject(req, cookie, {
    name: 'Marcus Reed Photography', status: 'draft', config: portfolioConfig, ...overrides
  });
}
