
// server.js — HBJ Bot v1.9.4
// Fixes:
//  • Absolute URLs for tracking/course redirects (no more 404 from relative /hbj/...)
//  • Higher-contrast buttons/links
//  • 1-word kit intents (e.g., "nose", "nipple", "clit", "genital") map to kit search
// Keeps v1.9.2 perf + v1.9.3 course guard, UTM, click tracking, mobile grid cap

import express from 'express';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import cors from 'cors';
import fs from 'fs';
import compression from 'compression';
import * as https from 'node:https';
import * as http from 'node:http';

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

// Public base for redirects (ABSOLUTE)
const PUBLIC_BASE = (process.env.PUBLIC_BASE || process.env.RENDER_EXTERNAL_URL || 'https://hbj-bot.onrender.com').replace(/\/+$/,'');

// ---------- Rules / KB ----------
let RULES = { faqs:{}, promote_first:[], aliases:{}, course_url:'' };
try { RULES = JSON.parse(fs.readFileSync('./rules.json','utf8')); } catch {}

// Canonical course URL guard
const CANON_COURSE = 'https://www.hottiebodyjewelry.com/Master-Body-Piercing-Class-COMING-SOON_p_363.html';
function normalizeCourseUrl(raw) {
  const v = (raw||'').trim();
  if (!v) return CANON_COURSE;
  if (/Master-Body-Piercing-Class-COMING($|[^-S])/.test(v)) return CANON_COURSE;
  if (!/\.html($|\?)/i.test(v)) return CANON_COURSE;
  if (!/_p_363\.html($|\?)/.test(v)) return CANON_COURSE;
  return v;
}

// ---------- Helpers ----------
function cleanText(t=''){ return t.replace(/\s+/g,' ').replace(/\u00a0/g,' ').trim(); }
function abs(url, base){ try { return new URL(url, base).href; } catch { return url; } }

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 32 });
const keepAliveHttp  = new http.Agent({ keepAlive: true, maxSockets: 32 });
function agentFor(url){ return url.startsWith('https') ? keepAliveHttps : keepAliveHttp; }

// Simple TTL cache
function makeCache(){ return new Map(); }
function cacheGet(map, key, maxAgeMs){
  const v = map.get(key);
  if (!v) return null;
  if ((Date.now() - v.t) > maxAgeMs) { map.delete(key); return null; }
  return v.value;
}
function cacheSet(map, key, value){ map.set(key, { t: Date.now(), value }); }

const CACHE = {
  page: makeCache(),
  category: makeCache(),
  homespecials: makeCache(),
  chat: makeCache()
};

async function get(url, ttlMs=5*60*1000){
  const cached = cacheGet(CACHE.page, url, ttlMs);
  if (cached) return cached;
  const r = await fetch(url, { redirect: 'follow', headers: HEADERS, agent: agentFor(url) });
  if (!r.ok) throw new Error(`GET ${url} ${r.status}`);
  const txt = await r.text();
  cacheSet(CACHE.page, url, txt);
  return txt;
}

// ---------- UTM + Outbound redirect helpers ----------
function utmize(rawUrl, campaign='general', extra={}) {
  try {
    const u = new URL(rawUrl);
    u.searchParams.set('utm_source','hbjbot');
    u.searchParams.set('utm_medium','chat');
    u.searchParams.set('utm_campaign', campaign);
    u.searchParams.set('hbjbot','1');
    for (const [k,v] of Object.entries(extra||{})) if (v!=null) u.searchParams.set(k, String(v));
    return u.toString();
  } catch { return rawUrl; }
}
function outLink(rawUrl, campaign='general', extra={}) {
  const target = encodeURIComponent(utmize(rawUrl, campaign, extra));
  const ctx = encodeURIComponent(campaign);
  return `${PUBLIC_BASE}/hbj/out?u=${target}&ctx=${ctx}`;
}
function courseLink(){ return `${PUBLIC_BASE}/hbj/course`; }

