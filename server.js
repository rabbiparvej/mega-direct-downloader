const express = require('express');
const { File } = require('megajs');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const CACHE_TTL = 30 * 60 * 1000;
const VIDEO_EXT = /\.(mp4|mkv|webm|avi|mov|m4v|flv|wmv|ts|3gp|mpg|mpeg|ogv)$/i;
const MEGA_RE = /mega\.nz\/folder\/([A-Za-z0-9_-]+)#([A-Za-z0-9_-]+)(?:\/(folder|file)\/([A-Za-z0-9_-]+))?/i;

const cache = new Map();
const pending = new Map();

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function indexNodes(node, parts = [], out = []) {
  for (const child of node.children || []) {
    const p = parts.concat(child.name || '');
    out.push({ node: child, parts: p });
    if (child.directory) indexNodes(child, p, out);
  }
  return out;
}

function toId(parts) {
  return Buffer.from(parts.join('/'), 'utf8').toString('base64url');
}

async function getFolder(folderId, key) {
  const ck = folderId + '#' + key;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.root;
  if (pending.has(ck)) return pending.get(ck);

  const job = (async () => {
    const root = File.fromURL('https://mega.nz/folder/' + folderId + '#' + key);
    await root.loadAttributes();
    cache.set(ck, { root, at: Date.now() });
    return root;
  })();

  pending.set(ck, job);
  try {
    return await job;
  } finally {
    pending.delete(ck);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > CACHE_TTL) cache.delete(k);
}, 5 * 60 * 1000).unref();

function baseUrl(req) {
  return req.protocol + '://' + req.get('host');
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(i === 0 ? 0 : 2) + ' ' + units[i];
}

async function listLink(link, origin) {
  const m = String(link).trim().match(MEGA_RE);
  if (!m) throw new Error('Invalid MEGA folder link');
  const [, folderId, key, subType, subId] = m;

  const root = await getFolder(folderId, key);
  const all = indexNodes(root);

  let title = root.name || 'MEGA Folder';
  let scope = all;
  let basePath = [];

  if (subType === 'folder' && subId) {
    const sub = all.find((x) => x.node.directory && x.node.nodeId === subId);
    if (sub) {
      title = sub.node.name || title;
      basePath = sub.parts;
      scope = all.filter(
        (x) => x.parts.length > basePath.length && basePath.every((s, i) => x.parts[i] === s)
      );
    }
  } else if (subType === 'file' && subId) {
    const single = all.filter((x) => !x.node.directory && x.node.nodeId === subId);
    if (single.length) scope = single;
  }

  const videos = scope
    .filter((x) => !x.node.directory && VIDEO_EXT.test(x.node.name || ''))
    .map((x) => ({
      node: x.node,
      parts: x.parts,
      path: x.parts.slice(basePath.length, -1).join(' / ')
    }));

  videos.sort((a, b) => collator.compare(a.path, b.path) || collator.compare(a.node.name, b.node.name));

  const items = videos.map((v, i) => {
    const name = v.node.name;
    const dl = origin + '/dl/' + folderId + '/' + toId(v.parts) + '/' + encodeURIComponent(name) + '?k=' + key;
    return {
      index: i + 1,
      name,
      path: v.path,
      size: v.node.size,
      sizeText: formatSize(v.node.size),
      download: dl,
      stream: dl + '&inline=1'
    };
  });

  return {
    ok: true,
    title,
    count: items.length,
    totalSize: formatSize(items.reduce((s, x) => s + (x.size || 0), 0)),
    items
  };
}

app.post('/api/list', async (req, res) => {
  const links = Array.isArray(req.body.links) ? req.body.links : [];
  if (!links.length) return res.status(400).json({ ok: false, error: 'No links provided' });

  const origin = baseUrl(req);
  const results = [];
  for (const link of links.slice(0, 20)) {
    try {
      results.push({ link, ...(await listLink(link, origin)) });
    } catch (err) {
      results.push({ link, ok: false, error: err.message || 'Failed to load folder' });
    }
  }
  res.json({ results });
});

