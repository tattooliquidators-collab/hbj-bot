
// server.js — HBJ Bot v1.9.6
// Changes:
//  • UI uses DIRECT STORE LINKS ONLY (no /hbj/out, no /hbj/course in anchors) → eliminates 404 from wrong host
//  • Strong inline styles with !important on CTAs/links for readability
//  • 1‑word kit intents (nose, ear, nipple, clit, genital, etc.)
//  • Perf caching retained; course link HEAD-checked server‑side to avoid dead URL

import express from 'express';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import cors from 'cors';
import compression from 'compression';
import fs from 'fs';

dotenv.config();
const app = express();
app.use(express.json());
app.use(compression());

// ---------- CORS ----------
const ALLOWED_ORIGINS = [
  'https://www.hottiebodyjewelry.com',
  'https://hottiebodyjewelry.com',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
];
app.use(cors({ origin: (origin, cb) => (!origin || ALLOWED_ORIGINS.includes(origin)) ? cb(null, true) : cb(null, false) }));

// ---------- Constants ----------
const SITE = 'https://www.hottiebodyjewelry.com';
const HOME = SITE + '/';
const STERILIZED_CAT = `${SITE}/Sterilized-Body-Jewelry_c_42.html`;
const PRO_KITS_CAT   = `${SITE}/Professional-Piercing-Kits_c_7.html`;
const SAFE_KITS_CAT  = `${SITE}/Safe-and-Sterile-Piercing-Kits_c_1.html`;
const AFTERCARE_URL  = `${SITE}/Aftercare_ep_42-1.html`;
const SHIPPING_URL   = `${SITE}/Shipping-and-Returns_ep_43-1.html`;
const ABOUT_URL      = `${SITE}/About-Us_ep_7.html`;
const CONTACT_URL    = `${SITE}/crm.asp?action=contactus`;

// ---------- Rules ----------
let RULES = { course_url: '' };
try { RULES = JSON.parse(fs.readFileSync('./rules.json','utf8')); } catch {}

// Canonical course URL guard
const CANON_COURSE = '__CANON__';
function normalizeCourseUrl(raw) {
  const v = (raw||'').trim();
  if (!v) return CANON_COURSE;
  if (/Master-Body-Piercing-Class-COMING($|[^-S])/.test(v)) return CANON_COURSE;
  if (!/\.html($|\?)/i.test(v)) return CANON_COURSE;
  if (!/_p_363\.html($|\?)/.test(v)) return CANON_COURSE;
  return v;
}

// ---------- Helpers ----------
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

function cleanText(t=''){ return t.replace(/\s+/g,' ').replace(/\u00a0/g,' ').trim(); }
function abs(url, base){ try { return new URL(url, base).href; } catch { return url; } }

function utmize(rawUrl, campaign='chat', extra={}){
  try{
    const u = new URL(rawUrl);
    u.searchParams.set('utm_source','hbjbot');
    u.searchParams.set('utm_medium','chat');
    u.searchParams.set('utm_campaign', campaign);
    for (const [k,v] of Object.entries(extra||{})) if (v!=null) u.searchParams.set(k, String(v));
    return u.toString();
  }catch{ return rawUrl; }
}

async function headOk(url){
  try {
    const r = await fetch(url, { method:'HEAD', redirect:'follow', headers: HEADERS });
    return r.ok;
  } catch { return false; }
}

// Simple TTL cache
function makeCache(){ return new Map(); }
function cacheGet(map, key, maxAgeMs){
  const v = map.get(key);
  if (!v) return null;
  if ((Date.now() - v.t) > maxAgeMs) { map.delete(key); return null; }
  return v.value;
}
function cacheSet(map, key, value){ map.set(key, { t: Date.now(), value }); }
const CACHE = { page: makeCache(), category: makeCache(), homespecials: makeCache(), chat: makeCache() };