// ---------- Click redirect & course guard endpoints ----------
app.get('/hbj/out', (req, res) => {
  try {
    const url = decodeURIComponent(req.query.u || '');
    const ctx = req.query.ctx || 'general';
    const ua = req.headers['user-agent'] || '';
    const ref = req.headers['referer'] || '';
    const ip = req.headers['x-forwarded-for'] || req.ip;
    console.log(JSON.stringify({ event:'hbj.click', ctx, url, ip, ua, ref, ts: new Date().toISOString() }));
    if (!/^https?:\/\//i.test(url)) return res.status(400).send('Bad URL');
    return res.redirect(302, url);
  } catch (e) { return res.status(400).send('Bad URL'); }
});

async function headOk(url){
  try {
    const r = await fetch(url, { method:'HEAD', redirect:'follow', headers: HEADERS, agent: agentFor(url) });
    return r.ok;
  } catch { return false; }
}
app.get('/hbj/course', async (req, res) => {
  const courseUrl = normalizeCourseUrl((RULES.course_url||'').trim());
  const target = utmize(courseUrl, 'course_cta');
  if (await headOk(courseUrl)) return res.redirect(302, target);
  const fallback = utmize(PRO_KITS_CAT, 'course_fallback');
  return res.redirect(302, fallback);
});

// ---------- Pages config ----------
let PAGES = { pages: [] };
try { PAGES = JSON.parse(fs.readFileSync('./pages.json','utf8')); } catch {}

// ---------- Listing parse helpers + product enrichment (perf kept) ----------
function looksProductHref(href=''){ return /_p_\d+(\.html)?|\/p-\d+|ProductDetails\.asp|product\.asp|\/product\/\d+/i.test(href); }
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
async function mapLimit(arr, limit, fn){
  const ret = new Array(arr.length);
  let i = 0;
  const workers = Array(Math.min(limit, arr.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++; if (idx >= arr.length) break;
      try { ret[idx] = await fn(arr[idx], idx); } catch { ret[idx] = null; }
    }
  });
  await Promise.all(workers);
  return ret.filter(Boolean);
}
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
    const enrichPages = await mapLimit(needEnrich, 4, async (link) => {
      try {
        const ph = await get(link, 20*60*1000);
        const $$ = cheerio.load(ph);
        const title = cleanText($$('h1').first().text()) || cleanText($$('title').first().text()) || 'Product';
        const price = extractPrice($$);
        const image = extractImage($$, link);
        const instock = detectStock($$);
        return { title, url: link, price, image, instock };
      } catch { return null; }
    });
    const byUrl = new Map(items.map(it => [it.url, it]));
    for (const p of enrichPages) if (p) byUrl.set(p.url, { ...byUrl.get(p.url), ...p });
    const links = new Set(items.map(it => it.url));
    const extra = Array.from(links).slice(0,16 - byUrl.size);
    const extraPages = await mapLimit(extra, 4, async (link) => {
      try {
        const ph = await get(link, 20*60*1000);
        const $$ = cheerio.load(ph);
        const title = cleanText($$('h1').first().text()) || cleanText($$('title').first().text()) || 'Product';
        const price = extractPrice($$);
        const image = extractImage($$, link);
        const instock = detectStock($$);
        return { title, url: link, price, image, instock };
      } catch { return null; }
    });
    for (const p of extraPages) if (p) byUrl.set(p.url, { ...byUrl.get(p.url), ...p });
    for (const v of byUrl.values()) out.push(v);
  } catch {}
  cacheSet(CACHE.category, categoryUrl, out);
  return out;
}

async function harvestHomeSpecialKits(){
  const key = 'homespecials';
  const cached = cacheGet(CACHE.homespecials, key, 10*60*1000);
  if (cached) return cached;
  const out = [];
  try {
    const h = await get(HOME, 5*60*1000);
    const $ = cheerio.load(h);
    const items = parseListing($, HOME).filter(it => /kit/i.test(it.title));
    const links = items.slice(0, 12).map(it => it.url);
    const pages = await mapLimit(links, 4, async (link) => {
      try {
        const ph = await get(link, 20*60*1000);
        const $$ = cheerio.load(ph);
        const title = cleanText($$('h1').first().text()) || cleanText($$('title').first().text()) || 'Product';
        const price = extractPrice($$);
        const image = extractImage($$, link);
        const instock = detectStock($$);
        return { title, url: link, price, image, instock };
      } catch { return null; }
    });
    for (const p of pages) if (p) out.push(p);
  } catch {}
  cacheSet(CACHE.homespecials, key, out);
  return out;
}

