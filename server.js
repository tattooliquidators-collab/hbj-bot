// server.js — HBJ Bot Hotfix v1.7.6
// Layout tweaks for visibility:
// - Results shown first (cards/gallery), CTAs BELOW results
// - Sticky Sterilized CTA at bottom so it doesn't scroll out of view
// - Long page snippet in <details>
// - Limit cards to 5

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
  'https://hottiebodyjewelry.com',
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
const STERILIZED_CAT = `${SITE}/Sterilized-Body-Jewelry_c_42.html`;
const PRO_KITS_CAT = `${SITE}/Professional-Piercing-Kits_c_7.html`;
const SAFE_KITS_CAT = `${SITE}/Safe-and-Sterile-Piercing-Kits_c_1.html`;
const AFTERCARE_URL = `${SITE}/Aftercare_ep_42-1.html`;
let DOCS = []; // {url, title, text, image}

// ---------- Rules / KB ----------
let RULES = { faqs:{}, promote_first:[] };
try { RULES = JSON.parse(fs.readFileSync('./rules.json','utf8')); } catch {}

// ---------- Pages config ----------
let PAGES = { pages: [] };
try { PAGES = JSON.parse(fs.readFileSync('./pages.json','utf8')); } catch {}

// ---------- Helpers ----------
function cleanText(t=''){ return t.replace(/\s+/g,' ').replace(/\u00a0/g,' ').trim(); }
function abs(url, base){ try { return new URL(url, base).href; } catch { return url; } }

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

async function get(url){
  const r = await fetch(url, { redirect: 'follow', headers: HEADERS });
  if (!r.ok) throw new Error(`GET ${url} ${r.status}`);
  return await r.text();
}

function extractImage($$ , pageUrl){
  let img = $$('meta[property="og:image"]').attr('content');
  if (img) return abs(img, pageUrl);
  img = $$('img[data-src]').first().attr('data-src') ||
        $$('img[data-original]').first().attr('data-original') ||
        $$('img[src*="/assets/images"]').first().attr('src') ||
        $$('img[src*="/images"]').first().attr('src') ||
        $$('img[src]').first().attr('src');
  return img ? abs(img, pageUrl) : '';
}

// Robust price finder: prefer schema/meta, else prefer "sale/now/your price", else pick the smallest $
function extractPrice($$){
  let content = $$('meta[itemprop="price"]').attr('content') ||
                $$('[itemprop=price]').first().text();
  if (content) {
    const m = (content.match(/[\d\.,]+/)||[])[0];
    if (m) return `$${m.replace(/,/g,'')}`;
  }
  const blocks = $$('[class*=Price], .price, .ProductPrice, #price, .sale, .SalePrice, .OurPrice, .retail, .RetailPrice');
  let candidates = [];
  blocks.each((_, el)=>{
    const txt = cleanText($$(el).text());
    const money = Array.from(txt.matchAll(/\$?\d{1,3}(?:,\d{3})*(?:\.\d{2})/g)).map(m=>m[0]);
    if (money.length){
      const label = txt.toLowerCase();
      money.forEach(val => {
        let score = 0;
        if (/sale|now|your price|our price|special/i.test(label)) score += 2;
        if (/retail|msrp|compare/i.test(label)) score -= 1;
        candidates.push({ val, score });
      });
    }
  });
  if (candidates.length){
    candidates.sort((a,b)=> (b.score - a.score) || (parseFloat(a.val.replace(/[$,]/g,'')) - parseFloat(b.val.replace(/[$,]/g,''))));
    const best = candidates[0].val;
    return best.startsWith('$') ? best : `$${best}`;
  }
  return '';
}

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

const SYN = {
  tragus: ['tragus'], daith: ['daith'], septum: ['septum','bull ring','bullring'],
  nose: ['nose','nostril','stud','hoop'], labret: ['labret','monroe'],
  eyebrow: ['eyebrow','brow'], tongue: ['tongue','barbell'],
  ring: ['ring','captive','captive bead','cbr','segment'],
  barbell: ['barbell','straight barbell','curved barbell','banana'],
  sterile: ['sterile','sterilized','pre-sterilized','pre sterilized','sterilization'],
  kit: ['kit','piercing kit','ear piercing kit','ear kit','ear-piercing kit','professional kit']
};
function parseGauge(q){ const m = q.match(/\b(10|12|14|16|18|20|22|8|6)\s*g\b/i); return m ? m[1] : null; }

