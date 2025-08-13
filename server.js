
// server.js — HBJ Bot v1.9.0
// Fix: Course URL is hard-guarded. If rules.json is missing or has a truncated value
// (e.g., ends at ...COMING), we FORCE the canonical URL:
// https://www.hottiebodyjewelry.com/Master-Body-Piercing-Class-COMING-SOON_p_363.html
// Also retains: kit flow question-only; sterilized/aftercare/shipping as before.

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
app.use(cors({ origin: (origin, cb) => (!origin || ALLOWED_ORIGINS.includes(origin)) ? cb(null, true) : cb(null, false) }));

// ---------- Globals ----------
const SITE = 'https://www.hottiebodyjewelry.com';
const HOME = SITE + '/';
const STERILIZED_CAT = `${SITE}/Sterilized-Body-Jewelry_c_42.html`;
const PRO_KITS_CAT = `${SITE}/Professional-Piercing-Kits_c_7.html`;
const SAFE_KITS_CAT = `${SITE}/Safe-and-Sterile-Piercing-Kits_c_1.html`;
const AFTERCARE_URL = `${SITE}/Aftercare_ep_42-1.html`;
const SHIPPING_URL = `${SITE}/Shipping-and-Returns_ep_43-1.html`;
const ABOUT_URL = `${SITE}/About-Us_ep_7.html`;
const CONTACT_URL = `${SITE}/crm.asp?action=contactus`;

let DOCS = []; // {url, title, text, image}

// ---------- Rules / KB ----------
let RULES = { faqs:{}, promote_first:[], aliases:{}, course_url:'' };
try { RULES = JSON.parse(fs.readFileSync('./rules.json','utf8')); } catch {}

// Canonical course URL guard
const CANON_COURSE = 'https://www.hottiebodyjewelry.com/Master-Body-Piercing-Class-COMING-SOON_p_363.html';
function normalizeCourseUrl(raw) {
  const v = (raw||'').trim();
  if (!v) return CANON_COURSE;
  // If it looks like the COMING slug but isn't the full page, force canonical
  if (/Master-Body-Piercing-Class-COMING($|[^-S])/.test(v)) return CANON_COURSE;
  // If it doesn't end with .html, or isn't _p_363, also force canonical
  if (!/\.html($|\?)/i.test(v)) return CANON_COURSE;
  if (!/_p_363\.html($|\?)/.test(v)) return CANON_COURSE;
  return v;
}

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