function scoreAgainstQuery(q, p){
  let s = 0;
  const t = p.title?.toLowerCase() || '', ql = q.toLowerCase();
  for (const w of ql.split(/\s+/)) if (w && t.includes(w)) s += 1;
  const g = (ql.match(/\b(6|8|10|12|14|16|18|20|22)g\b/)||[])[1];
  if (g && t.includes(`${g}g`)) s += 3;
  if (/kit\b/i.test(ql) && /kit\b/i.test(t)) s += 4;
  if (/steril/i.test(ql) && /steril/i.test(t)) s += 6;
  return s;
}

// ---------- Intents (now recognizes 1-word kit types) ----------
const KIT_WORDS = new Set([
  'ear','nose','nostril','septum','tragus','daith','rook','industrial','eyebrow','brow',
  'tongue','lip','labret','monroe','smiley','frenulum','medusa','philtrum',
  'navel','belly','bellybutton','belly-button',
  'nipple',
  'genital','clit','clitoral','vch','hch','christina','prince','apadravya','ampallang'
]);
function intentOf(q){
  const s = q.toLowerCase().trim();
  if (/(shipping|returns?|return policy|refund|exchange|delivery|how long.*ship|ship.*time)/i.test(s)) return 'shipping';
  if (/(aftercare|after care|care instructions|clean|saline|healing)/i.test(s)) return 'aftercare';
  if (/steril/i.test(s)) return 'sterile';
  if (/(course|training|apprentice|class|master class|certification)/i.test(s)) return 'course';
  if (/\bkit(s)?\b/i.test(s)) return 'kit';
  // NEW: single word (or two short words) that match piercing types → treat as kit
  const words = s.split(/\s+/).filter(Boolean);
  const oneWord = words.length <= 2 && words.every(w => w.length <= 12);
  if (oneWord && words.some(w => KIT_WORDS.has(w))) return 'kit_type';
  return 'general';
}

function htmlShell(body){
  const style = `
    <style>
      .hbj-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap:10px; }
      @media (max-width:520px) { .hbj-grid { grid-template-columns: repeat(2, 1fr) !important; } }
      .hbj-card { border:1px solid #eee; border-radius:12px; padding:10px; background:#fff; }
      .hbj-title { font-weight:600; margin-top:8px; font-size:13px; line-height:1.2; color:#111; }
      .hbj-img { width:100%; height:120px; object-fit:cover; border-radius:8px }
      .hbj-btn { display:inline-block; background:#0b5fff; color:#fff; padding:10px 14px; border-radius:10px; text-decoration:none; font-weight:700 }
      .hbj-link { color:#0b5fff; text-decoration:underline; font-weight:700 }
      .hbj-compact { display:flex; gap:8px; align-items:center; padding:6px 0; border-top:1px solid #f2f2f2; background:#fff; }
      .hbj-compact img { width:42px; height:42px; object-fit:cover; border-radius:6px }
      .hbj-note { font-size:12px; color:#333; }
    </style>`;
  return `<div style="font-size:14px">${style}${body}</div>`;
}