function tokenOverlap(a,b){
  const A = new Set(a.toLowerCase().split(/\W+/).filter(x=>x.length>2));
  const B = new Set(b.toLowerCase().split(/\W+/).filter(x=>x.length>2));
  let hit = 0; for (const t of A) if (B.has(t)) hit++;
  return hit;
}
function looksDirectAsk(q, title){
  const explicit = /(out of stock|sold out|back.?in stock|restock|available|availability|in stock)/i.test(q);
  if (explicit) return true;
  return tokenOverlap(q, title) >= 3;
}

// ---------- Pages ingestion (with preview image) ----------
async function loadPages() {
  DOCS = [];
  for (const entry of (PAGES.pages || [])) {
    const url = entry.url; const selector = entry.selector || 'body';
    try {
      const h = await get(url);
      const $ = cheerio.load(h);
      const title = cleanText($('title').first().text()) || url;
      const text = cleanText($(selector).text());
      const image = (function(){
        let img = $('meta[property="og:image"]').attr('content') || $('img[src*="/assets/images"]').first().attr('src') || $('img[src]').first().attr('src');
        return img ? abs(img, url) : '';
      })();
      if (text && text.length > 200) DOCS.push({ url, title, text, image });
    } catch {}
  }
}
function scoreDoc(q, d){
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  let s = 0, hay = d.text.toLowerCase();
  for (const t of terms) if (hay.includes(t)) s += 2;
  if (/ship|delivery|return|refund/i.test(q) && /ship|return|refund/i.test(hay)) s += 5;
  if (/aftercare|after care|clean|saline|healing/i.test(q) && /aftercare|clean|saline|healing/i.test(hay)) s += 5;
  if (/steril/i.test(q) && /steril/i.test(hay)) s += 5;
  if (/kit/i.test(q) && /kit/i.test(hay)) s += 3;
  return s;
}
function searchDocs(q){
  if (!DOCS.length) return null;
  const ranked = DOCS.map(d => ({...d, score: scoreDoc(q,d)})).sort((a,b)=>b.score-a.score);
  const top = ranked[0]; if (!top || top.score<=0) return null;
  const need = q.split(/\s+/)[0].toLowerCase();
  const idx = Math.max(0, top.text.toLowerCase().indexOf(need));
  const start = Math.max(0, idx - 260), end = Math.min(top.text.length, start+800);
  const snippet = top.text.slice(start, end);
  return { title: top.title, url: top.url, snippet, image: top.image };
}

// ---------- Product harvesting ----------
function looksProductHref(href=''){
  return /_p_\d+(\.html)?|\/p-\d+|ProductDetails\.asp|product\.asp|\/product\/\d+/i.test(href);
}
async function harvestProductsFromCategory(categoryUrl){
  const out = [];
  try {
    const h = await get(categoryUrl);
    const $ = cheerio.load(h);
    const links = new Set();
    $('a').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (looksProductHref(href)) links.add(abs(href, categoryUrl));
    });
    for (const link of Array.from(links).slice(0, 30)) {
      try {
        const ph = await get(link);
        const $$ = cheerio.load(ph);
        const title = cleanText($$('h1').first().text()) || cleanText($$('title').first().text()) || 'Product';
        const price = extractPrice($$);
        const image = extractImage($$, link);
        const instock = detectStock($$);
        out.push({ title, url: link, price, image, instock });
      } catch {}
    }
  } catch {}
  return out;
}

// ---------- On-demand product search ----------
function expandQuery(q){
  let add = [];
  for (const k in SYN) if (SYN[k].some(t=>q.toLowerCase().includes(t))) add.push(k);
  const g = parseGauge(q); if (g) add.push(`${g}g`);
  return `${q} ${add.join(' ')}`.trim();
}
async function searchProductsOnDemand(q){
  const q2 = expandQuery(q);
  const url = `${SITE}/search.asp?keyword=${encodeURIComponent(q2)}`;
  let items = [];
  try {
    const html = await get(url);
    const $ = cheerio.load(html);
    const links = new Set();
    $('a').each((_, a) => {
      const href = $(a).attr('href') || '';
      const text = cleanText($(a).text() || '');
      if (looksProductHref(href) && text.length >= 1) links.add(abs(href, SITE));
    });
    for (const link of Array.from(links).slice(0, 18)) {
      try {
        const ph = await get(link);
        const $$ = cheerio.load(ph);
        const title = cleanText($$('h1').first().text()) || cleanText($$('title').first().text()) || 'Product';
        const price = extractPrice($$);
        const image = extractImage($$, link);
        const instock = detectStock($$);
        items.push({ title, url: link, price, image, instock });
      } catch {}
    }
  } catch {}
  return items;
}

