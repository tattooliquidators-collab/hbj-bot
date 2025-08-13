// server.js (patched)
// HBJ Assistant — smarter search, KB overrides, images, safety copy, page-context
// ESM module

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

// ---------- Rules / KB ----------
let RULES = { faqs:{}, promote_first:[] };
try {
  const raw = fs.readFileSync('./rules.json','utf8');
  RULES = JSON.parse(raw);
  console.log('Loaded rules.json');
} catch (e) {
  console.log('rules.json not found; proceeding with defaults');
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
  // simple US format
  return t.startsWith('$') ? t : `$${t}`;
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

    // Enrich first 300 with price/category/image
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

// ---------- Search ----------
function scoreProduct(q, p){
  const ql = q.toLowerCase();
  const title = `${p.title} ${p.category||''}`.toLowerCase();
  let s = 0;

  // direct word hits
  for (const w of ql.split(/\s+/)) if (w && title.includes(w)) s += 1;

  // synonyms
  for (const k in SYN) {
    if (SYN[k].some(t => ql.includes(t))) {
      if (SYN[k].some(t => title.includes(t))) s += 3; else s += 1;
    }
  }

  // gauge
  const g = parseGauge(q);
  if (g && title.includes(`${g}g`)) s += 4;

  // kit bias
  if (/\bkit\b/.test(ql) && /kit\b/.test(title)) s += 5;

  // sterile bias
  if (/steril/i.test(ql) && /steril/i.test(title)) s += 5;

  // promote specific products
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

// ---------- Fallback categories ----------
function buildFallback(q){
  const hints = [
    { key:/septum|bull/i, label:'Septum Kits', url:`${SITE}/search.asp?keyword=septum%20kit` },
    { key:/tragus/i,      label:'Tragus Kits', url:`${SITE}/search.asp?keyword=tragus%20kit` },
    { key:/steril/i,      label:'Sterilized Jewelry', url:`${SITE}/search.asp?keyword=sterilized` },
    { key:/nose|nostril/i,label:'Nose Kits', url:`${SITE}/search.asp?keyword=nose%20kit` }
  ].filter(h => h.key.test(q));
  if (!hints.length) return '';
  return `<div style="margin-top:8px">Try these categories:</div>${
    hints.map(h=>`<div><a href="${h.url}" target="_blank">${h.label}</a></div>`).join('')
  }`;
}

// ---------- Routes ----------
app.post('/hbj/chat', async (req, res) => {
  try {
    let q = (req.body.q || '').toString().trim();
    const page = (req.body.page || '').toString();

    // Page context → bias terms
    if (/septum/i.test(page)) q += ' septum';
    if (/tragus/i.test(page)) q += ' tragus';
    if (/nose/i.test(page)) q += ' nose';

    const looksHowTo = /(how to|tutorial|step by step|pierce.*myself)/i.test(q);
    const safety = looksHowTo ? `<div style="margin:8px 0; font-size:12px; opacity:.8">Educational info only. We don’t endorse self-piercing. Consider a licensed professional.</div>` : '';

    const kb = kbAnswer(q);
    const candidates = searchProducts(q);

    // HTML cards
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
    const blurb = kb ? kb : (faqHit
      ? `• <b>Shipping</b>: Most orders ship within 1 business day. Free shipping $100+ (USA only).<br>• <b>Sterile kits</b>: Include pre-sterilized jewelry plus links to videos & aftercare.`
      : `Tell me the <b>piercing</b> (tragus, daith, septum) and <b>gauge</b> to tighten results.`);

    const fallback = candidates.length ? '' : buildFallback(q);

    const html = `
      <div style="font-size:14px">
        ${safety}
        <div style="margin:6px 0">${blurb}</div>
        ${cards || `<div>No close matches yet. Try “16g septum kit” or “sterile barbell”.</div>`}
        ${fallback}
      </div>
    `;

    // Log queries for improvement
    console.log(new Date().toISOString(), 'Q:', q, 'Page:', page, 'Results:', candidates.length);

    res.json({ html });
  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ html: 'Server error. Try again shortly.' });
  }
});

app.get('/hbj/health', (_, res) => res.json({ ok: true, products: CATALOG.length }));

// ---------- Boot ----------
async function boot() {
  await loadProductIndex();
}
boot();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HBJ Assistant running on :${PORT}`));