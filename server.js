// server.js (pages-aware + stock filter + direct-OOS only)
// - Ingests pages from pages.json (includes Professional Piercing Kits)
// - Recommends only in-stock items by default
// - Shows out-of-stock items ONLY when user asks directly about them
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
let CATALOG = []; // {title, url, price, category, image, instock: true|false|null}
let DOCS = [];    // {url, title, text}

// ---------- Rules / KB ----------
let RULES = { faqs:{}, promote_first:[] };
try { RULES = JSON.parse(fs.readFileSync('./rules.json','utf8')); } catch {}

// ---------- Pages config ----------
let PAGES = { pages: [] };
try { PAGES = JSON.parse(fs.readFileSync('./pages.json','utf8')); } catch {}

// ---------- Helpers ----------
function cleanText(t=''){ return t.replace(/\s+/g,' ').replace(/\u00a0/g,' ').trim(); }
function normalizePrice(txt=''){
  const s = (txt||'').trim();
  if (!s) return '';
  if (/^\$?\d/.test(s)) return s.startsWith('$') ? s : `$${s}`;
  return s;
}

// ---------- Load specific pages ----------
async function loadPages() {
  DOCS = [];
  for (const entry of (PAGES.pages || [])) {
    const url = entry.url; const selector = entry.selector || 'body';
    try {
      const r = await fetch(url, { redirect: 'follow' }); if (!r.ok) continue;
      const h = await r.text(); const $ = cheerio.load(h);
      const title = cleanText($('title').first().text()) || url;
      const text = cleanText($(selector).text());
      if (text && text.length > 200) DOCS.push({ url, title, text });
    } catch {}
  }
}

// Rank docs for a query
function scoreDoc(q, d){
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  let s = 0, hay = d.text.toLowerCase();
  for (const t of terms) if (hay.includes(t)) s += 2;
  if (/ship|delivery|return|refund/i.test(q) && /ship|return|refund/i.test(hay)) s += 5;
  if (/aftercare|clean|saline|healing/i.test(q) && /aftercare|clean|saline|healing/i.test(hay)) s += 5;
  if (/steril/i.test(q) && /steril/i.test(hay)) s += 5;
  return s;
}
function searchDocs(q){
  if (!DOCS.length) return null;
  const ranked = DOCS.map(d => ({...d, score: scoreDoc(q,d)})).sort((a,b)=>b.score-a.score);
  const top = ranked[0]; if (!top || top.score<=0) return null;
  const needle = q.split(/\s+/)[0].toLowerCase();
  const idx = Math.max(0, top.text.toLowerCase().indexOf(needle));
  const start = Math.max(0, idx - 200), end = Math.min(top.text.length, start+400);
  return { title: top.title, url: top.url, snippet: top.text.slice(start,end) };
}

// ---------- Product catalog loader ----------
function detectStock($$){
  let avail = $$('meta[itemprop="availability"]').attr('content') || $$('link[itemprop="availability"]').attr('href') || '';
  avail = (avail||'').toLowerCase();
  if (/outofstock/.test(avail)) return false;
  if (/instock|preorder/.test(avail)) return true;

  const bodyText = $$('body').text().toLowerCase();
  if (/(out\s*of\s*stock|sold\s*out|unavailable|back[-\s]?order\s*only)/i.test(bodyText)) return false;

  let hasAdd = false;
  $$('button, input[type=submit], a').each((i,el)=>{
    const t = ($$(el).text() || $$(el).attr('value') || '').toLowerCase();
    if (/add\s*to\s*cart|buy\s*now|addtocart/.test(t)) hasAdd = true;
  });
  if (hasAdd) return true;
  return null;
}

