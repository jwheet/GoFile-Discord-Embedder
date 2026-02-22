const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');

const app      = express();
const PORT     = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(express.json());


/* ═══════════════════════════════════════════════════════════════════════════════
   CONFIG
   ═══════════════════════════════════════════════════════════════════════════════ */

const GOFILE_WT        = '4fd6sg89d7s6';          // GoFile website token
const CACHE_CHUNK      = 2 * 1024 * 1024;         // 2 MB prefetch per video
const MAX_CACHE        = 50;                       // max cached video starts
const CACHE_TTL        = 30 * 60 * 1000;          // 30 min cache lifetime
const MAX_LINKS        = 10000;                    // max stored short links
const LINK_TTL         = 60 * 60 * 1000;          // 1 hour link lifetime


/* ═══════════════════════════════════════════════════════════════════════════════
   SHORT LINK STORE
   Stores video metadata keyed by a short ID so embed URLs stay compact.
   Map<id, { videoUrl, token, thumb, name, w, h, createdAt }>
   ═══════════════════════════════════════════════════════════════════════════════ */

const linkStore = new Map();

function createShortId() {
  return crypto.randomBytes(4).toString('base64url'); // 6 chars, URL-safe
}

function pruneLinks() {
  const now = Date.now();
  for (const [id, entry] of linkStore) {
    if (now - entry.createdAt > LINK_TTL) linkStore.delete(id);
  }
  while (linkStore.size > MAX_LINKS) {
    linkStore.delete(linkStore.keys().next().value);
  }
}

function storeLink(data) {
  pruneLinks();
  const id = createShortId();
  linkStore.set(id, { ...data, createdAt: Date.now() });
  return id;
}


/* ═══════════════════════════════════════════════════════════════════════════════
   VIDEO START CACHE
   Caches the first 2 MB of each video in memory for instant playback start.
   Map<fileId, { buffer, contentType, totalSize, createdAt }>
   ═══════════════════════════════════════════════════════════════════════════════ */

const videoCache = new Map();