function scoreAgainstQuery(q, p){
  let s = 0;
  const t = p.title.toLowerCase(), ql = q.toLowerCase();
  for (const w of ql.split(/\s+/)) if (w && t.includes(w)) s += 1;
  for (const k in SYN) if (SYN[k].some(tk => ql.includes(tk) && t.includes(tk))) s += 2;
  const g = parseGauge(q); if (g && t.includes(`${g}g`)) s += 3;
  if (/kit\b/i.test(ql) && /kit\b/i.test(t)) s += 4;
  if (/steril/i.test(ql) && /steril/i.test(t)) s += 6; // boost sterile
  return s;
}

// ---------- Route ----------
app.post('/hbj/chat', async (req, res) => {
  try {
    let q = (req.body.q||'').toString().trim();
    const page = (req.body.page||'').toString();

    if (/septum/i.test(page)) q += ' septum';
    if (/tragus/i.test(page)) q += ' tragus';
    if (/nose/i.test(page)) q += ' nose';

    const looksHowTo = /(how to|tutorial|step by step|pierce.*myself)/i.test(q);
    const safety = looksHowTo ? `<div style="margin:8px 0; font-size:12px; opacity:.8">Educational info only. We don’t endorse self-piercing. Consider a licensed professional.</div>` : '';

    // Docs & KB
    const docHit = searchDocs(q);
    const norm = q.toLowerCase().replace(/[^\w\s]/g,'').trim();
    let kb = null;
    for (const key of Object.keys(RULES.faqs||{})) if (norm.includes(key)) { kb = RULES.faqs[key]; break; }

    // Products via on-demand search
    let items = await searchProductsOnDemand(q);

    // Sterile: always harvest the category when mentioned and build a dedicated gallery
    const mentionSterile = /steril/i.test(q);
    let sterileHarvest = [];
    if (mentionSterile) {
      sterileHarvest = await harvestProductsFromCategory(STERILIZED_CAT);
      const urls = new Set(items.map(i=>i.url));
      for (const it of sterileHarvest) if (!urls.has(it.url)) items.push(it);
    }

    // Score and split
    const ranked = items.map(p => ({...p, score: scoreAgainstQuery(q, p)})).sort((a,b)=>b.score-a.score);
    const sterileFirst = mentionSterile
      ? ranked.sort((a,b)=> (b.title.toLowerCase().includes('steril') - a.title.toLowerCase().includes('steril')) || (b.score - a.score))
      : ranked;

    const inStock = sterileFirst.filter(p => p.instock !== false).slice(0, 5);
    const oos = sterileFirst.filter(p => p.instock === false).slice(0, 6);

    const cards = inStock.map(p => `
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

    // Only show OOS if explicitly asked or exact product
    let oosBlock = '';
    const directOOS = oos.filter(p => looksDirectAsk(q, p.title)).slice(0,2);
    if (directOOS.length){
      oosBlock = `
      <div style="margin-top:10px; font-weight:600">Requested item (currently out of stock):</div>
      ${directOOS.map(p => `
        <div style="border:1px dashed #f2a; border-radius:12px; padding:10px; margin:6px 0; display:flex; gap:10px; align-items:center; opacity:.85">
          ${p.image ? `<img src="${p.image}" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:8px">` : ''}
          <div style="flex:1">
            <div style="font-weight:600">${p.title} <span style="color:#b00; font-weight:700">— Out of stock</span></div>
            ${p.price ? `<div style="opacity:.85; margin-top:4px">${p.price}</div>` : ''}
            <div style="margin-top:6px"><a href="${p.url}" target="_blank" style="text-decoration:underline">View product page</a></div>
          </div>
        </div>
      `).join('')}`;
    }

    // Sterile gallery (from category only), in-stock only
    let sterileGallery = '';
    if (mentionSterile && sterileHarvest.length){
      const sterileInstock = sterileHarvest.filter(p => p.instock !== false).slice(0, 8);
      if (sterileInstock.length){
        sterileGallery = `
          <div style="margin:8px 0; font-weight:700">Sterilized Body Jewelry</div>
          <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap:10px">
            ${sterileInstock.map(p => `
              <a href="${p.url}" target="_blank" style="text-decoration:none;color:inherit">
                <div style="border:1px solid #eee;border-radius:12px;padding:10px;">
                  ${p.image ? `<img src="${p.image}" alt="" style="width:100%;height:120px;object-fit:cover;border-radius:8px">` : ''}
                  <div style="font-weight:600; margin-top:8px; font-size:13px; line-height:1.2">${p.title}</div>
                  ${p.price ? `<div style="opacity:.85; margin-top:4px">${p.price}</div>` : ''}
                </div>
              </a>
            `).join('')}
          </div>`;
      }
    }

    // CTAs with exact links — now BELOW results
    const sterileCTA = mentionSterile ? `
      <div style="margin:10px 0 0 0">
        <a href="${STERILIZED_CAT}" target="_blank"
           style="display:inline-block; background:#111; color:#fff; padding:10px 14px; border-radius:10px; text-decoration:none; font-weight:600">
          Browse Sterilized Body Jewelry
        </a>
      </div>` : '';

    const wantAftercare = /(aftercare|after care|care instructions|clean|saline|healing)/i.test(q);
    const aftercareCTA = wantAftercare ? `
      <div style="margin:10px 0 0 0">
        <a href="${AFTERCARE_URL}" target="_blank"
           style="display:inline-block; background:#111; color:#fff; padding:10px 14px; border-radius:10px; text-decoration:none; font-weight:600">
          Read Aftercare Instructions
        </a>
      </div>` : '';

    // Sticky bar (Sterilized) to keep CTA visible
    const stickyCTA = mentionSterile ? `
      <div style="position: sticky; bottom: 4px; z-index: 5; padding-top:8px">
        <a href="${STERILIZED_CAT}" target="_blank"
           style="display:inline-block; background:#111; color:#fff; padding:10px 14px; border-radius:10px; text-decoration:none; font-weight:700; box-shadow: 0 2px 8px rgba(0,0,0,.15)">
          Browse Sterilized Body Jewelry
        </a>
      </div>` : '';

    // Collapsible source details to avoid pushing CTAs out of view
    const sourceBlock = (function(){
      if (!docHit) return '';
      return `
        <details style="margin:8px 0; border:1px solid #eee; border-radius:10px; padding:10px; background:#fafafa">
          <summary style="cursor:pointer; font-weight:600">More info from: ${docHit.title}</summary>
          <div style="display:flex; gap:10px; align-items:center; margin-top:8px">
            ${docHit.image ? `<img src="${docHit.image}" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:8px">` : ''}
            <div style="flex:1">
              <div style="font-size:13px; margin-bottom:6px">${docHit.snippet}...</div>
              <a href="${docHit.url}" target="_blank" style="text-decoration:underline">Open page</a>
            </div>
          </div>
        </details>`;
    })();

    const defaultBlurb = `Tell me the <b>piercing</b> (tragus, daith, septum) and <b>gauge</b> to tighten results.`;

    // NEW ORDER: message/kb → results (gallery + oos + cards) → CTAs → sticky → details
    const html = `
      <div style="font-size:14px">
        <div style="margin:6px 0">${kb || defaultBlurb}</div>
        ${sterileGallery}
        ${oosBlock}
        ${cards}
        ${sterileCTA}
        ${aftercareCTA}
        ${stickyCTA}
        ${sourceBlock}
        ${safety}
      </div>`;

    res.json({ html });
  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ html: 'Server error. Try again shortly.' });
  }
});

// Probes for quick verification
app.get('/hbj/probe', async (req, res) => {
  try {
    const type = (req.query.type || 'sterile').toString();
    let url = STERILIZED_CAT;
    if (type === 'prokits') url = PRO_KITS_CAT;
    if (type === 'safekits') url = SAFE_KITS_CAT;
    const items = await harvestProductsFromCategory(url);
    res.json({ ok: true, type, count: items.length, sample: items.slice(0,8) });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.get('/hbj/health', (_,res)=>{
  res.json({ ok:true, docs: DOCS.length });
});

// ---------- Boot ----------
(async function boot(){
  await loadPages();
  console.log('HBJ Bot Hotfix v1.7.6 booted. Docs:', DOCS.length);
})();

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`HBJ Assistant running on :${PORT}`));