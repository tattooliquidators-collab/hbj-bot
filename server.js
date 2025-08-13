
// server.js — HBJ Bot v1.9.2 (Performance)
// - TTL caches (page/category/home specials/chat html)
// - Listing-page parse first, limited product fetches (concurrency 4)
// - HTTP keep-alive agent
// - gzip compression
// - Preserves: canonical course guard, UTM/out links, mobile grid cap, click tracking

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
  page: makeCache(),          // url -> html
  category: makeCache(),      // url -> items[]
  homespecials: makeCache(),  // 'homespecials' -> items[]
  chat: makeCache()           // normQuery -> html
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

async function getPreview(url){
  try{
    const h = await get(url, 30*60*1000); // 30min
    const $ = cheerio.load(h);
    const title = cleanText($('title').first().text()) || url;
    let img = $('meta[property="og:image"]').attr('content') ||
              $('img[data-src]').first().attr('data-src') ||
              $('img[src*="/assets/images"]').first().attr('src') ||
              $('img[src]').first().attr('src') || '';
    if (img) img = abs(img, url);
    return { title, image: img };
  }catch{ return { title: url, image: '' }; }
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

// UTM + Outbound redirect helpers
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
  return `/hbj/out?u=${target}&ctx=${ctx}`;
}

// Click redirect
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

// ---------- Pages config ----------
let PAGES = { pages: [] };
try { PAGES = JSON.parse(fs.readFileSync('./pages.json','utf8')); } catch {}

// ---------- Docs ingest ----------
let DOCS = [];
async function loadPages() {
  DOCS = [];
  for (const entry of (PAGES.pages || [])) {
    const url = entry.url; const selector = entry.selector || 'body';
    try {
      const h = await get(url, 60*60*1000);
      const $ = cheerio.load(h);
      const title = cleanText($('title').first().text()) || url;
      const text = cleanText($(selector).text());
      const image = (function(){
        let img = $('meta[property="og:image"]').attr('content') || $('img[src*="/assets/images"]').first().attr('src') || $('img[src]').first().attr('src');
        return img ? abs(img, url) : '';
      })();
      if (text && text.length > 200) DOCS.push({ url, title, text, image });
    } catch { }
  }
}

// ---------- Concurrency helper ----------
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

// ---------- Product harvesting/search ----------
function looksProductHref(href=''){ return /_p_\d+(\.html)?|\/p-\d+|ProductDetails\.asp|product\.asp|\/product\/\d+/i.test(href); }

