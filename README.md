# HBJ Bot — Pages + Stock Filter + Direct OOS
- Ingests specific site pages from `pages.json` (now includes Professional Piercing Kits)
- Recommends **only** in-stock items by default
- Shows **out-of-stock** items *only* when the user explicitly asks about them (mentions "out of stock/available/restock" etc.) or clearly names the exact product

## Deploy
Replace `server.js`, `package.json`, `pages.json`, `rules.json` in your GitHub repo.
Render auto-redeploys. Check `/hbj/health` for stock counts.