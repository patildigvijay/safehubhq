# Safehub HQ

AI-Driven HSE Investigations & Root-Cause Analysis.
Live at: https://safehubhq.com

## What this is

A minimal Express server that serves the Safehub HQ landing page.
The entire site is in `public/index.html` — all HTML, CSS, and vanilla JS in one file.

## Folder structure

```
safehubhq/
├── package.json     # Express dependency + start script
├── server.js        # Serves static files from /public
├── .gitignore
├── README.md
└── public/
    └── index.html   # The whole landing page + investigation demo
```

## Run locally

Requires Node.js 18 or higher.

```bash
npm install
npm start
```

Then open http://localhost:3000

## Deploy to Vercel (recommended)

1. Push this folder to a new GitHub repo
2. Go to https://vercel.com and click "Add New Project"
3. Import the GitHub repo
4. Vercel auto-detects Node.js — leave defaults and click Deploy
5. In Vercel project Settings → Domains, add `safehubhq.com`
6. Update DNS records on Porkbun to point to Vercel

## Deploy to Render / Railway / Fly.io

Same idea — any platform that runs Node.js will work. They auto-detect `npm start`.

## What's next

This is the static landing page. To make it a real product:

1. Connect Anthropic Claude API to generate real investigation reports
2. Add Supabase for user accounts and quota tracking
3. Add Stripe for subscription billing
4. Migrate to Next.js or keep Express + add API routes

---

© 2026 Safehub HQ