function parseListing($, baseUrl){
  // Try to parse products from the listing/search page without visiting each product
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
  // Basic quality filter
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

    // If listing lacks price/image, enrich by fetching limited product pages
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
    // Merge enrich
    const byUrl = new Map(items.map(it => [it.url, it]));
    for (const p of enrichPages) if (p) byUrl.set(p.url, { ...byUrl.get(p.url), ...p });
    // If still light, fetch a few more product pages (limit total to 16)
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

    // Finalize
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
    // Enrich a bit
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

function expandQuery(q){
  let add = [];
  for (const k in SYN) if (SYN[k].some(t=>q.toLowerCase().includes(t))) add.push(k);
  const g = parseGauge(q); if (g) add.push(`${g}g`);
  return `${q} ${add.join(' ')}`.trim();
}
async function searchProductsOnDemand(q){
  const out = [];
  try {
    const q2 = expandQuery(q);
    const url = `${SITE}/search.asp?keyword=${encodeURIComponent(q2)}`;
    const html = await get(url, 5*60*1000);
    const $ = cheerio.load(html);
    let items = parseListing($, url);
    // Enrich first 8
    const enrich = items.slice(0, 8).map(it => it.url);
    const pages = await mapLimit(enrich, 4, async (link) => {
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
    for (const p of pages) if (p) byUrl.set(p.url, { ...byUrl.get(p.url), ...p });
    for (const v of byUrl.values()) out.push(v);
  } catch {}
  return out;
}

function scoreAgainstQuery(q, p){
  let s = 0;
  const t = p.title?.toLowerCase() || '', ql = q.toLowerCase();
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

// ---------- Response compose ----------
function htmlShell(body){
  const style = `
    <style>
      .hbj-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap:10px; }
      @media (max-width:520px) { .hbj-grid { grid-template-columns: repeat(2, 1fr) !important; } }
      .hbj-card { border:1px solid #eee; border-radius:12px; padding:10px; }
      .hbj-img { width:100%; height:120px; object-fit:cover; border-radius:8px }
      .hbj-btn { display:inline-block; background:#111; color:#fff; padding:10px 14px; border-radius:10px; text-decoration:none; font-weight:700 }
      .hbj-compact { display:flex; gap:8px; align-items:center; padding:6px 0; border-top:1px solid #f2f2f2 }
      .hbj-compact img { width:42px; height:42px; object-fit:cover; border-radius:6px }
    </style>`;
  return `<div style="font-size:14px">${style}${body}</div>`;
}

async function composeForIntent(it, qq){
  let items = [];
  if (it === 'general' || it === 'sterile') items = await searchProductsOnDemand(qq);

  let sterileHarvest = [];
  if (it === 'sterile') {
    sterileHarvest = await harvestProductsFromCategory(STERILIZED_CAT);
    const urls = new Set(items.map(i=>i.url));
    for (const itx of sterileHarvest) if (!urls.has(itx.url)) items.push(itx);
  }

  let homeKits = [];
  if (it === 'kit') homeKits = await harvestHomeSpecialKits();

  const ranked = items.map(p => ({...p, score: scoreAgainstQuery(qq, p)})).sort((a,b)=>b.score-a.score);

  if (it === 'kit') {
    const kitsInStock = (homeKits||[]).filter(p => p.instock !== false).slice(0, 10);
    const grid = kitsInStock.length ? `
      <div style="margin:4px 0 8px 0; font-weight:800">Piercing Kits — Home Specials</div>
      <div class="hbj-grid">
        ${kitsInStock.map(p => `
          <a href="${outLink(p.url,'kit_card')}" target="_blank" rel="nofollow noopener" style="text-decoration:none;color:inherit">
            <div class="hbj-card">
              ${p.image ? `<img src="${p.image}" alt="" class="hbj-img">` : ''}
              <div style="font-weight:600; margin-top:8px; font-size:13px; line-height:1.2">${p.title}</div>
              ${p.price ? `<div style="opacity:.85; margin-top:4px">${p.price}</div>` : ''}
            </div>
          </a>
        `).join('')}
      </div>` : `<div style="margin:4px 0 8px 0;">Looking for a piercing kit? Tell me the piercing and I’ll show options.</div>`;

    const footer = `
      <div style="margin-top:10px; padding:10px; border:1px dashed #ddd; border-radius:10px; background:#fff">
        <div style="font-weight:700;">What kind of piercing kit are you looking for?</div>
      </div>`;
    return htmlShell(`${grid}${footer}`);
  }

  if (it === 'sterile') {
    const sterileInstock = (sterileHarvest||[]).filter(p => p.instock !== false).slice(0, 10);
    if (sterileInstock.length){
      const grid = `
        <div style="margin:4px 0 8px 0; font-weight:800">Sterilized Body Jewelry</div>
        <div class="hbj-grid">
          ${sterileInstock.map(p => `
            <a href="${outLink(p.url,'sterile_card')}" target="_blank" rel="nofollow noopener" style="text-decoration:none;color:inherit">
              <div class="hbj-card">
                ${p.image ? `<img src="${p.image}" alt="" class="hbj-img">` : ''}
                <div style="font-weight:600; margin-top:8px; font-size:13px; line-height:1.2">${p.title}</div>
                ${p.price ? `<div style="opacity:.85; margin-top:4px">${p.price}</div>` : ''}
              </div>
            </a>
          `).join('')}
        </div>`;
      const compact = sterileInstock.slice(0,3).map(p => `
        <a href="${outLink(p.url,'sterile_compact')}" target="_blank" rel="nofollow noopener" style="text-decoration:none;color:inherit">
          <div class="hbj-compact">
            ${p.image ? `<img src="${p.image}" alt="">` : ''}
            <div style="flex:1; font-size:13px; line-height:1.25">
              <div style="font-weight:600">${p.title}</div>
              ${p.price ? `<div style="opacity:.85; margin-top:2px">${p.price}</div>` : ''}
            </div>
          </div>
        </a>`).join('');
      const footer = `
        <div style="margin-top:10px; padding:10px; border:1px solid #eee; border-radius:10px; background:#fff">
          <div style="font-weight:800; margin-bottom:6px">Top Sterilized Picks</div>
          ${compact}
          <div style="margin-top:8px">
            <a href="${outLink(STERILIZED_CAT,'sterile_category')}" target="_blank" rel="nofollow noopener" class="hbj-btn">Open Full Sterilized Category</a>
          </div>
        </div>`;
      return htmlShell(`${grid}${footer}`);
    }
  }

  if (it === 'aftercare') {
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
          <a href="${outLink(AFTERCARE_URL,'aftercare_cta')}" target="_blank" rel="nofollow noopener" class="hbj-btn">Open Full Aftercare Page</a>
        </div>
      </div>`;
    return htmlShell(`${top}${foot}`);
  }

  if (it === 'shipping') {
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
          <a href="${outLink(SHIPPING_URL,'shipping_cta')}" target="_blank" rel="nofollow noopener" class="hbj-btn">Open Shipping & Returns Page</a>
        </div>
      </div>`;
    return htmlShell(`${top}${foot}`);
  }

  if (it === 'course') {
    const courseUrl = normalizeCourseUrl((RULES.course_url||'').trim());
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
        <a href="${outLink(courseUrl,'course_cta')}" target="_blank" rel="nofollow noopener" class="hbj-btn">Go to Course</a>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px">
          <a href="${outLink(ABOUT_URL,'course_about')}" target="_blank" rel="nofollow noopener" style="flex:1 1 180px; text-align:center; text-decoration:underline">About Us</a>
          <a href="${outLink(CONTACT_URL,'course_contact')}" target="_blank" rel="nofollow noopener" style="flex:1 1 180px; text-align:center; text-decoration:underline">Contact / Interest List</a>
        </div>
      </div>`;
    return htmlShell(`${top}${foot}`);
  }

  // general default
  return htmlShell(`<div>Tell me what you’re looking for and I’ll pull it up.</div>`);
}

function normQuery(q){ return cleanText((q||'').toLowerCase()); }

// ---------- API ----------
app.post('/hbj/chat', async (req, res) => {
  try {
    const q = (req.body.q||'').toString().trim();
    const key = normQuery(q);
    const cached = cacheGet(CACHE.chat, key, 60*1000); // 60s per identical query
    if (cached) return res.json({ html: cached });
    const it = intentOf(key);
    const html = await composeForIntent(it, key);
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
      return res.json({ ok:true, type, course_url });
    }
    if (type === 'shipping') return res.json({ ok:true, type, url: SHIPPING_URL });
    if (type === 'homespecials') {
      const kits = await harvestHomeSpecialKits();
      return res.json({ ok:true, type, count: kits.length, sample: kits.slice(0,8) });
    }
    if (type === 'kit') {
      const it = 'kit';
      const html = await composeForIntent(it, 'piercing kit');
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

app.get('/hbj/cache', (_,res) => {
  res.json({
    ok:true,
    sizes: {
      page: CACHE.page.size,
      category: CACHE.category.size,
      homespecials: CACHE.homespecials.size,
      chat: CACHE.chat.size
    }
  });
});

app.get('/hbj/health', (_,res)=> res.json({ ok:true, version: '1.9.2' }));

// ---------- Boot ----------
(async function boot(){ await loadPages(); console.log('HBJ Bot v1.9.2 booted'); })();

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`HBJ Assistant running on :${PORT}`));