// ---------- Compose ----------
async function composeKitQuestion(){
  const homeKits = await harvestHomeSpecialKits();
  const kitsInStock = (homeKits||[]).filter(p => p.instock !== false).slice(0, 10);
  const grid = kitsInStock.length ? `
    <div style="margin:4px 0 8px 0; font-weight:800">Piercing Kits — Home Specials</div>
    <div class="hbj-grid">
      ${kitsInStock.map(p => `
        <a href="${outLink(p.url,'kit_card')}" target="_blank" rel="nofollow noopener" style="text-decoration:none;color:inherit">
          <div class="hbj-card">
            ${p.image ? `<img src="${p.image}" alt="" class="hbj-img">` : ''}
            <div class="hbj-title">${p.title}</div>
            ${p.price ? `<div style="opacity:.85; margin-top:4px">${p.price}</div>` : ''}
          </div>
        </a>
      `).join('')}
    </div>` : ``;
  const footer = `
    <div style="margin-top:10px; padding:10px; border:1px dashed #ddd; border-radius:10px; background:#fff">
      <div style="font-weight:700;">What kind of piercing kit are you looking for?</div>
      <div class="hbj-note">Reply with a single word like: nose, ear, septum, nipple, clit, genital, tongue…</div>
    </div>`;
  return htmlShell(`${grid}${footer}`);
}

async function composeKitType(word){
  const q = `${word} piercing kit`;
  let items = await searchProductsOnDemand(q);
  items = items.filter(p => /kit/i.test(p.title||'')); // only kits
  items = items.filter(p => p.instock !== false).slice(0, 12);
  const grid = items.length ? `
    <div style="margin:4px 0 8px 0; font-weight:800">${word.charAt(0).toUpperCase()+word.slice(1)} Piercing Kits</div>
    <div class="hbj-grid">
      ${items.map(p => `
        <a href="${outLink(p.url,'kit_type_'+encodeURIComponent(word))}" target="_blank" rel="nofollow noopener" style="text-decoration:none;color:inherit">
          <div class="hbj-card">
            ${p.image ? `<img src="${p.image}" alt="" class="hbj-img">` : ''}
            <div class="hbj-title">${p.title}</div>
            ${p.price ? `<div style="opacity:.85; margin-top:4px">${p.price}</div>` : ''}
          </div>
        </a>
      `).join('')}
    </div>` : `<div>No in-stock ${word} kits found right now. Try another type.</div>`;
  return htmlShell(grid);
}

async function composeSterile(){
  const sterile = await harvestProductsFromCategory(STERILIZED_CAT);
  const sterileInstock = (sterile||[]).filter(p => p.instock !== false).slice(0, 10);
  if (!sterileInstock.length) return htmlShell(`<div>No in-stock sterilized jewelry found right now.</div>`);
  const grid = `
    <div style="margin:4px 0 8px 0; font-weight:800">Sterilized Body Jewelry</div>
    <div class="hbj-grid">
      ${sterileInstock.map(p => `
        <a href="${outLink(p.url,'sterile_card')}" target="_blank" rel="nofollow noopener" style="text-decoration:none;color:inherit">
          <div class="hbj-card">
            ${p.image ? `<img src="${p.image}" alt="" class="hbj-img">` : ''}
            <div class="hbj-title">${p.title}</div>
            ${p.price ? `<div style="opacity:.85; margin-top:4px">${p.price}</div>` : ''}
          </div>
        </a>
      `).join('')}
    </div>`;
  const footer = `
    <div style="margin-top:8px">
      <a href="${outLink(STERILIZED_CAT,'sterile_category')}" target="_blank" rel="nofollow noopener" class="hbj-btn">Open Full Sterilized Category</a>
    </div>`;
  return htmlShell(`${grid}${footer}`);
}

async function composeAftercare(){
  const top = `
    <div style="margin:4px 0 8px 0; padding:10px; border:1px solid #eee; border-radius:10px; background:#fafafa">
      <div style="font-weight:800; margin-bottom:6px">Aftercare Essentials</div>
      <div style="font-size:13px; line-height:1.45">Rinse twice daily with sterile saline. Avoid twisting the jewelry. Sleep on clean linens and avoid pools/hot tubs for at least 2 weeks.</div>
    </div>`;
  const foot = `
    <div style="margin-top:8px">
      <a href="${outLink(AFTERCARE_URL,'aftercare_cta')}" target="_blank" rel="nofollow noopener" class="hbj-btn">Open Full Aftercare Page</a>
    </div>`;
  return htmlShell(`${top}${foot}`);
}