app.get('/api/list', async (req, res) => {
  try {
    res.json(await listLink(req.query.link || '', baseUrl(req)));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/dl/:folderId/:pid/:name?', async (req, res) => {
  const { folderId, pid } = req.params;
  const key = req.query.k;
  if (!key) return res.status(400).send('Missing key');

  try {
    const root = await getFolder(folderId, key);

    let wanted;
    try {
      wanted = Buffer.from(pid, 'base64url').toString('utf8');
    } catch (e) {
      return res.status(400).send('Bad file id');
    }

    const hit = indexNodes(root).find((x) => !x.node.directory && x.parts.join('/') === wanted);
    if (!hit) return res.status(404).send('File not found');

    const node = hit.node;
    const size = node.size;
    const name = node.name;
    const inline = req.query.inline === '1';
    const disposition = (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(name);

    let start = 0;
    let end = size - 1;
    let status = 200;

    const range = req.headers.range;
    if (range) {
      const rm = /bytes=(\d*)-(\d*)/.exec(range);
      if (rm) {
        if (rm[1] !== '') {
          start = parseInt(rm[1], 10);
          if (rm[2] !== '') end = Math.min(parseInt(rm[2], 10), size - 1);
        } else if (rm[2] !== '') {
          start = Math.max(size - parseInt(rm[2], 10), 0);
        }
        if (start > end || start >= size) {
          res.status(416).set('Content-Range', 'bytes */' + size);
          return res.end();
        }
        status = 206;
      }
    }

    const mime = /\.mp4$|\.m4v$/i.test(name) ? 'video/mp4'
      : /\.webm$/i.test(name) ? 'video/webm'
      : /\.mkv$/i.test(name) ? 'video/x-matroska'
      : 'application/octet-stream';

    res.status(status);
    res.set({
      'Content-Type': mime,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': disposition,
      'Cache-Control': 'no-store'
    });
    if (status === 206) res.set('Content-Range', 'bytes ' + start + '-' + end + '/' + size);

    const stream = node.download({ start, end: end + 1 });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(500).send('Download failed: ' + (err.message || 'unknown error'));
    else res.destroy();
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PAGE = String.raw`<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MegaDL Premium</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Hind+Siliguri:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#07070d;--panel:rgba(255,255,255,.045);--panel-2:rgba(255,255,255,.07);
  --line:rgba(255,255,255,.09);--text:#f2f2f8;--muted:#9a9ab0;
  --a1:#7c5cff;--a2:#22d3ee;--ok:#34d399;--err:#fb7185;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:'Inter','Hind Siliguri',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}
body::before,body::after{content:'';position:fixed;width:520px;height:520px;border-radius:50%;filter:blur(120px);opacity:.35;z-index:-1;pointer-events:none}
body::before{background:var(--a1);top:-160px;left:-120px}
body::after{background:var(--a2);bottom:-200px;right:-140px;opacity:.22}
.wrap{max-width:1080px;margin:0 auto;padding:48px 20px 80px}
header{text-align:center;margin-bottom:36px}
.badge{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border:1px solid var(--line);border-radius:999px;background:var(--panel);font-size:12px;color:var(--muted);letter-spacing:.08em;text-transform:uppercase}
.badge i{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 12px var(--ok)}
h1{font-size:clamp(34px,6vw,58px);font-weight:800;letter-spacing:-.03em;margin:18px 0 10px;background:linear-gradient(110deg,#fff 20%,var(--a2) 55%,var(--a1));-webkit-background-clip:text;background-clip:text;color:transparent}
header p{color:var(--muted);font-size:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:22px;backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);box-shadow:0 20px 60px rgba(0,0,0,.45)}
.input-card{padding:22px}
textarea{width:100%;min-height:130px;resize:vertical;padding:16px 18px;border-radius:14px;border:1px solid var(--line);background:rgba(0,0,0,.35);color:var(--text);font:500 14px/1.6 'Inter',monospace;outline:none;transition:.2s}
textarea:focus{border-color:var(--a1);box-shadow:0 0 0 4px rgba(124,92,255,.18)}
.row{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-top:14px;flex-wrap:wrap}
.hint{font-size:13px;color:var(--muted)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;cursor:pointer;font:600 14px 'Inter',sans-serif;padding:12px 22px;border-radius:12px;color:#fff;text-decoration:none;transition:.2s;white-space:nowrap}
.btn-primary{background:linear-gradient(120deg,var(--a1),var(--a2));box-shadow:0 10px 30px rgba(124,92,255,.35)}
.btn-primary:hover{transform:translateY(-2px);box-shadow:0 14px 38px rgba(124,92,255,.5)}
.btn-primary:disabled{opacity:.6;cursor:wait;transform:none}
.btn-ghost{background:var(--panel-2);border:1px solid var(--line)}
.btn-ghost:hover{background:rgba(255,255,255,.12)}
.btn-sm{padding:9px 14px;font-size:13px;border-radius:10px}
.btn.done{background:rgba(52,211,153,.18);border-color:var(--ok);color:var(--ok)}
#results{margin-top:28px;display:grid;gap:22px}
.folder{overflow:hidden;animation:rise .5s ease both}
@keyframes rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
.f-head{padding:20px 22px;display:flex;gap:14px;justify-content:space-between;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--line);background:linear-gradient(180deg,rgba(255,255,255,.04),transparent)}
.f-title{font-size:18px;font-weight:700;word-break:break-word}
.f-meta{font-size:13px;color:var(--muted);margin-top:4px}
.f-tools{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.search{padding:10px 14px;border-radius:10px;border:1px solid var(--line);background:rgba(0,0,0,.35);color:var(--text);font:500 13px 'Inter',sans-serif;outline:none;min-width:170px}
.search:focus{border-color:var(--a2)}
.list{list-style:none}
.item{display:grid;grid-template-columns:46px 1fr auto;gap:14px;align-items:center;padding:14px 22px;border-bottom:1px solid var(--line);transition:.15s}
.item:last-child{border-bottom:0}
.item:hover{background:rgba(255,255,255,.04)}
.idx{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;font-weight:700;font-size:13px;background:linear-gradient(135deg,rgba(124,92,255,.25),rgba(34,211,238,.18));border:1px solid var(--line)}
.name{font-weight:600;font-size:14.5px;word-break:break-word;line-height:1.4}
.sub{font-size:12px;color:var(--muted);margin-top:3px;display:flex;gap:10px;flex-wrap:wrap}
.pill{padding:1px 8px;border-radius:999px;background:var(--panel-2);border:1px solid var(--line)}
.actions{display:flex;gap:8px}
.err{padding:20px 22px;color:var(--err);font-weight:500}
.empty{padding:26px;text-align:center;color:var(--muted)}
.spinner{width:16px;height:16px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.toast{position:fixed;bottom:26px;left:50%;transform:translate(-50%,30px);background:#14141f;border:1px solid var(--line);padding:12px 20px;border-radius:12px;font-size:14px;opacity:0;transition:.3s;pointer-events:none;z-index:50}
.toast.show{opacity:1;transform:translate(-50%,0)}
footer{text-align:center;margin-top:50px;color:var(--muted);font-size:13px}
@media(max-width:680px){
  .item{grid-template-columns:38px 1fr;padding:14px 16px}
  .actions{grid-column:1 / -1}
  .actions .btn{flex:1}
  .f-head{padding:16px}
  .search{flex:1}
}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="badge"><i></i> Online</span>
    <h1>MegaDL Premium</h1>
    <p>MEGA Folder লিংক দিন — সব ভিডিওর Direct Download লিংক পেয়ে যান</p>
  </header>

  <section class="card input-card">
    <textarea id="links" spellcheck="false" placeholder="প্রতি লাইনে একটি করে MEGA Folder লিংক দিন&#10;https://mega.nz/folder/XXXXXXXX#YYYYYYYYYYYY"></textarea>
    <div class="row">
      <span class="hint">একাধিক Folder লিংক দেওয়া যাবে (সর্বোচ্চ ২০টি)</span>
      <button class="btn btn-primary" id="go">Generate Links</button>
    </div>
  </section>

  <div id="results"></div>
  <footer>Powered by MegaDL API</footer>
</div>
<div class="toast" id="toast"></div>

<script>
var $ = function (s) { return document.querySelector(s); };
var toastTimer;

function toast(msg) {
  var t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1800);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  return new Promise(function (resolve) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    resolve();
  });
}

function itemHtml(it) {
  return '<li class="item" data-name="' + esc((it.path + ' ' + it.name).toLowerCase()) + '">' +
    '<div class="idx">' + it.index + '</div>' +
    '<div><div class="name">' + esc(it.name) + '</div>' +
    '<div class="sub">' + (it.sizeText ? '<span class="pill">' + esc(it.sizeText) + '</span>' : '') +
    (it.path ? '<span>' + esc(it.path) + '</span>' : '') + '</div></div>' +
    '<div class="actions">' +
    '<button class="btn btn-ghost btn-sm" data-copy="' + esc(it.download) + '">Copy Link</button>' +
    '<a class="btn btn-primary btn-sm" href="' + esc(it.download) + '" download>Download</a>' +
    '</div></li>';
}

function render(results) {
  var box = $('#results');
  box.innerHTML = '';
  results.forEach(function (r, ri) {
    var el = document.createElement('section');
    el.className = 'card folder';
    if (!r.ok) {
      el.innerHTML = '<div class="err">' + esc(r.error || 'Error') + '<div class="f-meta">' + esc(r.link) + '</div></div>';
      box.appendChild(el);
      return;
    }
    var body = r.items.length
      ? '<ul class="list">' + r.items.map(itemHtml).join('') + '</ul>'
      : '<div class="empty">এই Folder এ কোনো ভিডিও পাওয়া যায়নি</div>';
    el.innerHTML =
      '<div class="f-head"><div><div class="f-title">' + esc(r.title) + '</div>' +
      '<div class="f-meta">' + r.count + ' ভিডিও · ' + esc(r.totalSize) + '</div></div>' +
      '<div class="f-tools"><input class="search" placeholder="Search..." data-search="' + ri + '">' +
      '<button class="btn btn-ghost btn-sm" data-copyall="' + ri + '">Copy All Links</button></div></div>' + body;
    box.appendChild(el);
  });

  box.onclick = function (e) {
    var c = e.target.closest('[data-copy]');
    if (c) {
      copyText(c.getAttribute('data-copy')).then(function () {
        var old = c.textContent;
        c.textContent = 'Copied!';
        c.classList.add('done');
        toast('Link copied');
        setTimeout(function () { c.textContent = old; c.classList.remove('done'); }, 1400);
      });
      return;
    }
    var a = e.target.closest('[data-copyall]');
    if (a) {
      var r = results[parseInt(a.getAttribute('data-copyall'), 10)];
      var text = r.items.map(function (x) { return x.download; }).join('\n');
      copyText(text).then(function () { toast(r.items.length + ' টি লিংক কপি হয়েছে'); });
    }
  };

  box.oninput = function (e) {
    var s = e.target.getAttribute('data-search');
    if (s === null) return;
    var q = e.target.value.trim().toLowerCase();
    var folder = e.target.closest('.folder');
    folder.querySelectorAll('.item').forEach(function (li) {
      li.style.display = li.getAttribute('data-name').indexOf(q) > -1 ? '' : 'none';
    });
  };
}

$('#go').addEventListener('click', function () {
  var btn = this;
  var links = $('#links').value.split(/\s+/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (!links.length) return toast('কমপক্ষে একটি লিংক দিন');

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Loading...';

  fetch('/api/list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ links: links })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) { render(d.results || []); })
    .catch(function () { toast('সার্ভারে সমস্যা হয়েছে, আবার চেষ্টা করুন'); })
    .finally(function () {
      btn.disabled = false;
      btn.textContent = 'Generate Links';
    });
});
</script>
</body>
</html>`;

app.get('/', (req, res) => res.type('html').send(PAGE));

app.listen(PORT, () => console.log('MegaDL running on port ' + PORT));
