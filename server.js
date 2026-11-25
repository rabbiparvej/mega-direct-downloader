const express = require('express');
const { Readable } = require('stream');
const { File } = require('megajs');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const CACHE_TTL = 30 * 60 * 1000;
const MF_URL_TTL = 8 * 60 * 1000;
const VIDEO_EXT = /\.(mp4|mkv|webm|avi|mov|m4v|flv|wmv|ts|3gp|mpg|mpeg|ogv)$/i;
const MEGA_RE = /mega\.nz\/folder\/([A-Za-z0-9_-]+)#([A-Za-z0-9_-]+)(?:\/(folder|file)\/([A-Za-z0-9_-]+))?/i;
const MEGA_FILE_RE = /mega\.nz\/(?:file\/([A-Za-z0-9_-]+)#|#!([A-Za-z0-9_-]+)!)([A-Za-z0-9_-]+)/i;
const MF_FOLDER_RE = /mediafire\.com\/folder\/([A-Za-z0-9]+)/i;
const MF_FILE_RE = /mediafire\.com\/(?:file|file_premium|view|download)\/([A-Za-z0-9]+)|mediafire\.com\/\?([A-Za-z0-9]+)/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BROWSER_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1'
};

const cache = new Map();
const pending = new Map();
const mfUrlCache = new Map();

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

