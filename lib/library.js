// ReqForge question bank.
// Each module is a category of requirements you can ask your customer about.
// Every question is identified by a stable id ("module.question") so a project
// config only needs to store which ids are enabled — the wording lives here.

export const LIBRARY = [
  {
    id: 'basics',
    title: 'About the project',
    icon: '🧭',
    blurb: 'Kick-off facts: what the business is, who it serves, and where it stands today.',
    questions: [
      { id: 'basics.name', type: 'text', required: true, label: 'What is the name of your project or business?', placeholder: 'e.g. The Daily Bloom' },
      { id: 'basics.one_liner', type: 'textarea', required: true, label: 'Describe your project in one or two sentences.', placeholder: 'e.g. An online flower shop delivering same-day bouquets in Austin.' },
      { id: 'basics.purpose', type: 'checkbox', label: 'What is the main purpose of the website?', options: ['Sell products or services', 'Provide information', 'Generate leads / enquiries', 'Showcase a portfolio', 'Bookings / appointments', 'Community / memberships', 'Something else'] },
      { id: 'basics.audience', type: 'textarea', label: 'Who is your target audience? Describe them (age, location, interests…).', placeholder: 'e.g. Local couples aged 25–40 planning weddings.' },
      { id: 'basics.current_site', type: 'radio', label: 'Do you have an existing website?', options: ['No, this is my first site', 'Yes, and I want to keep it', 'Yes, but I want a redesign'] },
      { id: 'basics.satisfaction', type: 'rating', label: 'How satisfied are you with your current online presence?', help: '1 = not happy at all, 5 = love it' }
    ]
  },
  {
    id: 'pages',
    title: 'Pages & structure',
    icon: '📄',
    blurb: 'Which pages should the site have, and what goes on the homepage.',
    questions: [
      { id: 'pages.pages', type: 'checkbox', required: true, label: 'Tick every page the website should include.', options: ['Home', 'About', 'Services', 'Portfolio / Work', 'Products / Shop', 'Blog / News', 'Pricing', 'FAQ', 'Contact', 'Testimonials', 'Gallery', 'Team', 'Events', 'Login / Account', 'Legal / Privacy'] },
      { id: 'pages.structure', type: 'radio', label: 'Should the site be a single page or a multi-page site?', options: ['Single page (one long scrolling page)', 'Multi-page', 'Not sure — advise me'] },
      { id: 'pages.sections', type: 'checkbox', label: 'Which sections should the HOMEPAGE include?', options: ['Hero / intro', 'About us', 'Services / what we do', 'Portfolio / examples', 'Testimonials', 'Pricing', 'Contact form', 'Blog / latest news', 'Client logos', 'FAQ', 'Newsletter signup', 'Map & location', 'Stats / numbers'] },
      { id: 'pages.nav', type: 'text', label: 'Any special menu items or navigation requirements?', placeholder: 'e.g. a "Book a call" button in the menu' }
    ]
  },
  {
    id: 'features',
    title: 'Features & functionality',
    icon: '⚙️',
    blurb: 'What the site must actually DO — the interactive parts.',
    questions: [
      { id: 'features.features', type: 'checkbox', required: true, label: 'Tick every feature the website needs.', options: ['Contact form', 'Live chat / chat widget', 'Booking / calendar system', 'Payments / checkout', 'User accounts & login', 'Search', 'Newsletter signup', 'Image gallery', 'Video / video embeds', 'Google Maps', 'Reviews / ratings', 'Downloadable files', 'Multi-language', 'Blog / CMS', 'Admin dashboard', 'Third-party API integration', 'Social media feed', 'Chatbot'] },
      { id: 'features.important', type: 'textarea', label: 'Which features are the most important? Rank them or explain why.', placeholder: 'e.g. #1 Same-day delivery calendar, #2 online payment' },
      { id: 'features.integrations', type: 'checkbox', label: 'Should it integrate with any of these tools?', options: ['Google Analytics', 'Email marketing (Mailchimp, Klaviyo…)', 'CRM (HubSpot, Salesforce…)', 'Payment gateway (Stripe, PayPal…)', 'Social media', 'Booking system', 'Zapier / automations', 'None of these'] },
      { id: 'features.other_tools', type: 'textarea', label: 'List any other tools or services the site must connect to.' }
    ]
  },
  {
    id: 'design',
    title: 'Design & branding',
    icon: '🎨',
    blurb: 'Look & feel: style, colors, logo, and sites they love (or hate).',
    questions: [
      { id: 'design.style', type: 'radio', label: 'Which design style appeals to you most?', options: ['Minimal & clean', 'Bold & colorful', 'Playful & fun', 'Corporate & professional', 'Luxury & premium', 'Modern & trendy', 'Vintage / retro', 'Dark & edgy'] },
      { id: 'design.colors', type: 'text', label: 'Do you have brand colors? (hex codes, names, or a description)', placeholder: 'e.g. #3A6B35 sage green + cream' },
      { id: 'design.logos', type: 'radio', label: 'Do you have a logo?', options: ['Yes, I have files', 'No, I need one designed', 'Not sure yet'] },
      { id: 'design.vibe', type: 'text', label: 'Describe the feeling the site should give visitors.', placeholder: 'e.g. warm, trustworthy, energetic' },
      { id: 'design.inspiration', type: 'textarea', label: 'Links to websites you like — and what you like about them.' },
      { id: 'design.dislike', type: 'textarea', label: 'Websites you DON\u2019T like — and what to avoid.' },
      { id: 'design.images', type: 'radio', label: 'Do you have your own photos and images?', options: ['Yes', 'Some of them', 'No — use stock photos', 'Not sure'] }
    ]
  },
  {
    id: 'content',
    title: 'Content',
    icon: '📝',
    blurb: 'Who provides the text, images and copy — and when.',
    questions: [
      { id: 'content.ready', type: 'radio', label: 'Is all the text content ready?', options: ['Yes, all written', 'Mostly — a few gaps', 'No, I need help writing it', 'No content at all yet'] },
      { id: 'content.writer', type: 'radio', label: 'Who will write the content?', options: ['Me', 'My team', 'You (the agency)', 'A mix of us'] },
      { id: 'content.languages', type: 'text', label: 'Should the site be available in any language other than English?', placeholder: 'e.g. Spanish + English' },
      { id: 'content.media', type: 'checkbox', label: 'What media assets will you provide?', options: ['Logos & brand files', 'Photos', 'Videos', 'Documents / PDFs', 'Product data (spreadsheets)', 'Nothing yet'] }
    ]
  },
  {
    id: 'ecommerce',
    title: 'E-commerce',
    icon: '🛒',
    blurb: 'Only matters if you\u2019re selling online — products, payments, delivery.',
    questions: [
      { id: 'ecommerce.products', type: 'radio', label: 'How many products will you sell?', options: ['1–10', '11–50', '51–200', '200+', 'Not sure yet'] },
      { id: 'ecommerce.type', type: 'radio', label: 'Are you selling physical products, digital products, or both?', options: ['Physical products', 'Digital products', 'Both', 'Services (booked online)'] },
      { id: 'ecommerce.payments', type: 'checkbox', label: 'Which payment methods should be accepted?', options: ['Credit / debit card', 'PayPal', 'Stripe', 'Apple Pay / Google Pay', 'Bank transfer', 'Cash on delivery', 'Other'] },
      { id: 'ecommerce.stock', type: 'radio', label: 'Do you need inventory / stock management?', options: ['Yes', 'No', 'Not sure'] },
      { id: 'ecommerce.shipping', type: 'textarea', label: 'Any shipping or delivery requirements?' }
    ]
  },
  {
    id: 'budget',
    title: 'Budget & pricing',
    icon: '💰',
    blurb: 'A tricky but essential conversation — get a realistic range.',
    questions: [
      { id: 'budget.budget', type: 'radio', required: true, label: 'What is your budget for this project?', options: ['Under $1,000', '$1,000 – $3,000', '$3,000 – $7,000', '$7,000 – $15,000', '$15,000+', 'Not sure yet — advise me'] },
      { id: 'budget.monthly', type: 'radio', label: 'Do you expect ongoing monthly costs (hosting, maintenance, updates)?', options: ['Yes, budgeted for', 'Maybe — explain options', 'No'] },
      { id: 'budget.notes', type: 'textarea', label: 'Anything else about budget we should know?' }
    ]
  },
  {
    id: 'timeline',
    title: 'Timeline',
    icon: '⏰',
    blurb: 'Deadlines, urgency and whether a phased launch works.',
    questions: [
      { id: 'timeline.deadline', type: 'text', label: 'When do you need the website live? (date)', placeholder: 'e.g. 2026-10-15' },
      { id: 'timeline.speed', type: 'radio', label: 'How urgent is this project?', options: ['As soon as possible', 'Within a month', '1–3 months', '3+ months', 'Flexible / no rush'] },
      { id: 'timeline.phases', type: 'radio', label: 'Is a phased launch OK (launch the core site first, add features later)?', options: ['Yes', 'No — everything at once', 'Not sure'] }
    ]
  },
  {
    id: 'hosting',
    title: 'Domain & hosting',
    icon: '🔗',
    blurb: 'The plumbing: domain, email and where the site will live.',
    questions: [
      { id: 'hosting.domain', type: 'radio', label: 'Do you already have a domain name?', options: ['Yes', 'No — I need to buy one', 'Not sure'] },
      { id: 'hosting.email', type: 'radio', label: 'Do you need a professional email address (you@yourdomain.com)?', options: ['Yes', 'No', 'Already have one'] },
      { id: 'hosting.hosting', type: 'radio', label: 'Do you have hosting?', options: ['Yes', 'No', 'Not sure what that is'] },
      { id: 'hosting.platform', type: 'radio', label: 'Any preference for the technology / platform?', options: ['No preference — your call', 'WordPress', 'Shopify', 'Custom-built', 'Wix / Squarespace', 'Other'] }
    ]
  },
  {
    id: 'goals',
    title: 'Goals & success',
    icon: '📊',
    blurb: 'What success looks like, must-haves, and the #1 action you want visitors to take.',
    questions: [
      { id: 'goals.success', type: 'checkbox', label: 'How will you measure success?', options: ['More sales / orders', 'More enquiries / leads', 'More signups', 'More traffic / visits', 'Brand awareness', 'Showcasing work', 'Something else'] },
      { id: 'goals.must_haves', type: 'textarea', required: true, label: 'Top 3 must-haves — what absolutely cannot be missing?' },
      { id: 'goals.cta', type: 'radio', label: 'What is the #1 action you want visitors to take?', options: ['Call us', 'Buy a product', 'Book an appointment', 'Send an enquiry', 'Sign up', 'View my work', 'Other'] },
      { id: 'goals.competitors', type: 'textarea', label: 'Who are your main competitors? (links if possible)' }
    ]
  },
  {
    id: 'marketing',
    title: 'Marketing & SEO',
    icon: '📣',
    blurb: 'Google visibility, social links and how the site will be promoted.',
    questions: [
      { id: 'marketing.seo', type: 'radio', label: 'How important is being found on Google?', options: ['Very important', 'Somewhat important', 'Not important'] },
      { id: 'marketing.seo_help', type: 'radio', label: 'Do you want help with SEO setup (titles, descriptions, sitemap)?', options: ['Yes, please handle it', 'I\u2019ll handle it', 'Not sure'] },
      { id: 'marketing.social', type: 'checkbox', label: 'Which social channels should be linked?', options: ['Facebook', 'Instagram', 'LinkedIn', 'X / Twitter', 'YouTube', 'TikTok', 'Pinterest', 'None'] },
      { id: 'marketing.ads', type: 'radio', label: 'Will you run paid ads to this site?', options: ['Yes — Google Ads', 'Yes — social ads', 'Maybe later', 'No'] }
    ]
  },
  {
    id: 'extra',
    title: 'Anything else',
    icon: '💬',
    blurb: 'Final notes and how they\u2019d like to be contacted.',
    questions: [
      { id: 'extra.comments', type: 'textarea', label: 'Anything else we should know about this project?' },
      { id: 'extra.contact_pref', type: 'radio', label: 'How would you like us to contact you?', options: ['Email', 'Phone', 'WhatsApp', 'Video call'] }
    ]
  }
];