async function get(url, ttlMs=5*60*1000){
  const cached = cacheGet(CACHE.page, url, ttlMs);
  if (cached) return cached;
  const r = await fetch(url, { redirect:'follow', headers: HEADERS });
  if (!r.ok) throw new Error(`GET ${url} ${r.status}`);
  const txt = await r.text();
  cacheSet(CACHE.page, url, txt);
  return txt;
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

function looksProductHref(href=''){ return /_p_\d+(\.html)?|\/p-\d+|ProductDetails\.asp|product\.asp|\/product\/\d+/i.test(href); }
function parseListing($, baseUrl){
  const items = [];
  const cards = $('a, div');
  const seen = new Set();
  cards.each((_, el) => {
    const $el = $(el);
    let href = $el.attr('href') || $el.find('a').attr('href') || '';
    if (!href || !looksProductHref(href)) return;
    const url = abs(href, baseUrl);
    if (seen.has(url)) return;
    let title = cleanText($el.attr('title') || $el.find('h3,h2,.name,.ProductName,.productname').first().text() || $el.text()).slice(0,120);
    title = title || 'Product';
    let price = cleanText($el.find('.SalePrice,.OurPrice,.price,.Price,.product-price').first().text());
    const imgEl = $el.find('img').first();
    let image = imgEl.attr('data-src') || imgEl.attr('src') || '';
    if (image) image = abs(image, baseUrl);
    items.push({ title, url, price, image });
    seen.add(url);
  });
  return items.filter(it => it.title && it.url).slice(0, 24);
}

async function harvestProductsFromCategory(categoryUrl){
  const cached = cacheGet(CACHE.category, categoryUrl, 15*60*1000);
  if (cached) return cached;
  const out = [];
  try {
    const h = await get(categoryUrl, 10*60*1000);
    const $ = cheerio.load(h);
    let items = parseListing($, categoryUrl);
    const needEnrich = items.filter(it => !it.price || !it.image).slice(0, 8).map(it => it.url);
    const enrichPages = await Promise.all(needEnrich.map(async (link) => {
      try {
        const ph = await get(link, 20*60*1000);
        const $$ = cheerio.load(ph);
        const title = cleanText($$('h1').first().text()) || cleanText($$('title').first().text()) || 'Product';
        const price = extractPrice($$);
        const image = extractImage($$, link);
        const instock = detectStock($$);
        return { title, url: link, price, image, instock };
      } catch { return null; }
    }));
    const byUrl = new Map(items.map(it => [it.url, it]));
    for (const p of enrichPages) if (p) byUrl.set(p.url, { ...byUrl.get(p.url), ...p });
    for (const v of byUrl.values()) out.push(v);
  } catch {}
  cacheSet(CACHE.category, categoryUrl, out);
  return out;
}

async function harvestHomeSpecialKits(){
  const cached = cacheGet(CACHE.homespecials, 'homespecials', 10*60*1000);
  if (cached) return cached;
  const out = [];
  try {
    const h = await get(HOME, 5*60*1000);
    const $ = cheerio.load(h);
    const items = parseListing($, HOME).filter(it => /kit/i.test(it.title));
    const links = items.slice(0, 12).map(it => it.url);
    const pages = await Promise.all(links.map(async (link) => {
      try {
        const ph = await get(link, 20*60*1000);
        const $$ = cheerio.load(ph);
        const title = cleanText($$('h1').first().text()) || cleanText($$('title').first().text()) || 'Product';
        const price = extractPrice($$);
        const image = extractImage($$, link);
        const instock = detectStock($$);
        return { title, url: link, price, image, instock };
      } catch { return null; }
    }));
    for (const p of pages) if (p) out.push(p);
  } catch {}
  cacheSet(CACHE.homespecials, 'homespecials', out);
  return out;
}

// ---------- Intents ----------
const KIT_WORDS = new Set([
  'ear','nose','nostril','septum','tragus','daith','rook','industrial','eyebrow','brow',
  'tongue','lip','labret','monroe','smiley','frenulum','medusa','philtrum',
  'navel','belly','bellybutton','belly-button',
  'nipple','genital','clit','clitoral','vch','hch','christina','prince','apadravya','ampallang'
]);
function intentOf(q){
  const s = q.toLowerCase().trim();
  if (/(shipping|returns?|return policy|refund|exchange|delivery|how long.*ship|ship.*time)/i.test(s)) return 'shipping';
  if (/(aftercare|after care|care instructions|clean|saline|healing)/i.test(s)) return 'aftercare';
  if (/steril/i.test(s)) return 'sterile';
  if (/(course|training|apprentice|class|master class|certification)/i.test(s)) return 'course';
  if (/\bkit(s)?\b/i.test(s)) return 'kit';
  const words = s.split(/\s+/).filter(Boolean);
  const oneWord = words.length <= 2 && words.every(w => w.length <= 12);
  if (oneWord && words.some(w => KIT_WORDS.has(w))) return 'kit_type';
  return 'general';
}

// ---------- UI helpers ----------
function shell(body){
  const style = `
    <style>
      .hbj-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap:10px; }
      @media (max-width:520px) { .hbj-grid { grid-template-columns: repeat(2, 1fr) !important; } }
      .hbj-card { border:1px solid #eee; border-radius:12px; padding:10px; background:#fff; }
      .hbj-title { font-weight:700; margin-top:8px; font-size:13px; line-height:1.25; color:#111; }
    </style>`;
  return `<div style="font-size:14px">${style}${body}</div>`;
}
function cta(href, label){
  const u = utmize(href, 'cta');
  return `<a href="${u}" target="_blank" rel="nofollow noopener" style="display:inline-block;background:#0b5fff!important;color:#fff!important;padding:10px 14px;border-radius:10px;text-decoration:none!important;font-weight:800!important;box-shadow:0 1px 0 rgba(0,0,0,.1);">${label}</a>`;
}
function linkTxt(href, label){
  const u = utmize(href, 'link');
  return `<a href="${u}" target="_blank" rel="nofollow noopener" style="color:#0b5fff!important;text-decoration:underline!important;font-weight:700!important;">${label}</a>`;
}

// ---------- Composers ----------
async function composeKitQuestion(){
  const homeKits = await harvestHomeSpecialKits();
  const kitsInStock = (homeKits||[]).filter(p => p.instock !== false).slice(0, 10);
  const grid = kitsInStock.length ? `
    <div style="margin:4px 0 8px 0; font-weight:800">Piercing Kits — Home Specials</div>
    <div class="hbj-grid">
      ${kitsInStock.map(p => `
        <a href="${utmize(p.url,'kit_card')}" target="_blank" rel="nofollow noopener" style="text-decoration:none;color:inherit">
          <div class="hbj-card">
            ${p.image ? `<img src="${p.image}" alt="" style="width:100%;height:120px;object-fit:cover;border-radius:8px">` : ''}
            <div class="hbj-title">${p.title}</div>
            ${p.price ? `<div style="opacity:.9;margin-top:4px">${p.price}</div>` : ''}
          </div>
        </a>
      `).join('')}
    </div>` : ``;
  const footer = `
    <div style="margin-top:10px; padding:10px; border:1px dashed #ddd; border-radius:10px; background:#fff">
      <div style="font-weight:800;">What kind of piercing kit are you looking for?</div>
      <div style="font-size:12px;color:#333">Reply with one word: nose, ear, septum, nipple, clit, genital, tongue…</div>
    </div>`;
  return shell(`${grid}${footer}`);
}

async function searchProducts(q){
  const url = `${SITE}/search.asp?keyword=${encodeURIComponent(q)}`;
  const html = await get(url, 5*60*1000);
  const $ = cheerio.load(html);
  let items = parseListing($, url);
  // Enrich a few
  const enrich = items.slice(0, 8).map(it => it.url);
  const pages = await Promise.all(enrich.map(async (link) => {
    try{
      const ph = await get(link, 20*60*1000);
      const $$ = cheerio.load(ph);
      const title = cleanText($$('h1').first().text()) || cleanText($$('title').first().text()) || 'Product';
      const price = extractPrice($$);
      const image = extractImage($$, link);
      const instock = detectStock($$);
      return { title, url: link, price, image, instock };
    }catch{ return null; }
  }));
  const byUrl = new Map(items.map(it => [it.url, it]));
  for (const p of pages) if (p) byUrl.set(p.url, { ...byUrl.get(p.url), ...p });
  return Array.from(byUrl.values());
}

async function composeKitType(word){
  const items0 = await searchProducts(`${word} piercing kit`);
  let items = items0.filter(p => /kit/i.test(p.title||'')).filter(p => p.instock !== false).slice(0, 12);
  const grid = items.length ? `
    <div style="margin:4px 0 8px 0; font-weight:800">${word.charAt(0).toUpperCase()+word.slice(1)} Piercing Kits</div>
    <div class="hbj-grid">
      ${items.map(p => `
        <a href="${utmize(p.url,'kit_type_'+encodeURIComponent(word))}" target="_blank" rel="nofollow noopener" style="text-decoration:none;color:inherit">
          <div class="hbj-card">
            ${p.image ? `<img src="${p.image}" alt="" style="width:100%;height:120px;object-fit:cover;border-radius:8px">` : ''}
            <div class="hbj-title">${p.title}</div>
            ${p.price ? `<div style="opacity:.9;margin-top:4px">${p.price}</div>` : ''}
          </div>
        </a>
      `).join('')}
    </div>` : `<div>No in-stock ${word} kits found right now. Try another type.</div>`;
  return shell(grid);
}

async function composeSterile(){
  const sterile = await harvestProductsFromCategory(STERILIZED_CAT);
  const sterileInstock = (sterile||[]).filter(p => p.instock !== false).slice(0, 10);
  if (!sterileInstock.length) return shell(`<div>No in-stock sterilized jewelry found right now.</div>`);
  const grid = `
    <div style="margin:4px 0 8px 0; font-weight:800">Sterilized Body Jewelry</div>
    <div class="hbj-grid">
      ${sterileInstock.map(p => `
        <a href="${utmize(p.url,'sterile_card')}" target="_blank" rel="nofollow noopener" style="text-decoration:none;color:inherit">
          <div class="hbj-card">
            ${p.image ? `<img src="${p.image}" alt="" style="width:100%;height:120px;object-fit:cover;border-radius:8px">` : ''}
            <div class="hbj-title">${p.title}</div>
            ${p.price ? `<div style="opacity:.9;margin-top:4px">${p.price}</div>` : ''}
          </div>
        </a>
      `).join('')}
    </div>`;
  const footer = `<div style="margin-top:8px">${cta(STERILIZED_CAT, 'Open Full Sterilized Category')}</div>`;
  return shell(`${grid}${footer}`);
}

async function composeAftercare(){
  const top = `
    <div style="margin:4px 0 8px 0; padding:10px; border:1px solid #eee; border-radius:10px; background:#fafafa">
      <div style="font-weight:800; margin-bottom:6px">Aftercare Essentials</div>
      <div style="font-size:13px; line-height:1.45">Rinse twice daily with sterile saline. Avoid twisting the jewelry. Sleep on clean linens and avoid pools/hot tubs for at least 2 weeks.</div>
    </div>`;
  const foot = `<div style="margin-top:8px">${cta(AFTERCARE_URL, 'Open Full Aftercare Page')}</div>`;
  return shell(`${top}${foot}`);
}

async function composeShipping(){
  const top = `
    <div style="margin:4px 0 8px 0; padding:10px; border:1px solid #eee; border-radius:10px; background:#fafafa">
      <div style="font-weight:800; margin-bottom:6px">Shipping & Returns</div>
      <div style="font-size:13px; line-height:1.45">
        Most orders ship within 1 business day. Returns are limited to unopened/unused items within 7 days; sterile kits are final sale.
      </div>
    </div>`;
  const foot = `<div style="margin-top:8px">${cta(SHIPPING_URL, 'Open Shipping & Returns Page')}</div>`;
  return shell(`${top}${foot}`);
}

async function composeCourse(){
  const course = normalizeCourseUrl((RULES.course_url||'').trim());
  const ok = await headOk(course);
  const target = ok ? course : PRO_KITS_CAT;
  const top = `
    <div style="margin:4px 0 8px 0; padding:10px; border:1px solid #eee; border-radius:10px; background:#fafafa">
      <div style="font-weight:800; margin-bottom:6px">Master Body Piercing Course</div>
      <div style="font-size:13px; line-height:1.45">Per owner exception: opens even if unavailable. ${ok ? '' : '(Course page temporarily unavailable — showing kits category.)'}</div>
    </div>`;
  const foot = `<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
    ${cta(target, ok ? 'Go to Course' : 'See Professional Kits')}
    ${cta(ABOUT_URL, 'About Us')}
    ${cta(CONTACT_URL, 'Contact / Interest')}
  </div>`;
  return shell(`${top}${foot}`);
}

// ---------- API ----------
function normQuery(q){ return cleanText((q||'').toLowerCase()); }

app.post('/hbj/chat', async (req, res) => {
  try {
    const q = (req.body.q||'').toString().trim();
    const key = normQuery(q);
    const cached = cacheGet(CACHE.chat, key, 60*1000);
    if (cached) return res.json({ html: cached });
    const intent = intentOf(key);
    let html = '';
    if (intent === 'shipping') html = await composeShipping();
    else if (intent === 'aftercare') html = await composeAftercare();
    else if (intent === 'sterile') html = await composeSterile();
    else if (intent === 'course') html = await composeCourse();
    else if (intent === 'kit') html = await composeKitQuestion();
    else if (intent === 'kit_type') {
      const word = key.split(/\s+/).find(w => KIT_WORDS.has(w)) || 'piercing';
      html = await composeKitType(word);
    } else {
      html = shell(`<div>Tell me what you’re looking for and I’ll pull it up.</div>`);
    }
    cacheSet(CACHE.chat, key, html);
    res.json({ html });
  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ html: 'Server error. Try again shortly.' });
  }
});

app.get('/hbj/health', (_,res)=> res.json({ ok:true, version: '1.9.6' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`HBJ Assistant running on :${PORT}`));