async function getSingleFile(fileId, key) {
  const ck = 'file:' + fileId + '#' + key;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.root;
  if (pending.has(ck)) return pending.get(ck);

  const job = (async () => {
    const file = File.fromURL('https://mega.nz/file/' + fileId + '#' + key);
    await file.loadAttributes();
    cache.set(ck, { root: file, at: Date.now() });
    return file;
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
  for (const [k, v] of mfUrlCache) if (now - v.at > MF_URL_TTL) mfUrlCache.delete(k);
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

async function listFolderLink(link, origin) {
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

async function listSingleLink(link, origin) {
  const m = String(link).trim().match(MEGA_FILE_RE);
  if (!m) throw new Error('Invalid MEGA link');
  const fileId = m[1] || m[2];
  const key = m[3];

  const file = await getSingleFile(fileId, key);
  if (file.directory) throw new Error('This link is not a file');

  const name = file.name || 'file';
  const dl = origin + '/dlf/' + fileId + '/' + encodeURIComponent(name) + '?k=' + key;

  return {
    ok: true,
    title: name,
    count: 1,
    totalSize: formatSize(file.size),
    items: [
      {
        index: 1,
        name,
        path: '',
        size: file.size,
        sizeText: formatSize(file.size),
        download: dl,
        stream: dl + '&inline=1'
      }
    ]
  };
}

async function mfApi(path, params) {
  const qs = new URLSearchParams({ ...params, response_format: 'json' });
  const r = await fetch('https://www.mediafire.com/api/1.5/' + path + '?' + qs.toString(), {
    headers: { 'User-Agent': UA, Accept: 'application/json' }
  });
  if (!r.ok) throw new Error('MediaFire API error (' + r.status + ')');
  const j = await r.json();
  const resp = j && j.response;
  if (!resp || resp.result !== 'Success') {
    throw new Error((resp && resp.message) || 'MediaFire request failed');
  }
  return resp;
}

async function mfCollect(folderKey, pathParts, out, depth) {
  let chunk = 1;
  while (chunk <= 50) {
    const d = await mfApi('folder/get_content.php', {
      folder_key: folderKey,
      content_type: 'files',
      chunk: String(chunk),
      chunk_size: '1000'
    });
    const fc = d.folder_content || {};
    for (const f of fc.files || []) {
      out.push({
        key: f.quickkey,
        name: f.filename,
        size: parseInt(f.size, 10) || 0,
        parts: pathParts
      });
    }
    if (fc.more_chunks === 'yes') chunk++;
    else break;
  }

  if (depth >= 6) return;

  chunk = 1;
  while (chunk <= 50) {
    const d = await mfApi('folder/get_content.php', {
      folder_key: folderKey,
      content_type: 'folders',
      chunk: String(chunk),
      chunk_size: '1000'
    });
    const fc = d.folder_content || {};
    for (const sub of fc.folders || []) {
      await mfCollect(sub.folderkey, pathParts.concat(sub.name || ''), out, depth + 1);
    }
    if (fc.more_chunks === 'yes') chunk++;
    else break;
  }
}

async function listMfFolder(link, origin) {
  const m = String(link).trim().match(MF_FOLDER_RE);
  if (!m) throw new Error('Invalid MediaFire folder link');
  const folderKey = m[1];

  let title = 'MediaFire Folder';
  try {
    const info = await mfApi('folder/get_info.php', { folder_key: folderKey });
    if (info.folder_info && info.folder_info.name) title = info.folder_info.name;
  } catch (e) {}

  const all = [];
  await mfCollect(folderKey, [], all, 0);

  const videos = all
    .filter((f) => VIDEO_EXT.test(f.name || ''))
    .map((f) => ({ ...f, path: f.parts.join(' / ') }));

  videos.sort((a, b) => collator.compare(a.path, b.path) || collator.compare(a.name, b.name));

  const items = videos.map((v, i) => {
    const dl = origin + '/mf/' + v.key + '/' + encodeURIComponent(v.name);
    return {
      index: i + 1,
      name: v.name,
      path: v.path,
      size: v.size,
      sizeText: formatSize(v.size),
      download: dl,
      stream: dl + '?inline=1'
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

async function listMfFile(link, origin) {
  const m = String(link).trim().match(MF_FILE_RE);
  if (!m) throw new Error('Invalid MediaFire file link');
  const quickKey = m[1] || m[2];

  let name = '';
  let size = 0;
  try {
    const info = await mfApi('file/get_info.php', { quick_key: quickKey });
    if (info.file_info) {
      name = info.file_info.filename || '';
      size = parseInt(info.file_info.size, 10) || 0;
    }
  } catch (e) {}

  if (!name) {
    const parts = String(link).split('?')[0].split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    name = last && last !== 'file' ? decodeURIComponent(last) : parts[parts.length - 2] || 'file';
  }

  const dl = origin + '/mf/' + quickKey + '/' + encodeURIComponent(name);

  return {
    ok: true,
    title: name,
    count: 1,
    totalSize: formatSize(size),
    items: [
      {
        index: 1,
        name,
        path: '',
        size,
        sizeText: formatSize(size),
        download: dl,
        stream: dl + '?inline=1'
      }
    ]
  };
}

async function listLink(link, origin) {
  const text = String(link).trim();
  if (MEGA_RE.test(text)) return listFolderLink(text, origin);
  if (MEGA_FILE_RE.test(text)) return listSingleLink(text, origin);
  if (MF_FOLDER_RE.test(text)) return listMfFolder(text, origin);
  if (MF_FILE_RE.test(text)) return listMfFile(text, origin);
  throw new Error('Invalid link (MEGA or MediaFire only)');
}

async function mfFromApi(quickKey) {
  try {
    const d = await mfApi('file/get_links.php', {
      quick_key: quickKey,
      link_type: 'direct_download'
    });
    const l = d.links && d.links[0];
    const url = l && (l.direct_download || l.normal_download);
    if (url && /^https?:\/\/download/i.test(url)) return url;
  } catch (e) {}
  return null;
}

async function mfFromPage(quickKey) {
  const pages = [
    'https://www.mediafire.com/file/' + quickKey + '/file',
    'https://www.mediafire.com/download/' + quickKey
  ];

  for (const page of pages) {
    let r;
    try {
      r = await fetch(page, {
        headers: { ...BROWSER_HEADERS, Referer: 'https://www.mediafire.com/' },
        redirect: 'follow'
      });
    } catch (e) {
      continue;
    }
    if (!r.ok) {
      try { await r.body.cancel(); } catch (e) {}
      continue;
    }

    const ct = r.headers.get('content-type') || '';
    if (!/text\/html/i.test(ct)) {
      const direct = r.url;
      try { await r.body.cancel(); } catch (e) {}
      return direct;
    }

    const html = await r.text();
    let url = null;
    let m = html.match(/data-scrambled-url="([^"]+)"/i);
    if (m) {
      try {
        url = Buffer.from(m[1], 'base64').toString('utf8');
      } catch (e) {}
    }
    if (!url || !/^https?:\/\//i.test(url)) {
      m = html.match(/href="(https?:\/\/download[0-9]*\.mediafire\.com\/[^"]+)"/i);
      url = m ? m[1] : null;
    }
    if (!url) {
      m = html.match(/(https?:\/\/download[0-9]*\.mediafire\.com\/[^\s"'<>]+)/i);
      url = m ? m[1] : null;
    }
    if (url) return url.replace(/&amp;/g, '&');
  }
  return null;
}

async function resolveMf(quickKey, fresh) {
  const hit = mfUrlCache.get(quickKey);
  if (!fresh && hit && Date.now() - hit.at < MF_URL_TTL) return hit.url;

  let url = await mfFromApi(quickKey);
  if (!url) url = await mfFromPage(quickKey);
  if (!url) throw new Error('Direct link not found');

  mfUrlCache.set(quickKey, { url, at: Date.now() });
  return url;
}

function sendNode(req, res, node) {
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
      results.push({ link, ok: false, error: err.message || 'Failed to load link' });
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

    sendNode(req, res, hit.node);
  } catch (err) {
    if (!res.headersSent) res.status(500).send('Download failed: ' + (err.message || 'unknown error'));
    else res.destroy();
  }
});

app.get('/dlf/:fileId/:name?', async (req, res) => {
  const { fileId } = req.params;
  const key = req.query.k;
  if (!key) return res.status(400).send('Missing key');

  try {
    const file = await getSingleFile(fileId, key);
    if (!file || file.directory) return res.status(404).send('File not found');
    sendNode(req, res, file);
  } catch (err) {
    if (!res.headersSent) res.status(500).send('Download failed: ' + (err.message || 'unknown error'));
    else res.destroy();
  }
});

app.get('/mf/:key/:name?', async (req, res) => {
  const quickKey = req.params.key;
  const name = req.params.name || 'file';
  const inline = req.query.inline === '1';

  const ac = new AbortController();
  res.on('close', () => ac.abort());

  let upstream = null;
  let lastUrl = null;

  for (let attempt = 0; attempt < 2 && !upstream; attempt++) {
    try {
      lastUrl = await resolveMf(quickKey, attempt > 0);
      const headers = {
        'User-Agent': UA,
        Referer: 'https://www.mediafire.com/',
        'Accept-Language': 'en-US,en;q=0.9'
      };
      if (req.headers.range) headers.Range = req.headers.range;

      const r = await fetch(lastUrl, { headers, redirect: 'follow', signal: ac.signal });
      const ct = r.headers.get('content-type') || '';
      const good = (r.status === 200 || r.status === 206) && !/text\/html/i.test(ct);
      if (good) {
        upstream = r;
      } else {
        try { await r.body.cancel(); } catch (e) {}
        mfUrlCache.delete(quickKey);
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return res.end();
      mfUrlCache.delete(quickKey);
    }
  }

  if (!upstream) {
    if (res.headersSent) return res.destroy();
    return res.redirect(302, lastUrl || 'https://www.mediafire.com/file/' + quickKey + '/file');
  }

  try {
    res.status(upstream.status);
    const pass = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
    for (const h of pass) {
      const v = upstream.headers.get(h);
      if (v) res.set(h, v);
    }
    if (!upstream.headers.get('accept-ranges')) res.set('Accept-Ranges', 'bytes');
    res.set(
      'Content-Disposition',
      (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(name)
    );
    res.set('Cache-Control', 'no-store');

    const body = Readable.fromWeb(upstream.body);
    body.on('error', () => res.destroy());
    body.pipe(res);
  } catch (err) {
    if (res.headersSent) return res.destroy();
    res.status(500).send('Download failed: ' + (err.message || 'unknown error'));
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
.btn.done{background:rgba(52,211,153,.18);border:1px solid var(--ok);color:var(--ok);box-shadow:none}
#results{margin-top:28px;display:grid;gap:22px}
.topbar{padding:20px 22px;display:flex;gap:14px;justify-content:space-between;align-items:center;flex-wrap:wrap;border-color:rgba(124,92,255,.35);background:linear-gradient(120deg,rgba(124,92,255,.14),rgba(34,211,238,.08));animation:rise .5s ease both}
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
  .topbar{padding:16px}
  .topbar .btn{width:100%}
}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="badge"><i></i> Online</span>
    <h1>MegaDL Premium</h1>
    <p>MEGA ও MediaFire — Folder বা Single File লিংক দিন, Direct Download লিংক পেয়ে যান</p>
  </header>

  <section class="card input-card">
    <textarea id="links" spellcheck="false" placeholder="প্রতি লাইনে একটি করে MEGA বা MediaFire লিংক দিন&#10;https://mega.nz/folder/XXXXXXXX#YYYYYYYYYYYY&#10;https://mega.nz/file/XXXXXXXX#YYYYYYYYYYYY&#10;https://www.mediafire.com/folder/XXXXXXXX/name&#10;https://www.mediafire.com/file/XXXXXXXX/name/file"></textarea>
    <div class="row">
      <span class="hint">Folder ও Single File দুটোই দেওয়া যাবে, একসাথে একাধিক (সর্বোচ্চ ২০টি)</span>
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

function flash(btn, msg) {
  var old = btn.getAttribute('data-label') || btn.textContent;
  btn.setAttribute('data-label', old);
  btn.textContent = msg;
  btn.classList.add('done');
  setTimeout(function () {
    btn.textContent = old;
    btn.classList.remove('done');
  }, 1500);
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

  var total = 0;
  results.forEach(function (r) { if (r.ok) total += r.items.length; });

  if (total > 0) {
    var bar = document.createElement('div');
    bar.className = 'card topbar';
    bar.innerHTML =
      '<div><div class="f-title">সব ফাইলের Direct Download লিংক</div>' +
      '<div class="f-meta">মোট ' + total + ' টি ফাইল</div></div>' +
      '<button class="btn btn-primary" data-copyevery="1">Copy All File Links</button>';
    box.appendChild(bar);
  }

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
      '<button class="btn btn-ghost btn-sm" data-copyall="' + ri + '">Copy Folder Links</button></div></div>' + body;
    box.appendChild(el);
  });

  box.onclick = function (e) {
    var c = e.target.closest('[data-copy]');
    if (c) {
      copyText(c.getAttribute('data-copy')).then(function () {
        flash(c, 'Copied!');
        toast('Link copied');
      });
      return;
    }

    var ev = e.target.closest('[data-copyevery]');
    if (ev) {
      var every = [];
      results.forEach(function (r) {
        if (r.ok) r.items.forEach(function (x) { every.push(x.download); });
      });
      copyText(every.join('\n')).then(function () {
        flash(ev, 'Copied ' + every.length + ' Links!');
        toast(every.length + ' টি লিংক কপি হয়েছে');
      });
      return;
    }

    var a = e.target.closest('[data-copyall]');
    if (a) {
      var r = results[parseInt(a.getAttribute('data-copyall'), 10)];
      var text = r.items.map(function (x) { return x.download; }).join('\n');
      copyText(text).then(function () {
        flash(a, 'Copied!');
        toast(r.items.length + ' টি লিংক কপি হয়েছে');
      });
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