async function getPreview(url){
  try{
    const h = await get(url);
    const $ = cheerio.load(h);
    const title = cleanText($('title').first().text()) || url;
    let img = $('meta[property="og:image"]').attr('content') ||
              $('img[data-src]').first().attr('data-src') ||
              $('img[src*="/assets/images"]').first().attr('src') ||
              $('img[src]').first().attr('src') || '';
    if (img) img = abs(img, url);
    return { title, image: img };
  }catch{
    return { title: url, image: '' };
  }
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

// Robust price finder
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
  kit: ['kit','piercing kit','ear piercing kit','ear kit','ear-piercing kit','professional kit'],
  course: ['course','training','class','apprentice','certification','master class']
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

// ---------- Pages ingestion ----------
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
  if (/ship|delivery|return|refund|exchange/i.test(q) && /ship|return|refund|exchange/i.test(hay)) s += 5;
  if (/aftercare|after care|clean|saline|healing/i.test(q) && /aftercare|clean|saline|healing/i.test(hay)) s += 5;
  if (/steril/i.test(q) && /steril/i.test(hay)) s += 5;
  if (/kit/i.test(q) && /kit/i.test(hay)) s += 3;
  if (/course|training|apprentice|class|certification/i.test(q) && /course|training|apprentice|class|certification/i.test(hay)) s += 4;
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

// Pull kits from Home "Home Specials"/featured area
async function harvestHomeSpecialKits(){
  const out = [];
  try {
    const h = await get(HOME);
    const $ = cheerio.load(h);
    const links = new Set();
    $('a').each((_, a) => {
      const href = $(a).attr('href') || '';
      const text = cleanText($(a).text() || '');
      if (looksProductHref(href) && (/kit/i.test(text) || $(a).closest('section, div').text().toLowerCase().includes('home specials') || $(a).closest('section, div').text().toLowerCase().includes('special'))) {
        links.add(abs(href, HOME));
      }
    });
    if (links.size < 6) {
      $('a').each((_, a) => {
        const href = $(a).attr('href') || '';
        if (looksProductHref(href)) links.add(abs(href, HOME));
      });
    }
    for (const link of Array.from(links).slice(0, 24)) {
      try {
        const ph = await get(link);
        const $$ = cheerio.load(ph);
        const title = cleanText($$('h1').first().text()) || cleanText($$('title').first().text()) || 'Product';
        if (!/kit/i.test(title)) continue; // only kits
        const price = extractPrice($$);
        const image = extractImage($$, link);
        const instock = detectStock($$);
        out.push({ title, url: link, price, image, instock });
      } catch {}
    }
  } catch {}
  const seen = new Set(); const uniq = [];
  for (const p of out) { if (seen.has(p.url)) continue; seen.add(p.url); uniq.push(p); }
  return uniq;
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
  if (/steril/i.test(ql) && /steril/i.test(t)) s += 6;
  if (/course|training|class/i.test(ql) && /course|training|class/i.test(t)) s += 5;
  return s;
}

// ---------- Intents ----------
function intentOf(q){
  const s = q.toLowerCase();
  if (/(shipping|returns?|return policy|refund|exchange|delivery|how long.*ship|ship.*time)/i.test(s)) return 'shipping';
  if (/(aftercare|after care|care instructions|clean|saline|healing)/i.test(s)) return 'aftercare';
  if (/steril/i.test(s)) return 'sterile';
  if (/(course|training|apprentice|class|master class|certification)/i.test(s)) return 'course';
  if (/\bkit(s)?\b/i.test(s)) return 'kit';
  return 'general';
}

// ---------- Route ----------
async function respondForQuery(q){
  let qq = (q||'').toString().trim();
  const it = intentOf(qq);

  let items = [];
  if (it === 'general' || it === 'sterile') {
    items = await searchProductsOnDemand(qq);
  }

  let sterileHarvest = [];
  if (it === 'sterile') {
    sterileHarvest = await harvestProductsFromCategory(STERILIZED_CAT);
    const urls = new Set(items.map(i=>i.url));
    for (const itx of sterileHarvest) if (!urls.has(itx.url)) items.push(itx);
  }

  let homeKits = [];
  if (it === 'kit') {
    homeKits = await harvestHomeSpecialKits();
  }

  const ranked = items.map(p => ({...p, score: scoreAgainstQuery(qq, p)})).sort((a,b)=>b.score-a.score);

  let topPanel = '';
  let footer = '';

  if (it === 'kit') {
    const kitsInStock = (homeKits||[]).filter(p => p.instock !== false).slice(0, 10);
    if (kitsInStock.length){
      topPanel = `
        <div style="margin:4px 0 8px 0; font-weight:800">Piercing Kits — Home Specials</div>
        <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap:10px">
          ${kitsInStock.map(p => `
            <a href="${p.url}" target="_blank" style="text-decoration:none;color:inherit">
              <div style="border:1px solid #eee;border-radius:12px;padding:10px;">
                ${p.image ? `<img src="${p.image}" alt="" style="width:100%;height:120px;object-fit:cover;border-radius:8px">` : ''}
                <div style="font-weight:600; margin-top:8px; font-size:13px; line-height:1.2">${p.title}</div>
                ${p.price ? `<div style="opacity:.85; margin-top:4px">${p.price}</div>` : ''}
              </div>
            </a>
          `).join('')}
        </div>`;
    } else {
      topPanel = `<div style="margin:4px 0 8px 0;">Looking for a piercing kit? Tell me the piercing and I’ll show options.</div>`;
    }
    footer = `
      <div style="margin-top:10px; padding:10px; border:1px dashed #ddd; border-radius:10px; background:#fff">
        <div style="font-weight:700;">What kind of piercing kit are you looking for?</div>
      </div>`;
  } else if (it === 'sterile') {
    const sterileInstock = (sterileHarvest||[]).filter(p => p.instock !== false).slice(0, 10);
    if (sterileInstock.length){
      topPanel = `
        <div style="margin:4px 0 8px 0; font-weight:800">Sterilized Body Jewelry</div>
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
      const sterileCompact = sterileInstock.slice(0,3).map(p => `
        <a href="${p.url}" target="_blank" style="text-decoration:none;color:inherit">
          <div style="display:flex; gap:8px; align-items:center; padding:6px 0; border-top:1px solid #f2f2f2">
            ${p.image ? `<img src="${p.image}" alt="" style="width:42px;height:42px;object-fit:cover;border-radius:6px">` : ''}
            <div style="flex:1; font-size:13px; line-height:1.25">
              <div style="font-weight:600">${p.title}</div>
              ${p.price ? `<div style="opacity:.85; margin-top:2px">${p.price}</div>` : ''}
            </div>
          </div>
        </a>`).join('');
      footer = `
        <div style="margin-top:10px; padding:10px; border:1px solid #eee; border-radius:10px; background:#fff">
          <div style="font-weight:800; margin-bottom:6px">Top Sterilized Picks</div>
          ${sterileCompact}
          <div style="margin-top:8px">
            <a href="${STERILIZED_CAT}" target="_blank"
               style="display:inline-block; background:#111; color:#fff; padding:10px 14px; border-radius:10px; text-decoration:none; font-weight:700">
              Open Full Sterilized Category
            </a>
          </div>
        </div>`;
    }
  } else if (it === 'aftercare') {
    const top = `
      <div style="margin:4px 0 8px 0; padding:10px; border:1px solid #eee; border-radius:10px; background:#fafafa">
        <div style="font-weight:800; margin-bottom:6px">Aftercare Essentials</div>
        <div style="font-size:13px; line-height:1.45">Rinse twice daily with sterile saline. Avoid twisting the jewelry. Sleep on clean linens and avoid pools/hot tubs for at least 2 weeks.</div>
      </div>`;
    const foot = `
      <div style="margin-top:10px; padding:10px; border:1px solid #eee; border-radius:10px; background:#fff">
        <div style="font-weight:800; margin-bottom:6px">Aftercare Quick Tips</div>
        <ul style="padding-left:18px; margin:0; font-size:13px; line-height:1.45">
          <li>Rinse twice daily with sterile saline.</li>
          <li>Don’t twist or rotate jewelry.</li>
          <li>Sleep on clean linens; avoid pools/hot tubs for 2 weeks.</li>
        </ul>
        <div style="margin-top:8px">
          <a href="${AFTERCARE_URL}" target="_blank"
             style="display:inline-block; background:#111; color:#fff; padding:10px 14px; border-radius:10px; text-decoration:none; font-weight:700">
            Open Full Aftercare Page
          </a>
        </div>
      </div>`;
    return `
      <div style="font-size:14px">
        ${top}
        ${foot}
      </div>`;
  } else if (it === 'shipping') {
    const top = `
      <div style="margin:4px 0 8px 0; padding:10px; border:1px solid #eee; border-radius:10px; background:#fafafa">
        <div style="font-weight:800; margin-bottom:6px">Shipping & Returns</div>
        <div style="font-size:13px; line-height:1.45">
          Most orders ship within 1 business day. Returns are limited to unopened/unused items within 7 days; sterile kits are final sale.
        </div>
      </div>`;
    const foot = `
      <div style="margin-top:10px; padding:10px; border:1px solid #eee; border-radius:10px; background:#fff">
        <div style="font-weight:800; margin-bottom:6px">Need details?</div>
        <div style="font-size:13px; line-height:1.45">See full policy, carriers, and timelines.</div>
        <div style="margin-top:8px">
          <a href="${SHIPPING_URL}" target="_blank"
             style="display:inline-block; background:#111; color:#fff; padding:10px 14px; border-radius:10px; text-decoration:none; font-weight:700">
            Open Shipping & Returns Page
          </a>
        </div>
      </div>`;
    return `
      <div style="font-size:14px">
        ${top}
        ${foot}
      </div>`;
  } else if (it === 'course') {
    let courseUrl = normalizeCourseUrl((RULES.course_url||'').trim());
    const prev = await getPreview(courseUrl);
    const top = `
      <div style="margin:4px 0 8px 0; padding:10px; border:1px solid #eee; border-radius:10px; background:#fafafa; display:flex; gap:10px; align-items:center">
        ${prev.image ? `<img src="${prev.image}" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:8px">` : ''}
        <div style="flex:1">
          <div style="font-weight:800; margin-bottom:2px">Master Body Piercing Course</div>
          <div style="font-size:13px; line-height:1.45">Per owner exception: opening the course page even if it’s out of stock/unavailable.</div>
        </div>
      </div>`;
    const foot = `
      <div style="margin-top:10px; padding:10px; border:1px solid #eee; border-radius:10px; background:#fff">
        <div style="font-weight:800; margin-bottom:6px">Open Course Page</div>
        <a href="${courseUrl}" target="_blank"
           style="display:inline-block; background:#111; color:#fff; padding:10px 14px; border-radius:10px; text-decoration:none; font-weight:700">
          Go to Course
        </a>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px">
          <a href="${ABOUT_URL}" target="_blank" style="flex:1 1 180px; text-align:center; text-decoration:underline">About Us</a>
          <a href="${CONTACT_URL}" target="_blank" style="flex:1 1 180px; text-align:center; text-decoration:underline">Contact / Interest List</a>
        </div>
      </div>`;
    return `
      <div style="font-size:14px">
        ${top}
        ${foot}
      </div>`;
  }

  // Default compose (sterile/general/kit)
  const html = `
    <div style="font-size:14px">
      ${topPanel}
      ${footer}
    </div>`;
  return html;
}

app.post('/hbj/chat', async (req, res) => {
  try {
    const q = (req.body.q||'').toString().trim();
    const html = await respondForQuery(q);
    res.json({ html });
  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ html: 'Server error. Try again shortly.' });
  }
});

app.get('/hbj/probe', async (req, res) => {
  try {
    const type = (req.query.type || 'sterile').toString();
    if (type === 'course') {
      const course_url = normalizeCourseUrl((RULES.course_url||'').trim());
      return res.json({ ok:true, type, course_url });
    }
    if (type === 'shipping') return res.json({ ok:true, type, url: SHIPPING_URL });
    if (type === 'homespecials') {
      const kits = await harvestHomeSpecialKits();
      return res.json({ ok:true, type, count: kits.length, sample: kits.slice(0,8) });
    }
    if (type === 'kit') {
      const html = await respondForQuery('piercing kit');
      return res.json({ ok:true, type, html });
    }
    let url = STERILIZED_CAT;
    if (type === 'prokits') url = PRO_KITS_CAT;
    if (type === 'safekits') url = SAFE_KITS_CAT;
    const items = await harvestProductsFromCategory(url);
    res.json({ ok: true, type, count: items.length, sample: items.slice(0,10) });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.get('/hbj/health', (_,res)=> res.json({ ok:true, docs: DOCS.length, version: '1.9.0' }));

// ---------- Boot ----------
(async function boot(){ await loadPages(); console.log('HBJ Bot v1.9.0 booted. Docs:', DOCS.length); })();

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`HBJ Assistant running on :${PORT}`));
