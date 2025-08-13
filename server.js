// server.js
// Hottie Body Jewelry Chatbot Backend
// Minimal Express server that scrapes catalog/FAQ pages and answers queries.
// ESM module (package.json has `"type": "module"`)

import express from 'express';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import cors from 'cors';
import OpenAI from 'openai';

dotenv.config();

const app = express();
app.use(express.json());

// ---------- CORS (allow your storefront) ----------
const ALLOWED_ORIGINS = [
  'https://www.hottiebodyjewelry.com',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
];
app.use(cors({
  origin: function (origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  }
}));

// --------------------------------------------------
const SITE = 'https://www.hottiebodyjewelry.com';
let CATALOG = []; // {title, url, price, category}

// Lightweight product index scraper
async function loadProductIndex() {
  try {
    const res = await fetch(`${SITE}/product_index.asp`, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Index fetch failed: ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const items = [];
    $('a').each((_, a) => {
      const title = $(a).text().trim();
      const href = $(a).attr('href');
      if (title && href && /_p_\d+/.test(href)) {
        items.push({ title, url: new URL(href, SITE).href });
      }
    });

    // Best-effort: enrich first 250 with price & category
    const slice = items.slice(0, 250);
    for (const it of slice) {
      try {
        const r = await fetch(it.url, { redirect: 'follow' });
        if (!r.ok) continue;
        const h = await r.text();
        const $$ = cheerio.load(h);
        // Try various price selectors commonly used by Shift4Shop themes
        const price = $$('[class*=Price], .price, .ProductPrice, #price').first().text().replace(/\s+/g,' ').trim();
        const crumb = $$('a[href*="_c_"]').first().text().replace(/\s+/g,' ').trim();
        it.price = price || '';
        it.category = crumb || '';
      } catch {}
    }

    CATALOG = slice.length ? slice : items;
    console.log(`Loaded ${CATALOG.length} products`);
  } catch (e) {
    console.error('Product index error:', e.message);
  }
}

function searchProducts(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  return CATALOG
    .map(p => {
      const hay = `${p.title} ${p.category}`.toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score += 1;
      if (/\bkit\b/.test(q.toLowerCase()) && /kit/i.test(p.title)) score += 1;
      return { ...p, score };
    })
    .filter(p => p.score > 0)
    .sort((a,b) => b.score - a.score)
    .slice(0, 6);
}

// ---------- FAQ cache ----------
const FAQ_SOURCES = [
  `${SITE}/Shipping-and-Returns_ep_43-1.html`,
  `${SITE}/FAQs_ep_44-1.html`,
  `${SITE}/Safe-and-Sterile-Piercing-Kits_c_1.html`,
  `${SITE}/Aftercare.html`
];
let FAQ_TEXT = '';

async function loadFAQ() {
  const chunks = [];
  for (const url of FAQ_SOURCES) {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) continue;
      const h = await r.text();
      const $ = cheerio.load(h);
      chunks.push($('body').text().replace(/\s+/g,' ').trim());
    } catch {}
  }
  FAQ_TEXT = chunks.join('\n\n').slice(0, 18000);
  console.log('FAQ cached length:', FAQ_TEXT.length);
}

// ---------- LLM ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM = `
You are the Hottie Body Jewelry Assistant for hottiebodyjewelry.com (Shift4Shop).
- Answer FAQs strictly from FAQ_TEXT when asked.
- For buying intent, recommend 2–4 products from candidates with name, price (if known), and link.
- Keep answers short, commercial, and clear. Use bullets and clear CTAs.
- Safety: educational only; we don't endorse self-piercing. 18+ gating may apply to certain videos.
`;

async function buildResponse(userQ, candidates) {
  // Minimal formatting here; prompt is simple so the bot stays fast & deterministic
  const cards = candidates.slice(0,4).map(p => `
    <a href="${p.url}" target="_blank" style="text-decoration:none;color:inherit">
      <div style="border:1px solid #eee;border-radius:12px;padding:10px;margin:6px 0">
        <div style="font-weight:600">${p.title}</div>
        ${p.price ? `<div style="opacity:.85; margin-top:4px">${p.price}</div>` : ''}
        <div style="margin-top:6px"><span style="background:#111;color:#fff;padding:6px 10px;border-radius:8px">View</span></div>
      </div>
    </a>
  `).join('');

  const faqHit = /shipping|return|when.*ship|how long|aftercare|steril|international|deliver|refund/i.test(userQ);
  const blurb = faqHit
    ? `• <b>Shipping</b>: Most orders ship within 1 business day. Free shipping $100+ (USA only).<br>• <b>Sterile kits</b>: Include pre-sterilized jewelry plus links to videos & aftercare.<br>• <b>Note</b>: For education only; we do not endorse self‑piercing.`
    : `Here are solid matches. Tell me the <b>piercing</b> (tragus, daith, septum) and <b>gauge</b> to tighten results.`;

  return `
    <div style="font-size:14px">
      <div style="margin:6px 0">${blurb}</div>
      ${cards || '<div>No close matches yet. Try a different phrase (e.g., "16g sterile barbell").</div>'}
    </div>
  `;
}

// ---------- Routes ----------
app.post('/hbj/chat', async (req, res) => {
  try {
    const q = (req.body.q || '').toString().trim();
    if (!q) return res.json({ html: 'Ask me about kits, jewelry, needles, or shipping.' });
    const candidates = searchProducts(q);
    const html = await buildResponse(q, candidates);
    res.json({ html });
  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ html: 'Server error. Try again shortly.' });
  }
});

app.get('/hbj/health', (_, res) => res.json({ ok: true, products: CATALOG.length }));

// ---------- Boot ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await Promise.all([loadProductIndex(), loadFAQ()]);
  console.log(`HBJ Assistant running on :${PORT}`);
});