# ReqForge — Requirements Builder

A web app for **gathering client requirements before you build a website**. You pick which questions to ask (from a built-in bank of 12 modules / 50 questions, plus your own custom questions), and ReqForge automatically builds a **customer-facing page** where your client just ticks boxes and types answers. Every answer lands back in your dashboard.

```
┌─────────────┐   pick questions    ┌─────────────┐   share link   ┌──────────────┐
│  You (admin) │ ─────────────────▶ │  Project    │ ─────────────▶ │  Customer    │
│  /           │   + custom q's     │  /c/<slug>  │   tick & type  │  dashboard   │
└─────────────┘                     └─────────────┘                └──────────────┘
```

## Run it

```bash
npm install
npm start          # → http://localhost:3000
```

- **Admin app:** http://localhost:3000 — sign in with `admin123` (change via the `ADMIN_PASSWORD` env var)
- **Demo customer page:** http://localhost:3000/c/daily-bloom
- **Tests:** `npm test`

Requires Node 22+ (uses the built-in `node:sqlite` — no native compile step). Data is stored in `data/requirements.db` locally (gitignored; delete it to reset to demo data), or automatically in `/tmp/reqforge-data/requirements.db` when deployed to Vercel or other serverless environments.

## How it works

### 1. You (admin)
- **Create a project** — name it, add a tagline, a welcome message and a thank-you message.
- **Pick what to ask** — the question bank is grouped into 12 modules:
  🧭 About the project · 📄 Pages & structure · ⚙️ Features & functionality · 🎨 Design & branding · 📝 Content · 🛒 E-commerce · 💰 Budget & pricing · ⏰ Timeline · 🔗 Domain & hosting · 📊 Goals & success · 📣 Marketing & SEO · 💬 Anything else
- Toggle **whole modules or individual questions** on/off per customer, or **add your own custom questions** (short text, long text, tick boxes, single choice, optional/required).
- Save → get a **customer link** (`/c/<slug>`) to send to the client.
- Control status: **draft** (hidden-ish), **live** (link works), **closed** (link shows a "closed" message).

### 2. Customer
- Opens the link and sees a clean questionnaire built **only from your selection**.
- Questions render as **tick-box chips, single-choice chips, text inputs, text areas, or star ratings** — with live progress tracking and required-field validation.

### 3. Back to you
- Every submission appears in the project view — who answered, when, and a readable breakdown of all their answers.

## Tech

| Layer    | Choice                                             |
|----------|----------------------------------------------------|
| Backend  | Node.js + Express, SQLite via built-in `node:sqlite` |
| Frontend | Vanilla JS SPAs (admin) + auto-generated questionnaire (customer), no build step |
| Auth     | Password login (env `ADMIN_PASSWORD`, default `admin123`) with in-memory sessions |

## API (summary)

| Method | Route                        | Purpose                                  |
|--------|------------------------------|------------------------------------------|
| POST   | `/api/login`                 | Sign in (body: `{password}`)             |
| GET    | `/api/projects`              | List projects w/ submission counts       |
| POST   | `/api/projects`              | Create project (name → unique slug)      |
| GET    | `/api/projects/:id`          | Project detail incl. enabled config      |
| PATCH  | `/api/projects/:id`          | Update name/tagline/messages/status/config |
| DELETE | `/api/projects/:id`          | Delete project + submissions             |
| GET    | `/api/projects/:id/submissions` | List a project's customer submissions  |
| GET    | `/api/public/:slug`          | Public questionnaire config              |
| POST   | `/api/public/:slug/submit`   | Customer submits answers                 |

`lib/library.js` is the question bank — edit it to change the wording or add your own built-in modules.