async function composeShipping(){
  const top = `
    <div style="margin:4px 0 8px 0; padding:10px; border:1px solid #eee; border-radius:10px; background:#fafafa">
      <div style="font-weight:800; margin-bottom:6px">Shipping & Returns</div>
      <div style="font-size:13px; line-height:1.45">
        Most orders ship within 1 business day. Returns are limited to unopened/unused items within 7 days; sterile kits are final sale.
      </div>
    </div>`;
  const foot = `
    <div style="margin-top:8px">
      <a href="${outLink(SHIPPING_URL,'shipping_cta')}" target="_blank" rel="nofollow noopener" class="hbj-btn">Open Shipping & Returns Page</a>
    </div>`;
  return htmlShell(`${top}${foot}`);
}

async function composeCourse(){
  const top = `
    <div style="margin:4px 0 8px 0; padding:10px; border:1px solid #eee; border-radius:10px; background:#fafafa">
      <div style="font-weight:800; margin-bottom:6px">Master Body Piercing Course</div>
      <div style="font-size:13px; line-height:1.45">Per owner exception: opening the course page even if it’s out of stock/unavailable.</div>
    </div>`;
  const foot = `
    <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap">
      <a href="${courseLink()}" target="_blank" rel="nofollow noopener" class="hbj-btn">Go to Course</a>
      <a href="${outLink(ABOUT_URL,'course_about')}" target="_blank" rel="nofollow noopener" class="hbj-btn">About Us</a>
      <a href="${outLink(CONTACT_URL,'course_contact')}" target="_blank" rel="nofollow noopener" class="hbj-btn">Contact / Interest List</a>
    </div>`;
  return htmlShell(`${top}${foot}`);
}

// ---------- API ----------
function normQuery(q){ return cleanText((q||'').toLowerCase()); }

app.post('/hbj/chat', async (req, res) => {
  try {
    const q = (req.body.q||'').toString().trim();
    const key = normQuery(q);
    const cached = cacheGet(CACHE.chat, key, 60*1000);
    if (cached) return res.json({ html: cached });
    const it = intentOf(key);
    let html = '';
    if (it === 'shipping') html = await composeShipping();
    else if (it === 'aftercare') html = await composeAftercare();
    else if (it === 'sterile') html = await composeSterile();
    else if (it === 'course') html = await composeCourse();
    else if (it === 'kit') html = await composeKitQuestion();
    else if (it === 'kit_type') {
      const word = key.split(/\s+/).find(w => KIT_WORDS.has(w)) || 'piercing';
      html = await composeKitType(word);
    } else {
      // general search fallback
      const items = (await (await import('node:module')).createRequire(import.meta.url)('./dummy')).default || [];
      html = htmlShell(`<div>Tell me what you’re looking for and I’ll pull it up.</div>`);
    }
    cacheSet(CACHE.chat, key, html);
    res.json({ html });
  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ html: 'Server error. Try again shortly.' });
  }
});

// Probes
app.get('/hbj/probe', async (req, res) => {
  try {
    const type = (req.query.type || 'sterile').toString();
    if (type === 'course') {
      const course_url = normalizeCourseUrl((RULES.course_url||'').trim());
      return res.json({ ok:true, type, course_url, public_base: PUBLIC_BASE });
    }
    if (type === 'homespecials') {
      const kits = await harvestHomeSpecialKits();
      return res.json({ ok:true, type, count: kits.length, sample: kits.slice(0,8) });
    }
    let url = STERILIZED_CAT;
    if (type === 'prokits') url = PRO_KITS_CAT;
    if (type === 'safekits') url = SAFE_KITS_CAT;
    const items = await harvestProductsFromCategory(url);
    res.json({ ok: true, type, url, count: items.length, sample: items.slice(0,10) });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.get('/hbj/health', (_,res)=> res.json({ ok:true, version: '1.9.4', public_base: PUBLIC_BASE }));

// ---------- Boot ----------
(async function boot(){ console.log('HBJ Bot v1.9.4 booted with PUBLIC_BASE=', PUBLIC_BASE); })();

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`HBJ Assistant running on :${PORT}`));