async function loadProductIndex() {
  try {
    const res = await fetch(`${SITE}/product_index.asp`, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Index fetch failed: ${res.status}`);
    const html = await res.text(); const $ = cheerio.load(html); const items = [];
    $('a').each((_, a) => {
      const title = $(a).text().trim(); const href = $(a).attr('href');
      if (title && href && /_p_\d+/.test(href)) items.push({ title, url: new URL(href, SITE).href });
    });
    const slice = items.slice(0, 400);
    for (const it of slice) {
      try {
        const r = await fetch(it.url, { redirect: 'follow' }); if (!r.ok) continue;
        const h = await r.text(); const $$ = cheerio.load(h);
        const priceRaw = $$('[class*=Price], .price, .ProductPrice, #price').first().text().replace(/\s+/g,' ').trim();
        const crumb = $$('a[href*="_c_"]').first().text().replace(/\s+/g,' ').trim();
        let img = $$('img[src*="/assets/images"], img[src*="/images"]').first().attr('src');
        if (img && !/^https?:\/\//i.test(img)) img = new URL(img, it.url).href;
        it.price = normalizePrice(priceRaw);
        it.category = crumb || '';
        it.image = img || '';
        it.instock = detectStock($$);
      } catch {}
    }
    CATALOG = slice.length ? slice : items;
    console.log(`Loaded ${CATALOG.length} products (enriched: ${slice.length})`);
  } catch (e) { console.error('Product index error:', e.message); }
}

// ---------- Product search ----------
const SYN = {
  tragus: ['tragus'], daith: ['daith'], septum: ['septum','bull ring','bullring'],
  nose: ['nose','nostril','stud','hoop'], labret: ['labret','monroe'],
  eyebrow: ['eyebrow','brow'], tongue: ['tongue','barbell'],
  ring: ['ring','captive','captive bead','cbr','segment'],
  barbell: ['barbell','straight barbell','curved barbell','banana'],
  sterile: ['sterile','pre-sterilized','pre sterilized','sterilized'],
  kit: ['kit','piercing kit']
};
function parseGauge(q){ const m = q.match(/\b(10|12|14|16|18|20|22|8|6)\s*g\b/i); return m ? m[1] : null; }

function tokenOverlap(a,b){
  const A = new Set(a.toLowerCase().split(/\W+/).filter(x=>x.length>2));
  const B = new Set(b.toLowerCase().split(/\W+/).filter(x=>x.length>2));
  let hit = 0; for (const t of A) if (B.has(t)) hit++;
  return hit;
}
function looksDirectAsk(q, p){
  // show OOS only if the user likely asked about that exact product OR asked about out-of-stock explicitly
  const explicit = /(out of stock|sold out|back.?in stock|restock|available|availability|in stock)/i.test(q);
  if (explicit) return true;
  const overlap = tokenOverlap(q, p.title);
  return overlap >= 3; // at least 3 shared meaningful tokens
}

function scoreProduct(q,p){
  const ql = q.toLowerCase(); const title = `${p.title} ${p.category||''}`.toLowerCase(); let s=0;
  for (const w of ql.split(/\s+/)) if (w && title.includes(w)) s += 1;
  for (const k in SYN){ if (SYN[k].some(t=>ql.includes(t))) s += SYN[k].some(t=>title.includes(t))?3:1; }
  const g = parseGauge(q); if (g && title.includes(`${g}g`)) s += 4;
  if (/\bkit\b/.test(ql) && /kit\b/.test(title)) s += 5;
  if (/steril/i.test(ql) && /steril/i.test(title)) s += 5;
  if ((RULES.promote_first||[]).some(n => title.includes(n.toLowerCase()))) s += 3;
  // Hard penalty for OOS (we'll handle direct-OOS later)
  if (p.instock === false) s -= 100;
  return s;
}

function searchProducts(q){
  const rankedAll = CATALOG
    .map(p=>({...p,score:scoreProduct(q,p)}))
    .filter(p=>p.score>0)
    .sort((a,b)=>b.score-a.score);

  const inStock = rankedAll.filter(p => p.instock !== false);
  const oos = rankedAll.filter(p => p.instock === false);

  return { inStock: inStock.slice(0,6), oos: oos.slice(0,3) };
}

// ---------- Routes ----------
app.post('/hbj/chat', async (req,res)=>{
  try{
    let q = (req.body.q||'').toString().trim();
    const page = (req.body.page||'').toString();
    if (/septum/i.test(page)) q += ' septum';
    if (/tragus/i.test(page)) q += ' tragus';
    if (/nose/i.test(page)) q += ' nose';

    const looksHowTo = /(how to|tutorial|step by step|pierce.*myself)/i.test(q);
    const safety = looksHowTo ? `<div style="margin:8px 0; font-size:12px; opacity:.8">Educational info only. We don’t endorse self-piercing. Consider a licensed professional.</div>` : '';

    const docHit = searchDocs(q);

    // KB quick wins
    const norm = q.toLowerCase().replace(/[^\w\s]/g,'').trim();
    let kb = null;
    for (const key of Object.keys(RULES.faqs||{})) if (norm.includes(key)) { kb = RULES.faqs[key]; break; }

    const { inStock, oos } = searchProducts(q);

    const cards = inStock.slice(0,4).map(p => `
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

    // Show OOS only on explicit/direct ask
    let oosBlock = '';
    const directOOS = oos.filter(p => looksDirectAsk(q, p)).slice(0,2);
    if (directOOS.length){
      oosBlock = `
      <div style="margin-top:10px; font-weight:600">Requested item (currently out of stock):</div>
      ${directOOS.map(p => `
        <div style="border:1px dashed #f2a; border-radius:12px; padding:10px; margin:6px 0; display:flex; gap:10px; align-items:center; opacity:.8">
          ${p.image ? `<img src="${p.image}" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:8px">` : ''}
          <div style="flex:1">
            <div style="font-weight:600">${p.title} <span style="color:#b00; font-weight:700">— Out of stock</span></div>
            ${p.price ? `<div style="opacity:.85; margin-top:4px">${p.price}</div>` : ''}
            <div style="margin-top:6px; font-size:12px; opacity:.85">Tip: check back later or browse similar in-stock items below.</div>
            <div style="margin-top:6px"><a href="${p.url}" target="_blank" style="text-decoration:underline">View product page</a></div>
          </div>
        </div>
      `).join('')}`;
    }

    const defaultBlurb = `Tell me the <b>piercing</b> (tragus, daith, septum) and <b>gauge</b> to tighten results.`;
    const sourceBlock = docHit ? `
      <div style="margin:6px 0; padding:8px; background:#fafafa; border:1px solid #eee; border-radius:8px">
        <div style="font-weight:600; margin-bottom:6px">From: <a href="${docHit.url}" target="_blank">${docHit.title}</a></div>
        <div style="font-size:13px">${docHit.snippet}...</div>
      </div>` : '';

    const fallback = (!inStock.length) ? `
      <div style="margin-top:8px">No in-stock matches yet. Try related categories:</div>
      <div><a target="_blank" href="${SITE}/search.asp?keyword=septum%20kit">Septum Kits</a></div>
      <div><a target="_blank" href="${SITE}/search.asp?keyword=tragus%20kit">Tragus Kits</a></div>
      <div><a target="_blank" href="${SITE}/Professional-Piercing-Kits_c_7.html">Professional Piercing Kits</a></div>
      <div><a target="_blank" href="${SITE}/Sterilized-Body-Jewelry_c_42.html">Sterilized Body Jewelry</a></div>
    ` : '';

    const html = `
      <div style="font-size:14px">
        ${safety}
        ${sourceBlock}
        <div style="margin:6px 0">${kb || defaultBlurb}</div>
        ${oosBlock}
        ${cards || `<div>No in-stock matches.</div>`}
        ${fallback}
      </div>`;

    res.json({ html });
  }catch(e){
    console.error('Chat error:', e);
    res.status(500).json({ html: 'Server error. Try again shortly.' });
  }
});

app.get('/hbj/health', (_,res)=>{
  const counts = {
    total: CATALOG.length,
    instock_true: CATALOG.filter(p=>p.instock===true).length,
    instock_false: CATALOG.filter(p=>p.instock===false).length,
    instock_unknown: CATALOG.filter(p=>p.instock==null).length,
    docs: DOCS.length
  };
  res.json({ ok:true, ...counts });
});

// ---------- Boot ----------
(async function boot(){
  await Promise.all([loadProductIndex(), loadPages()]);
  console.log('Boot complete');
})();

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`HBJ Assistant running on :${PORT}`));