# HBJ Bot (Hottie Body Jewelry Assistant)

A tiny Express server that powers the chatbot for hottiebodyjewelry.com. It:
- Scrapes the product index and a few policy pages
- Answers FAQs
- Returns 2–4 product recommendations

## One-Page Deploy (Render)

1) Create a free account at render.com  
2) Click **New → Web Service**  
3) Choose **Public Git Repository** and point to your GitHub repo that contains these files.  
   - If you don't have a repo yet:
     - Create a new repo on GitHub called `hbj-bot`
     - Upload these files (`server.js`, `package.json`, `.env.example`, `README.md`)
4) In Render:
   - Build command: `npm install`
   - Start command: `node server.js`
   - Environment variable: `OPENAI_API_KEY=sk-...`
5) Deploy. Note the URL: `https://YOUR-SERVICE.onrender.com`

## Connect to Storefront

Paste the chat widget snippet into your 3dcart/Shift4Shop **Content → Header & Footer → Global Footer** and change:

```js
fetch('/hbj/chat', { ... })
```

to

```js
fetch('https://YOUR-SERVICE.onrender.com/hbj/chat', { ... })
```

## Local Dev

```bash
npm install
OPENAI_API_KEY=sk-... node server.js
```

Open your site, the widget will call your local or hosted endpoint depending on the fetch URL you set.

## Notes
- CORS allows `https://www.hottiebodyjewelry.com` by default; add more origins in `server.js` if needed.
- This is intentionally simple. Upgrade later with nightly catalog crawl or vector search.