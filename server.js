// server.js (pages-aware)
// Adds ingestion of specific pages defined in pages.json and answers from them.
// Builds on previous "patched" version (smart search, KB, images, safety).

import express from 'express';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import cors from 'cors';
import fs from 'fs';

dotenv.config();

const app = express();
app.use(express.json());

// ---------- CORS ----------
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

// ---------- Globals ----------
const SITE = 'https://www.hottiebodyjewelry.com';
let CATALOG = []; // {title, url, price, category, image}
let DOCS = [];    // {url, title, text}

// ---------- Rules / KB ----------
let RULES = { faqs:{}, promote_first:[] };
try {
  const raw = fs.readFileSync('./rules.json','utf8');
  RULES = JSON.parse(raw);
  console.log('Loaded rules.json');
} catch (e) {
  console.log('rules.json not found; proceeding with defaults');
}

// ---------- Pages config ----------
let PAGES = { pages: [] };
try {
  const raw = fs.readFileSync('./pages.json','utf8');
  PAGES = JSON.parse(raw);
  console.log('Loaded pages.json with', PAGES.pages?.length || 0, 'pages');
} catch (e) {
  console.log('pages.json not found; proceeding without explicit pages');
}

// ---------- Helpers ----------
const SYN = {
  tragus: ['tragus'],
  daith: ['daith'],
  septum: ['septum','bull ring','bullring'],
  nose: ['nose','nostril','stud','hoop'],
  labret: ['labret','monroe'],
  eyebrow: ['eyebrow','brow'],
  tongue: ['tongue','barbell'],
  ring: ['ring','captive','captive bead','cbr','segment'],
  barbell: ['barbell','straight barbell','curved barbell','banana'],
  sterile: ['sterile','pre-sterilized','pre sterilized','sterilized'],
  kit: ['kit','piercing kit']
};

function parseGauge(q){
  const m = q.match(/\b(10|12|14|16|18|20|22|8|6)\s*g\b/i);
  return m ? m[1] : null;
}

function kbAnswer(q){
  const k = q.toLowerCase().replace(/[^\w\s]/g,'').trim();
  for (const key of Object.keys(RULES.faqs||{})) {
    if (k.includes(key)) return RULES.faqs[key];
  }
  return null;
}

function normalizePrice(txt=''){
  const t = txt.replace(/[^0-9\.\,]/g,'');
  if (!t) return '';
  return t.startsWith('$') ? t : `$${t}`;
}

function cleanText(t=''){
  return t.replace(/\s+/g,' ').replace(/\u00a0/g,' ').trim();
}

// ---------- Load specific pages ----------
async function loadPages() {
  DOCS = [];
  for (const entry of (PAGES.pages || [])) {
    const url = entry.url;
    const selector = entry.selector || 'body';
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) continue;
      const h = await r.text();
      const $ = cheerio.load(h);
      const title = cleanText($('title').first().text()) || url;
      const text = cleanText($(selector).text());
      if (text && text.length > 200) {
        DOCS.push({ url, title, text });
        console.log('Ingested page:', url, 'len=', text.length);
      }
    } catch (e) {
      console.log('Page load failed:', url, e.message);
    }
  }
}

// Simple relevance ranking for docs
function scoreDoc(q, d){
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  let s = 0;
  const hay = d.text.toLowerCase();
  for (const t of terms) if (hay.includes(t)) s += 2;
  if (/ship|delivery|return|refund/i.test(q)) if (/ship|return|refund/i.test(hay)) s += 5;
  if (/aftercare|clean|saline|healing/i.test(q)) if (/aftercare|clean|saline|healing/i.test(hay)) s += 5;
  if (/steril/i.test(q)) if (/steril/i.test(hay)) s += 5;
  return s;
}

function searchDocs(q){
  if (!DOCS.length) return null;
  const ranked = DOCS
    .map(d => ({...d, score: scoreDoc(q, d)}))
    .sort((a,b)=> b.score - a.score);
  const top = ranked[0];
  if (!top || top.score <= 0) return null;
  const idx = Math.max(0, top.text.toLowerCase().indexOf(q.split(/\s+/)[0].toLowerCase()));
  const start = Math.max(0, idx - 200);
  const end = Math.min(top.text.length, start + 400);
  const snippet = top.text.slice(start, end);
  return { title: top.title, url: top.url, snippet };
}

// ---------- Catalog loader ----------
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

    const slice = items.slice(0, 300);
    for (const it of slice) {
      try {
        const r = await fetch(it.url, { redirect: 'follow' });
        if (!r.ok) continue;
        const h = await r.text();
        const $$ = cheerio.load(h);
        const priceRaw = $$('[class*=Price], .price, .ProductPrice, #price').first().text().replace(/\s+/g,' ').trim();
        const crumb = $$('a[href*="_c_"]').first().text().replace(/\s+/g,' ').trim();
        let img = $$('img[src*="/assets/images"], img[src*="/images"]').first().attr('src');
        if (img && !/^https?:\/\//i.test(img)) img = new URL(img, it.url).href;
        it.price = normalizePrice(priceRaw);
        it.category = crumb || '';
        it.image = img || '';
      } catch {}
    }

    CATALOG = slice.length ? slice : items;
    console.log(`Loaded ${CATALOG.length} products`);
  } catch (e) {
    console.error('Product index error:', e.message);
  }
}

