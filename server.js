// server.js — Safehub HQ
// Minimal Express server that serves the static landing page from /public.
// To run locally: `npm install` then `npm start` and open http://localhost:3000

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve every file inside the /public folder at the URL root.
// e.g. /public/index.html is reachable at  http://localhost:3000/
app.use(express.static(path.join(__dirname, 'public')));

// Fallback: if someone hits an unknown route, send them to the landing page.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Safehub HQ running on http://localhost:${PORT}`);
});
