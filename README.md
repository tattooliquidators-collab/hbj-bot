# HBJ Contact Button & Typed-Contact Setup (v2.0.5)

This bundle gives you **copy‑paste instructions** and **ready snippets** to:
1) Add a **Contact Us** button (last in the row).
2) Make typed words like **contact / email / call** open your Contact page.
3) Verify the backend is on the correct version.

You already know how to upload a folder to your GitHub/Render repo — just drop this whole
folder in and commit. Nothing breaks if you only want the docs.

---

## Quick path (do this first)
**Goal:** See a Contact Us button *now*, without hunting template files.

1. Open your site page with the chat/buttons, press **F12 → Console**.
2. Paste the contents of `test/console_inject_snippet.js` and hit **Enter**.
3. You should see a **Contact Us** button **after** “Shipping & returns”. Click it — it must open:
   `https://www.hottiebodyjewelry.com/crm.asp?action=contactus`

If that works, make it permanent using either Option A (paste HTML) or Option B (inline script).

---

## Option A — Paste the Contact button HTML (recommended)
Find the file/template where your four buttons are defined and paste the contents of:
- `snippets/contact_us_button.html`
**after** the existing buttons (so it appears **last**). Save and hard‑refresh.

**Snippet content (same as file):**
```html
<form action="https://www.hottiebodyjewelry.com/crm.asp?action=contactus"
      method="GET" target="_blank" style="display:inline">
  <button type="submit"
    style="background:#0b5fff!important;color:#fff!important;padding:10px 14px;
           border-radius:10px;font-weight:900!important;border:0;cursor:pointer">
    Contact Us
  </button>
</form>
```

---

## Option B — No template access? Use an inline script
If you can edit the page/footer but can’t find the exact button block, paste the contents of
`snippets/inline_contact_script.html` near the **bottom of the page** and save.

This script finds **“Shipping & returns”** and appends **Contact Us** right after it.
It won’t duplicate on refresh.

---

## Option C — Include a JS file instead of inline
If you prefer a file, use: `public/contact_inject.js` and include it on your page:

```html
<script src="/contact_inject.js" defer></script>
```

Make sure the path matches where your site serves static assets.

---

## Make typed “contact / email / call …” open the contact page
If your chat UI does not render the backend HTML, add a small guard so the page always opens
when users type contact words. Paste the contents of:
- `snippets/typed_contact_bypass.html`
under your chat form/Send button logic.

This only opens the Contact page; your backend response still shows the CTA as HTML when rendered.

---

## Backend sanity checks (no code changes)
Open these in your browser to confirm the backend build:
- `https://hbj-bot.onrender.com/hbj/health`  → must show `"version":"2.0.2"` (or higher)
- `https://hbj-bot.onrender.com/hbj/intent?q=contact` → must return `{"intent":"contact", ...}`

If either check fails, redeploy your Render service to the latest commit.

---

## Troubleshooting
- **Button still not visible?** Your page cache is stale. Do a **hard refresh** (Shift+Reload) or clear cache.
- **Typed “contact” doesn’t show a CTA in chat?** Your UI is likely inserting response text
  with `textContent`. Switch to `innerHTML`. See `troubleshooting/typed_contact_open_fails.md`.
- **Link opens wrong place / 404?** Right‑click the Contact button → **Copy link address** must be exactly:
  `https://www.hottiebodyjewelry.com/crm.asp?action=contactus`

---

## Files in this bundle
- `README.md` — you’re reading it.
- `snippets/contact_us_button.html` — the button (place **last**).
- `snippets/inline_contact_script.html` — inline script appending the button after “Shipping & returns”.
- `snippets/typed_contact_bypass.html` — hook to open Contact page when users type contact words.
- `public/contact_inject.js` — same as inline script, but as a separate JS file.
- `test/console_inject_snippet.js` — paste into browser console to prove the button shows now.
- `troubleshooting/typed_contact_open_fails.md` — front‑end render fix (innerHTML) + diagnostics.