// ---------- Product search ----------
const SYN_MAP = SYN;

function scoreProduct(q, p){
  const ql = q.toLowerCase();
  const title = `${p.title} ${p.category||''}`.toLowerCase();
  let s = 0;

  for (const w of ql.split(/\s+/)) if (w && title.includes(w)) s += 1;
  for (const k in SYN_MAP) {
    if (SYN_MAP[k].some(t => ql.includes(t))) {
      if (SYN_MAP[k].some(t => title.includes(t))) s += 3; else s += 1;
    }
  }
  const g = parseGauge(q);
  if (g && title.includes(`${g}g`)) s += 4;
  if (/\bkit\b/.test(ql) && /kit\b/.test(title)) s += 5;
  if (/steril/i.test(ql) && /steril/i.test(title)) s += 5;
  if ((RULES.promote_first||[]).some(n => title.includes(n.toLowerCase()))) s += 3;
  return s;
}

function searchProducts(q){
  return CATALOG
    .map(p => ({...p, score: scoreProduct(q,p)}))
    .filter(p => p.score > 0)
    .sort((a,b)=> b.score - a.score)
    .slice(0, 6);
}

// ---------- Routes ----------
app.post('/hbj/chat', async (req, res) => {
  try {
    let q = (req.body.q || '').toString().trim();
    const page = (req.body.page || '').toString();

    if (/septum/i.test(page)) q += ' septum';
    if (/tragus/i.test(page)) q += ' tragus';
    if (/nose/i.test(page)) q += ' nose';

    const looksHowTo = /(how to|tutorial|step by step|pierce.*myself)/i.test(q);
    const safety = looksHowTo ? `<div style="margin:8px 0; font-size:12px; opacity:.8">Educational info only. We don’t endorse self-piercing. Consider a licensed professional.</div>` : '';

    // Page-based answer
    const docHit = searchDocs(q);

    // KB override
    const kb = kbAnswer(q);

    // Products
    const candidates = searchProducts(q);
    const cards = candidates.slice(0,4).map(p => `
      <a href="${p.url}" target="_blank" style="text-decoration:none;color:inherit">
        <div style="border:1px solid #eee;border-radius:12px;padding:10px;margin:6px 0; display:flex; gap:10px; align-items:center">
          ${p.image ? `<img src="${p.image}" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:8px">` : ''}
          <div style="flex:1">
            <div style="font-weight:600">${p.title}</div>
            ${p.price ? `<div style="opacity:.85; margin-top:4px">${p.price}</div>` : ''}
            <div style="margin-top:6px"><span style="background:#111;color:#fff;padding:6px 10px;border-radius:8px">View</span></div>
          </div>
        </div>
      </a>
    `).join('');

    const faqHit = /shipping|return|when.*ship|how long|aftercare|steril|international|deliver|refund/i.test(q);
    const defaultBlurb = faqHit
      ? `• <b>Shipping</b>: Most orders ship within 1 business day. Free shipping $100+ (USA only).<br>• <b>Sterile kits</b>: Include pre-sterilized jewelry plus links to videos & aftercare.`
      : `Tell me the <b>piercing</b> (tragus, daith, septum) and <b>gauge</b> to tighten results.`;

    const sourceBlock = docHit ? `
      <div style="margin:6px 0; padding:8px; background:#fafafa; border:1px solid #eee; border-radius:8px">
        <div style="font-weight:600; margin-bottom:6px">From: <a href="${docHit.url}" target="_blank">${docHit.title}</a></div>
        <div style="font-size:13px">${docHit.snippet}...</div>
      </div>
    ` : '';

    const blurb = kb || defaultBlurb;

    const html = `
      <div style="font-size:14px">
        ${safety}
        ${sourceBlock}
        <div style="margin:6px 0">${blurb}</div>
        ${cards || `<div>No close matches yet. Try “16g septum kit” or “sterile barbell”.</div>`}
      </div>
    `;

    console.log(new Date().toISOString(), 'Q:', q, 'Page:', page, 'Docs:', !!docHit, 'Results:', candidates.length);
    res.json({ html });
  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ html: 'Server error. Try again shortly.' });
  }
});

app.get('/hbj/health', (_, res) => res.json({ ok: true, products: CATALOG.length, docs: DOCS.length }));

// ---------- Boot ----------
async function boot() {
  await Promise.all([ loadProductIndex(), loadPages() ]);
}
boot();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HBJ Assistant running on :${PORT}`));