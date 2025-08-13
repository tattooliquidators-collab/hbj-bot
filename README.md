# HBJ Bot — Pages-Aware
Point the bot at specific site pages via `pages.json`. The bot ingests those pages at startup, searches them for answers, and shows a snippet + link in replies.

## Files
- `server.js` — loads `pages.json`, scrapes each page (selector optional), builds a small doc index, and searches it per question.
- `pages.json` — list of pages to ingest. Add/remove URLs and redeploy.
- `rules.json` — short, guaranteed answers for common FAQs + a promote list.
- `package.json` — minimal deps.

## Deploy
Replace your repo’s files with these, commit, and Render will redeploy.
Verify at `/hbj/health` — you should see nonzero `docs` and `products`.