function cacheKey(url) {
  const m = url.match(/\/download\/web\/([a-f0-9-]+)\//);
  return m ? m[1] : url;
}

function pruneCache() {
  const now = Date.now();
  for (const [k, v] of videoCache) {
    if (now - v.createdAt > CACHE_TTL) videoCache.delete(k);
  }
  while (videoCache.size > MAX_CACHE) {
    videoCache.delete(videoCache.keys().next().value);
  }
}

async function prefetch(url, token) {
  const key = cacheKey(url);
  if (videoCache.has(key)) return;
  try {
    const headers = { Range: `bytes=0-${CACHE_CHUNK - 1}` };
    if (token) headers.Cookie = `accountToken=${token}`;

    const resp = await axios.get(url, {
      headers, responseType: 'arraybuffer', maxRedirects: 5, timeout: 15000
    });

    const ct    = resp.headers['content-type'] || 'video/mp4';
    const range = resp.headers['content-range'] || '';
    const total = range.match(/\/(\d+)/);

    pruneCache();
    videoCache.set(key, {
      buffer:      Buffer.from(resp.data),
      contentType: ct,
      totalSize:   total ? parseInt(total[1], 10) : null,
      createdAt:   Date.now()
    });
  } catch (err) {
    console.error('[cache] prefetch failed:', err.message);
  }
}


/* ═══════════════════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════════════════ */

function esc(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isGoFile(url) {
  try { return new URL(url).hostname.endsWith('.gofile.io'); }
  catch { return false; }
}


/* ═══════════════════════════════════════════════════════════════════════════════
   ROUTES — FRONTEND
   ═══════════════════════════════════════════════════════════════════════════════ */

app.get('/', (_req, res) => {
  res.send(/* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GoFile Discord Embedder</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0 }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e; color: #e0e0e0;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
    }
    .c   { max-width: 520px; width: 90%; text-align: center }
    h1   { font-size: 1.8rem; margin-bottom: .4rem; color: #fff }
    .sub { color: #888; margin-bottom: 1.5rem; font-size: .9rem }

    input[type="text"] {
      width: 100%; padding: 12px 16px; border-radius: 8px;
      border: 1px solid #333; background: #16213e; color: #fff;
      font-size: 1rem; outline: none;
    }
    input:focus { border-color: #0f3460 }

    button {
      margin-top: 12px; padding: 12px 28px; border: none; border-radius: 8px;
      background: #0f3460; color: #fff; font-size: 1rem; cursor: pointer;
    }
    button:hover { background: #1a5276 }

    .res {
      margin-top: 1.5rem; display: none; text-align: left;
      background: #16213e; border-radius: 8px; padding: 16px;
    }
    .res label { font-size: .85rem; color: #888; display: block; margin-bottom: 6px }
    .row { display: flex; gap: 8px }
    .row input {
      flex: 1; padding: 10px 12px; border-radius: 6px;
      border: 1px solid #333; background: #1a1a2e; color: #7ec8e3; font-size: .85rem;
    }
    .row button { margin-top: 0; padding: 10px 16px; font-size: .85rem; white-space: nowrap }

    .info    { margin-top: 1rem; font-size: .8rem; color: #666 }
    .err     { color: #e74c3c; margin-top: 1rem; font-size: .9rem }
    .spinner { display: none; margin-top: 1rem; color: #888 }
  </style>
</head>
<body>
  <div class="c">
    <h1>GoFile &rarr; Discord Embedder</h1>
    <p class="sub">Generate a Discord-embeddable link from any GoFile video share</p>

    <input type="text" id="url" placeholder="https://gofile.io/d/xxxxxx">
    <button onclick="go()">Generate</button>
    <div class="spinner" id="spin">Working&hellip;</div>
    <div class="err" id="err"></div>

    <div class="res" id="res">
      <label>Paste this link into Discord:</label>
      <div class="row">
        <input type="text" id="out" readonly>
        <button onclick="cp()">Copy</button>
      </div>
      <p class="info">The video will embed automatically when sent in a Discord message.</p>
    </div>
  </div>

  <script>
    async function go() {
      const url = document.getElementById('url').value.trim();
      const err = document.getElementById('err');
      const res = document.getElementById('res');
      const spin = document.getElementById('spin');
      err.textContent = ''; res.style.display = 'none';
      if (!url) { err.textContent = 'Enter a GoFile URL.'; return; }
      spin.style.display = 'block';
      try {
        const r = await fetch('/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Unknown error');
        document.getElementById('out').value = d.embedUrl;
        res.style.display = 'block';
      } catch (e) { err.textContent = e.message; }
      finally { spin.style.display = 'none'; }
    }
    function cp() {
      const el = document.getElementById('out');
      el.select();
      navigator.clipboard.writeText(el.value);
    }
    document.getElementById('url')
      .addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  </script>
</body>
</html>`);
});


/* ═══════════════════════════════════════════════════════════════════════════════
   ROUTES — API
   ═══════════════════════════════════════════════════════════════════════════════ */

app.post('/generate', async (req, res) => {
  try {
    /* --- validate input --- */
    const match = (req.body.url || '').match(/gofile\.io\/d\/([a-zA-Z0-9]+)/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid GoFile URL. Expected: https://gofile.io/d/xxxxxx' });
    }
    const contentId = match[1];

    /* --- get guest token --- */
    const acct  = await axios.post('https://api.gofile.io/accounts');
    const token = acct.data?.data?.token;
    if (!token) return res.status(502).json({ error: 'Failed to get GoFile guest token.' });

    /* --- fetch content metadata --- */
    const content = await axios.get(`https://api.gofile.io/contents/${contentId}`, {
      params:  { page: 1, pageSize: 1000, sortField: 'createTime', sortDirection: -1 },
      headers: { Authorization: `Bearer ${token}`, 'X-Website-Token': GOFILE_WT }
    });

    if (content.data?.status !== 'ok') {
      return res.status(502).json({ error: 'GoFile API error: ' + (content.data?.status || 'unknown') });
    }

    const children = content.data?.data?.children;
    if (!children) {
      return res.status(502).json({ error: 'Could not fetch content. Link may be invalid or expired.' });
    }

    /* --- find first video --- */
    const video = Object.values(children).find(
      f => f.type === 'file' && f.mimetype?.startsWith('video')
    );
    if (!video) return res.status(404).json({ error: 'No video file found in this GoFile link.' });

    /* --- store short link & prefetch --- */
    const id = storeLink({
      videoUrl: video.link,
      token,
      thumb:    video.thumbnail || '',
      name:     video.name || 'video.mp4',
      w:        1920,
      h:        1080
    });

    prefetch(video.link, token).catch(() => {});

    res.json({ embedUrl: `${BASE_URL}/e/${id}` });
  } catch (err) {
    console.error('[generate]', err.message);
    res.status(500).json({ error: 'Failed to process GoFile link. ' + (err.response?.data?.status || err.message) });
  }
});


/* ═══════════════════════════════════════════════════════════════════════════════
   ROUTES — EMBED PAGE
   Discord's bot reads OG meta tags here. Humans see the info/credits page.
   Follows: https://wiki.x266.mov/blog/embedding-the-un-embeddable
   ═══════════════════════════════════════════════════════════════════════════════ */

const ASCII_ART = `                                    ==
                                  =======
                               ===========
                                 =============         *===
                             ================       %*+====+
                               =============     %%#+%======
                                 ==========+++++  %%*==========
                              =============++++    %%=========
                               ===========+++++#####=========
                                 =========++++  ####============
                               ==============++++###==========
                               %============++++***=========
                             +#%%+==========++*****============
                              +**%#========+++=#***+=========
                              ==*+#========+++=##***========
                       +== +++===+#%+======++==*****=======
                       ===+++++===========+*====****=====+
                     ====================+++=====##*=++++===
                    =========+++=========++========+++++=====
                      ====+===+==+====+==++=====+%%*++++======
                     =+=======+=+++==+===++======++++++======
                       ======+====*==*===++=====+++++++=======
                       +=========+*%*+==+++=====++++++======
                         ========+*##*==+++=====++++++++++*
                          +==++==+=*#*==+++=====++++++==++++
                            =====***#+==+++===++++++++++++
                              ===+#%*===++++=   +++++++++
                              ====+%*==+=+==      ++++
                              ====+ *==+=+==     +===
                               ====+*==+=+==     ====
                               ====+*==+=+=     ====
                               ==+==#==++==    =====
                               ==+==*==++==    ====
                                ==*=*===+==   =====
                                #***#======%%@====
                                %*%%###############
                                 *=*#===+== ==+==
                                  ==%===*==#==+==
                                  *=%========++=
                                  %+*==+=+==++==
                                  %%%*+++%**####%
                                   +*########*==
                                   =**==+#==++=
                                   =++==+*=====
                                   =====++=====
                                   =====++=====
                                   ============
                                   ======+=====
                                   ======++====
                                    ==+==++====
                                    ==*==++===
                                    == == ++==
                      ____.       .__                   __
                     |    |_  _  _|  |__   ____   _____/  |_
                     |    |\\ \\/ \\/ /  |  \\_/ __ \\_/ __ \\   __\\
                 /\\__|    |\\     /|   Y  \\  ___/\\  ___/|  |
                 \\________|  \\/\\_/ |___|  /\\___  >\\___  >__|
                                   \\/     \\/     \\/      `;

app.get('/e/:id', (req, res) => {
  const entry = linkStore.get(req.params.id);
  if (!entry) return res.status(404).send('Link expired or not found.');

  const proxyUrl = `${BASE_URL}/v/${encodeURIComponent(entry.name)}?id=${req.params.id}`;
  const w = String(entry.w);
  const h = String(entry.h);

  /* trigger prefetch if not cached */
  if (isGoFile(entry.videoUrl)) prefetch(entry.videoUrl, entry.token).catch(() => {});

  res.send(/* html */`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta property="og:image" content="${esc(entry.thumb || 'https://placehold.co/1920x1080/1a1a2e/555?text=Video')}">
  <meta property="og:type" content="video.other">
  <meta property="og:video:url" content="${esc(proxyUrl)}">
  <meta property="og:video:width" content="${w}">
  <meta property="og:video:height" content="${h}">
  <meta property="og:title" content="${esc(entry.name)}">
  <meta property="og:site_name" content="GoFile Embedder">
  <title>GoFile Embedder</title>
  <style>
    *          { box-sizing: border-box; margin: 0; padding: 0 }
    html, body { height: 100%; overflow: hidden }
    body {
      background: #0d0d1a; color: #c0c0c0;
      font-family: 'Courier New', Courier, monospace;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      padding: 1vh 2vw;
    }
    pre  { color: #4a9eff; line-height: 1.1; white-space: pre; text-align: center; font-size: min(1.05vw, 0.9vh) }
    .i   { text-align: center; margin-top: 1.5vh; font-size: clamp(.55rem, 1.2vw, .8rem); color: #666; max-width: 90vw }
    .i h2{ font-size: clamp(.65rem, 1.4vw, .9rem); color: #888; margin-bottom: .5vh; font-weight: normal }
    .i a { color: #4a9eff; text-decoration: none }
    .i p { margin: .3vh 0 }
  </style>
</head>
<body>
  <pre>${ASCII_ART}</pre>
  <div class="i">
    <h2>GoFile Discord Embedder</h2>
    <p>Embeds GoFile videos directly into Discord using OpenGraph meta tags.</p>
    <p>Technique: <a href="https://wiki.x266.mov/blog/embedding-the-un-embeddable">Embedding the Un-Embeddable</a></p>
    <p>Stateless streaming proxy &mdash; no files stored.</p>
  </div>
</body>
</html>`);
});


/* ═══════════════════════════════════════════════════════════════════════════════
   ROUTES — STREAMING PROXY
   Pipes video bytes from GoFile to client. Supports Range requests for seeking.
   URL ends in .mp4 so Discord recognizes it as video.
   ═══════════════════════════════════════════════════════════════════════════════ */

/* CORS for all /v/ requests */
app.use('/v', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/v/:filename', async (req, res) => {
  /* --- resolve link data --- */
  const entry = linkStore.get(req.query.id);
  if (!entry)              return res.status(404).send('Link expired or not found.');
  if (!isGoFile(entry.videoUrl)) return res.status(403).send('Invalid source.');

  const url   = entry.videoUrl;
  const token = entry.token;

  /* --- parse Range header --- */
  const rangeHeader = req.headers.range;
  let rStart = 0, rEnd = null;
  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    rStart = parseInt(parts[0], 10) || 0;
    rEnd   = parts[1] ? parseInt(parts[1], 10) : null;
  }

  /* --- try serving from cache --- */
  const key    = cacheKey(url);
  const cached = videoCache.get(key);

  if (cached && rangeHeader) {
    const end = rEnd !== null ? rEnd : cached.buffer.length - 1;
    if (rStart < cached.buffer.length && end < cached.buffer.length) {
      const slice = cached.buffer.subarray(rStart, end + 1);
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Content-Length', slice.length);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Disposition', 'inline');
      if (cached.totalSize) {
        res.setHeader('Content-Range', `bytes ${rStart}-${end}/${cached.totalSize}`);
      }
      return res.status(206).end(slice);
    }
  }

  /* --- stream from GoFile --- */
  try {
    const headers = {};
    if (token)       headers.Cookie = `accountToken=${token}`;
    if (rangeHeader) headers.Range  = rangeHeader;

    const upstream = await axios.get(url, {
      responseType: 'stream', headers, maxRedirects: 5, decompress: false
    });

    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    }
    res.setHeader('Content-Disposition', 'inline');
    res.status(upstream.status);

    upstream.data.pipe(res);
    upstream.data.on('error', () => { if (!res.writableEnded) res.destroy(); });
    req.on('close', () => upstream.data.destroy());
  } catch (err) {
    console.error('[proxy]', err.message);
    if (!res.headersSent) {
      res.status(err.response?.status || 502).send('Proxy error');
    }
  }
});


/* ═══════════════════════════════════════════════════════════════════════════════
   START
   ═══════════════════════════════════════════════════════════════════════════════ */

app.listen(PORT, () => console.log(`GoFile Discord Embedder running on port ${PORT}`));
