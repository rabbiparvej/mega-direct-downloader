const express = require('express');
const zlib = require('zlib');
const { Readable } = require('stream');
const { File } = require('megajs');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const CACHE_TTL = 30 * 60 * 1000;
const MF_URL_TTL = 8 * 60 * 1000;
const PD_API_KEY = process.env.PIXELDRAIN_API_KEY || '';
const VIDEO_EXT = /\.(mp4|mkv|webm|avi|mov|m4v|flv|wmv|ts|3gp|mpg|mpeg|ogv)$/i;
const MEGA_RE = /mega\.nz\/folder\/([A-Za-z0-9_-]+)#([A-Za-z0-9_-]+)(?:\/(folder|file)\/([A-Za-z0-9_-]+))?/i;
const MEGA_FILE_RE = /mega\.nz\/(?:file\/([A-Za-z0-9_-]+)#|#!([A-Za-z0-9_-]+)!)([A-Za-z0-9_-]+)/i;
const MF_FOLDER_RE = /mediafire\.com\/folder\/([A-Za-z0-9]+)/i;
const MF_FILE_RE = /mediafire\.com\/(?:file|file_premium|view|download)\/([A-Za-z0-9]+)|mediafire\.com\/\?([A-Za-z0-9]+)/i;
const PD_LIST_RE = /(?:pixeldrain\.(?:com|net|dev|nl|biz|tech)|pixeldra\.in)\/l\/([A-Za-z0-9_-]+)/i;
const PD_FILE_RE = /(?:pixeldrain\.(?:com|net|dev|nl|biz|tech)|pixeldra\.in)\/(?:u|api\/file)\/([A-Za-z0-9_-]+)/i;
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
const pdZipCache = new Map();
const pdZipPending = new Map();

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
  for (const [k, v] of pdZipCache) if (now - v.at > CACHE_TTL) pdZipCache.delete(k);
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

function videoMime(name) {
  return /\.mp4$|\.m4v$/i.test(name) ? 'video/mp4'
    : /\.webm$/i.test(name) ? 'video/webm'
    : /\.mkv$/i.test(name) ? 'video/x-matroska'
    : /\.mov$/i.test(name) ? 'video/quicktime'
    : /\.ogv$/i.test(name) ? 'video/ogg'
    : 'application/octet-stream';
}

function parseRangeHeader(range, size) {
  if (!range) return { status: 200, start: 0, end: size - 1 };
  const rm = /bytes=(\d*)-(\d*)/.exec(range);
  if (!rm) return { status: 200, start: 0, end: size - 1 };

  let start = 0;
  let end = size - 1;
  if (rm[1] !== '') {
    start = parseInt(rm[1], 10);
    if (rm[2] !== '') end = Math.min(parseInt(rm[2], 10), size - 1);
  } else if (rm[2] !== '') {
    start = Math.max(size - parseInt(rm[2], 10), 0);
  }
  if (start > end || start >= size) return { invalid: true };
  return { status: 206, start, end };
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

function pdHeaders(extra = {}) {
  const h = { 'User-Agent': UA, ...extra };
  if (PD_API_KEY) {
    h.Authorization = 'Basic ' + Buffer.from(':' + PD_API_KEY).toString('base64');
  }
  return h;
}

async function pdJson(path) {
  const r = await fetch('https://pixeldrain.com/api/' + path, {
    headers: pdHeaders({ Accept: 'application/json' }),
    signal: AbortSignal.timeout(15000)
  });
  let j = null;
  try { j = await r.json(); } catch (e) {}
  if (!r.ok || (j && j.success === false)) {
    throw new Error((j && j.message) || 'PixelDrain error (' + r.status + ')');
  }
  return j;
}

async function pdFetchRange(fileId, start, end) {
  const r = await fetch('https://pixeldrain.com/api/file/' + fileId, {
    headers: pdHeaders({
      'Accept-Encoding': 'identity',
      Range: 'bytes=' + start + '-' + end
    }),
    signal: AbortSignal.timeout(25000)
  });
  if (r.status !== 206 && r.status !== 200) {
    try { if (r.body) await r.body.cancel(); } catch (e) {}
    throw new Error('PixelDrain ZIP read failed (' + r.status + ')');
  }
  return Buffer.from(await r.arrayBuffer());
}

function findEocd(buf) {
  let fallback = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) return i;
      if (fallback === -1) fallback = i;
    }
  }
  return fallback;
}

async function parseRemoteZip(fileId, fileSize) {
  if (!fileSize || fileSize < 22) throw new Error('Invalid or empty ZIP file');

  const tailLen = Math.min(fileSize, 65557);
  const tailStart = fileSize - tailLen;
  const tailBuf = await pdFetchRange(fileId, tailStart, fileSize - 1);

  const eocdPos = findEocd(tailBuf);
  if (eocdPos < 0) throw new Error('ZIP directory not found');

  let totalEntries = tailBuf.readUInt16LE(eocdPos + 10);
  let cdSize = tailBuf.readUInt32LE(eocdPos + 12);
  let cdOffset = tailBuf.readUInt32LE(eocdPos + 16);

  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || totalEntries === 0xffff) {
    if (eocdPos >= 20 && tailBuf.readUInt32LE(eocdPos - 20) === 0x07064b50) {
      const z64Off = Number(tailBuf.readBigUInt64LE(eocdPos - 20 + 8));
      let z64Buf;
      if (z64Off >= tailStart && z64Off + 56 <= fileSize) {
        z64Buf = tailBuf.subarray(z64Off - tailStart);
      } else {
        z64Buf = await pdFetchRange(fileId, z64Off, Math.min(fileSize - 1, z64Off + 55));
      }
      if (z64Buf.length >= 56 && z64Buf.readUInt32LE(0) === 0x06064b50) {
        cdSize = Number(z64Buf.readBigUInt64LE(40));
        cdOffset = Number(z64Buf.readBigUInt64LE(48));
      }
    }
  }

  if (cdSize > 32 * 1024 * 1024) throw new Error('ZIP directory too large');

  let cdBuf;
  if (cdOffset >= tailStart && cdOffset + cdSize <= fileSize) {
    cdBuf = tailBuf.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize);
  } else {
    cdBuf = await pdFetchRange(fileId, cdOffset, cdOffset + cdSize - 1);
  }

  const entries = [];
  let p = 0;
  while (p + 46 <= cdBuf.length && cdBuf.readUInt32LE(p) === 0x02014b50) {
    const flags = cdBuf.readUInt16LE(p + 8);
    const method = cdBuf.readUInt16LE(p + 10);
    let compSize = cdBuf.readUInt32LE(p + 20);
    let uncompSize = cdBuf.readUInt32LE(p + 24);
    const nameLen = cdBuf.readUInt16LE(p + 28);
    const extraLen = cdBuf.readUInt16LE(p + 30);
    const commentLen = cdBuf.readUInt16LE(p + 32);
    let localHeaderOffset = cdBuf.readUInt32LE(p + 42);

    const enc = (flags & 0x0800) ? 'utf8' : 'latin1';
    const rawName = cdBuf.subarray(p + 46, p + 46 + nameLen).toString(enc);

    let ep = p + 46 + nameLen;
    const extraEnd = ep + extraLen;
    while (ep + 4 <= extraEnd) {
      const eid = cdBuf.readUInt16LE(ep);
      const esz = cdBuf.readUInt16LE(ep + 2);
      if (eid === 0x0001 && ep + 4 + esz <= extraEnd) {
        let zp = ep + 4;
        if (uncompSize === 0xffffffff && zp + 8 <= ep + 4 + esz) {
          uncompSize = Number(cdBuf.readBigUInt64LE(zp));
          zp += 8;
        }
        if (compSize === 0xffffffff && zp + 8 <= ep + 4 + esz) {
          compSize = Number(cdBuf.readBigUInt64LE(zp));
          zp += 8;
        }
        if (localHeaderOffset === 0xffffffff && zp + 8 <= ep + 4 + esz) {
          localHeaderOffset = Number(cdBuf.readBigUInt64LE(zp));
        }
        break;
      }
      ep += 4 + esz;
    }

    entries.push({
      cdIndex: entries.length,
      fullPath: rawName,
      encrypted: (flags & 0x0001) !== 0,
      method,
      compSize,
      uncompSize,
      localHeaderOffset
    });

    p += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

async function getPdZip(fileId, knownInfo) {
  const hit = pdZipCache.get(fileId);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit;
  if (pdZipPending.has(fileId)) return pdZipPending.get(fileId);

  const job = (async () => {
    const info = knownInfo || (await pdJson('file/' + fileId + '/info'));
    const entries = await parseRemoteZip(fileId, info.size);
    const data = {
      title: info.name || 'PixelDrain ZIP',
      dateUpload: info.date_upload || null,
      entries,
      at: Date.now()
    };
    pdZipCache.set(fileId, data);
    return data;
  })();

  pdZipPending.set(fileId, job);
  try {
    return await job;
  } finally {
    pdZipPending.delete(fileId);
  }
}

async function listPdFile(link, origin) {
  const m = String(link).trim().match(PD_FILE_RE);
  if (!m) throw new Error('Invalid PixelDrain file link');
  const fileId = m[1];

  const info = await pdJson('file/' + fileId + '/info');
  const name = info.name || 'file';
  const size = info.size || 0;
  const isZip = /\.zip$/i.test(name) || /zip/i.test(info.mime_type || '');

  if (isZip) {
    const zip = await getPdZip(fileId, info);
    const videos = zip.entries
      .filter((e) => !e.fullPath.endsWith('/') && !/^__MACOSX\//i.test(e.fullPath))
      .map((e) => {
        const clean = e.fullPath.replace(/\\/g, '/').replace(/^\/+/, '');
        const parts = clean.split('/').filter(Boolean);
        const fileName = parts.pop() || clean;
        return {
          ...e,
          name: fileName,
          path: parts.join(' / ')
        };
      })
      .filter((e) => VIDEO_EXT.test(e.name) && !e.encrypted);

    if (!videos.length) {
      throw new Error('No playable video files found inside this ZIP');
    }

    videos.sort((a, b) => collator.compare(a.path, b.path) || collator.compare(a.name, b.name));

    const items = videos.map((v, i) => {
      const dl = origin + '/pdz/' + fileId + '/' + v.cdIndex + '/' + encodeURIComponent(v.name);
      return {
        index: i + 1,
        name: v.name,
        path: v.path,
        size: v.uncompSize,
        sizeText: formatSize(v.uncompSize),
        download: dl,
        stream: dl + '?inline=1'
      };
    });

    return {
      ok: true,
      title: name,
      count: items.length,
      totalSize: formatSize(items.reduce((s, x) => s + (x.size || 0), 0)),
      items
    };
  }

  const dl = origin + '/pd/' + fileId + '/' + encodeURIComponent(name);
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

async function listPdList(link, origin) {
  const m = String(link).trim().match(PD_LIST_RE);
  if (!m) throw new Error('Invalid PixelDrain list link');
  const listId = m[1];

  const data = await pdJson('list/' + listId);
  const title = data.title || 'PixelDrain List';
  const videos = (data.files || []).filter((f) => VIDEO_EXT.test(f.name || ''));

  videos.sort((a, b) => collator.compare(a.name || '', b.name || ''));

  const items = videos.map((f, i) => {
    const name = f.name || 'video';
    const dl = origin + '/pd/' + f.id + '/' + encodeURIComponent(name);
    return {
      index: i + 1,
      name,
      path: '',
      size: f.size || 0,
      sizeText: formatSize(f.size || 0),
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

async function listLink(link, origin) {
  const text = String(link).trim();
  if (MEGA_RE.test(text)) return listFolderLink(text, origin);
  if (MEGA_FILE_RE.test(text)) return listSingleLink(text, origin);
  if (MF_FOLDER_RE.test(text)) return listMfFolder(text, origin);
  if (MF_FILE_RE.test(text)) return listMfFile(text, origin);
  if (PD_LIST_RE.test(text)) return listPdList(text, origin);
  if (PD_FILE_RE.test(text)) return listPdFile(text, origin);
  throw new Error('Invalid link (MEGA, MediaFire or PixelDrain only)');
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

  const mime = videoMime(name);

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

app.get('/pd/:id/:name?', async (req, res) => {
  const fileId = req.params.id;
  const name = req.params.name || 'file';
  const inline = req.query.inline === '1';
  const syntheticEtag = '"pd-' + fileId + '"';

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  try {
    const headers = pdHeaders({ 'Accept-Encoding': 'identity' });
    if (req.headers.range) headers.Range = req.headers.range;
    if (req.headers['if-range'] && req.headers['if-range'] !== syntheticEtag) {
      headers['If-Range'] = req.headers['if-range'];
    }

    const upstream = await fetch('https://pixeldrain.com/api/file/' + fileId, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      redirect: 'follow',
      signal: ac.signal
    });

    if (upstream.status === 416) {
      const cr = upstream.headers.get('content-range');
      try { if (upstream.body) await upstream.body.cancel(); } catch (e) {}
      res.status(416);
      if (cr) res.set('Content-Range', cr);
      return res.end();
    }

    if (upstream.status === 404) {
      try { if (upstream.body) await upstream.body.cancel(); } catch (e) {}
      return res.status(404).send('File not found on PixelDrain');
    }

    if (upstream.status !== 200 && upstream.status !== 206) {
      try { if (upstream.body) await upstream.body.cancel(); } catch (e) {}
      if (req.headers.range || req.method === 'HEAD') {
        return res.status(upstream.status === 429 ? 429 : 503).send('PixelDrain temporarily unavailable');
      }
      return res.redirect(302, 'https://pixeldrain.com/u/' + fileId);
    }

    res.status(upstream.status);
    const pass = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified'];
    for (const h of pass) {
      const v = upstream.headers.get(h);
      if (v) res.set(h, v);
    }

    const upEtag = upstream.headers.get('etag');
    if (upEtag && !/^W\//i.test(upEtag)) {
      res.set('ETag', upEtag);
    } else {
      res.set('ETag', syntheticEtag);
    }

    if (!upstream.headers.get('accept-ranges')) res.set('Accept-Ranges', 'bytes');
    if (/\.mp4$|\.m4v$|\.webm$|\.mkv$/i.test(name)) {
      res.set('Content-Type', videoMime(name));
    }
    res.set(
      'Content-Disposition',
      (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(name)
    );
    res.set('Cache-Control', 'private, no-cache');

    if (req.method === 'HEAD') {
      try { if (upstream.body) await upstream.body.cancel(); } catch (e) {}
      return res.end();
    }

    const body = Readable.fromWeb(upstream.body);
    body.on('error', () => res.destroy());
    body.pipe(res);
  } catch (err) {
    if (err && err.name === 'AbortError') return res.end();
    if (res.headersSent) return res.destroy();
    res.status(500).send('Download failed: ' + (err.message || 'unknown error'));
  }
});

app.get('/pdz/:id/:idx/:name?', async (req, res) => {
  const fileId = req.params.id;
  const idx = parseInt(req.params.idx, 10);
  const inline = req.query.inline === '1';

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  try {
    const zip = await getPdZip(fileId);
    const entry = zip.entries[idx];
    if (!entry) return res.status(404).send('File not found in ZIP');
    if (entry.encrypted) return res.status(400).send('Encrypted ZIP entries are not supported');
    if (entry.method !== 0 && entry.method !== 8) {
      return res.status(415).send('Unsupported ZIP compression method (' + entry.method + ')');
    }

    if (entry.dataOffset === undefined) {
      const lh = await pdFetchRange(fileId, entry.localHeaderOffset, entry.localHeaderOffset + 29);
      if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) {
        return res.status(500).send('Invalid ZIP local header');
      }
      const lNameLen = lh.readUInt16LE(26);
      const lExtraLen = lh.readUInt16LE(28);
      entry.dataOffset = entry.localHeaderOffset + 30 + lNameLen + lExtraLen;
    }

    const name = req.params.name || entry.fullPath.split('/').pop() || 'video';
    const mime = videoMime(name);
    const disposition = (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(name);
    const size = entry.uncompSize;
    const etag = '"pdz-' + fileId + '-' + idx + '-' + size + '"';
    const lastMod = zip.dateUpload
      ? new Date(zip.dateUpload).toUTCString()
      : 'Thu, 01 Jan 2026 00:00:00 GMT';

    if (size === 0) {
      res.status(200).set({
        'Content-Type': mime,
        'Content-Length': 0,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': disposition,
        'ETag': etag,
        'Last-Modified': lastMod,
        'Cache-Control': 'private, no-cache'
      });
      return res.end();
    }

    let useRange = req.headers.range;
    const ifRange = req.headers['if-range'];
    if (useRange && ifRange && ifRange !== etag && ifRange !== lastMod) {
      useRange = null;
    }

    const rInfo = parseRangeHeader(useRange, size);
    if (rInfo.invalid) {
      res.status(416).set('Content-Range', 'bytes */' + size);
      return res.end();
    }

    res.status(rInfo.status);
    res.set({
      'Content-Type': mime,
      'Content-Length': rInfo.end - rInfo.start + 1,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': disposition,
      'ETag': etag,
      'Last-Modified': lastMod,
      'Cache-Control': 'private, no-cache'
    });
    if (rInfo.status === 206) {
      res.set('Content-Range', 'bytes ' + rInfo.start + '-' + rInfo.end + '/' + size);
    }

    if (req.method === 'HEAD') {
      return res.end();
    }

    if (entry.method === 0) {
      const upstream = await fetch('https://pixeldrain.com/api/file/' + fileId, {
        headers: pdHeaders({
          'Accept-Encoding': 'identity',
          Range: 'bytes=' + (entry.dataOffset + rInfo.start) + '-' + (entry.dataOffset + rInfo.end)
        }),
        signal: ac.signal
      });

      if (upstream.status !== 200 && upstream.status !== 206) {
        try { if (upstream.body) await upstream.body.cancel(); } catch (e) {}
        return res.status(502).send('PixelDrain upstream error (' + upstream.status + ')');
      }

      const body = Readable.fromWeb(upstream.body);
      body.on('error', () => res.destroy());
      return body.pipe(res);
    }

    const upstream = await fetch('https://pixeldrain.com/api/file/' + fileId, {
      headers: pdHeaders({
        'Accept-Encoding': 'identity',
        Range: 'bytes=' + entry.dataOffset + '-' + (entry.dataOffset + entry.compSize - 1)
      }),
      signal: ac.signal
    });

    if (upstream.status !== 200 && upstream.status !== 206) {
      try { if (upstream.body) await upstream.body.cancel(); } catch (e) {}
      return res.status(502).send('PixelDrain upstream error (' + upstream.status + ')');
    }

    const body = Readable.fromWeb(upstream.body);
    const inflate = zlib.createInflateRaw();
    const start = rInfo.start;
    const needed = rInfo.end - rInfo.start + 1;
    let pos = 0;
    let sent = 0;
    let finished = false;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      ac.abort();
      body.destroy();
      inflate.destroy();
    };

    inflate.on('data', (chunk) => {
      if (finished) return;
      const chunkStart = pos;
      const chunkEnd = pos + chunk.length;
      pos = chunkEnd;

      if (chunkEnd <= start) return;
      if (sent >= needed) return;

      const sliceFrom = Math.max(0, start - chunkStart);
      const remaining = needed - sent;
      const sliceTo = Math.min(chunk.length, sliceFrom + remaining);
      if (sliceTo > sliceFrom) {
        const out = (sliceFrom === 0 && sliceTo === chunk.length)
          ? chunk
          : chunk.subarray(sliceFrom, sliceTo);
        sent += out.length;
        if (!res.write(out)) inflate.pause();
      }
      if (sent >= needed) {
        res.end();
        cleanup();
      }
    });

    res.on('drain', () => {
      if (!finished) inflate.resume();
    });

    inflate.on('end', () => {
      if (!finished) {
        finished = true;
        res.end();
      }
    });

    body.on('error', () => { cleanup(); res.destroy(); });
    inflate.on('error', () => { cleanup(); res.destroy(); });
    res.on('close', () => {
      if (!res.writableEnded) cleanup();
    });

    body.pipe(inflate);
  } catch (err) {
    if (err && err.name === 'AbortError') return res.end();
    if (res.headersSent) return res.destroy();
    res.status(500).send('Download failed: ' + (err.message || 'unknown error'));
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PAGE = String.raw`<!DOCTYPE html>
<html lang="bn" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#06060c">
<title>MegaDL Premium</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Hind+Siliguri:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#06060c;
  --bg-soft:#0c0c16;
  --panel:rgba(255,255,255,.04);
  --panel-2:rgba(255,255,255,.075);
  --panel-3:rgba(255,255,255,.11);
  --line:rgba(255,255,255,.08);
  --line-2:rgba(255,255,255,.15);
  --text:#f4f4fb;
  --muted:#9494ad;
  --a1:#8b5cf6;
  --a2:#22d3ee;
  --a3:#f472b6;
  --ok:#34d399;
  --warn:#fbbf24;
  --err:#fb7185;
  --shadow:0 30px 80px rgba(0,0,0,.55);
  --input:rgba(0,0,0,.4);
  --grad:linear-gradient(120deg,var(--a1),var(--a2));
  --orb:.38;
}
html[data-theme="light"]{
  --bg:#f4f5fb;
  --bg-soft:#ffffff;
  --panel:rgba(255,255,255,.72);
  --panel-2:rgba(20,20,60,.05);
  --panel-3:rgba(20,20,60,.09);
  --line:rgba(20,20,60,.09);
  --line-2:rgba(20,20,60,.18);
  --text:#14142b;
  --muted:#65657f;
  --shadow:0 24px 60px rgba(40,40,100,.14);
  --input:rgba(255,255,255,.85);
  --orb:.22;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{
  font-family:'Inter','Hind Siliguri',system-ui,sans-serif;
  background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden;
  -webkit-font-smoothing:antialiased;transition:background .4s,color .4s;
}
.orb{position:fixed;border-radius:50%;filter:blur(110px);opacity:var(--orb);z-index:-2;pointer-events:none;animation:float 18s ease-in-out infinite}
.orb.o1{width:560px;height:560px;background:var(--a1);top:-180px;left:-140px}
.orb.o2{width:480px;height:480px;background:var(--a2);bottom:-180px;right:-120px;animation-delay:-6s}
.orb.o3{width:360px;height:360px;background:var(--a3);top:38%;left:58%;opacity:calc(var(--orb) * .55);animation-delay:-11s}
@keyframes float{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(40px,-30px) scale(1.08)}66%{transform:translate(-30px,40px) scale(.94)}}
.grid-bg{position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:.5;
  background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);
  background-size:56px 56px;
  -webkit-mask-image:radial-gradient(ellipse at 50% 0%,#000 10%,transparent 70%);
  mask-image:radial-gradient(ellipse at 50% 0%,#000 10%,transparent 70%)}
.wrap{max-width:1120px;margin:0 auto;padding:28px 20px 120px}
nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:42px}
.brand{display:flex;align-items:center;gap:12px;font-weight:800;letter-spacing:-.02em;font-size:18px}
.logo{width:38px;height:38px;border-radius:12px;background:var(--grad);display:grid;place-items:center;box-shadow:0 10px 30px rgba(139,92,246,.45)}
.logo svg{width:20px;height:20px;fill:none;stroke:#fff;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.nav-r{display:flex;gap:10px;align-items:center}
.status{display:inline-flex;align-items:center;gap:8px;padding:7px 14px;border:1px solid var(--line);border-radius:999px;background:var(--panel);font-size:12px;color:var(--muted);font-weight:500}
.status i{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 0 var(--ok);animation:pulse 2s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.6)}70%{box-shadow:0 0 0 9px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}
.icon-btn{width:40px;height:40px;border-radius:12px;border:1px solid var(--line);background:var(--panel);color:var(--text);cursor:pointer;display:grid;place-items:center;transition:.2s}
.icon-btn:hover{background:var(--panel-3);transform:translateY(-1px)}
.icon-btn svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.hero{text-align:center;margin-bottom:38px}
.hero h1{font-size:clamp(38px,7vw,68px);font-weight:800;letter-spacing:-.04em;line-height:1.05;margin-bottom:16px;
  background:linear-gradient(110deg,var(--text) 10%,var(--a2) 50%,var(--a1) 75%,var(--a3));
  background-size:200% auto;-webkit-background-clip:text;background-clip:text;color:transparent;animation:shine 8s linear infinite}
@keyframes shine{to{background-position:200% center}}
.hero p{color:var(--muted);font-size:16px;max-width:620px;margin:0 auto;line-height:1.7}
.chips{display:flex;justify-content:center;gap:10px;flex-wrap:wrap;margin-top:22px}
.chip{display:inline-flex;align-items:center;gap:8px;padding:7px 14px;border-radius:999px;border:1px solid var(--line);background:var(--panel);font-size:12.5px;font-weight:600;color:var(--muted)}
.chip b{width:8px;height:8px;border-radius:50%}
.card{background:var(--panel);border:1px solid var(--line);border-radius:24px;backdrop-filter:blur(22px) saturate(140%);-webkit-backdrop-filter:blur(22px) saturate(140%);box-shadow:var(--shadow)}
.input-card{padding:8px;position:relative;overflow:hidden}
.input-card::before{content:'';position:absolute;inset:0;border-radius:24px;padding:1px;background:linear-gradient(130deg,rgba(139,92,246,.7),transparent 35%,transparent 65%,rgba(34,211,238,.7));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;opacity:.7}
.ta-wrap{position:relative}
textarea{width:100%;min-height:150px;resize:vertical;padding:20px 22px 48px;border-radius:18px;border:0;background:var(--input);color:var(--text);font:500 14px/1.7 'JetBrains Mono','Inter',monospace;outline:none;transition:.2s}
textarea:focus{box-shadow:0 0 0 3px rgba(139,92,246,.28)}
textarea::placeholder{color:var(--muted);opacity:.75}
.ta-tools{position:absolute;left:14px;right:14px;bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:10px;pointer-events:none}
.ta-tools > *{pointer-events:auto}
.counter{font-size:12px;color:var(--muted);font-weight:600;padding:4px 10px;border-radius:8px;background:var(--panel-2)}
.mini{font:600 12px 'Inter',sans-serif;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel-2);color:var(--text);cursor:pointer;transition:.2s}
.mini:hover{background:var(--panel-3)}
.row{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:14px 14px 10px;flex-wrap:wrap}
.hint{font-size:13px;color:var(--muted);line-height:1.5}
.kbd{font:600 11px 'Inter',sans-serif;padding:2px 7px;border-radius:6px;border:1px solid var(--line-2);background:var(--panel-2);margin:0 2px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;cursor:pointer;font:600 14px 'Inter','Hind Siliguri',sans-serif;padding:12px 22px;border-radius:13px;color:var(--text);text-decoration:none;transition:.2s;white-space:nowrap;position:relative}
.btn svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.btn-primary{color:#fff;background:var(--grad);box-shadow:0 12px 32px rgba(139,92,246,.4);overflow:hidden}
.btn-primary::after{content:'';position:absolute;top:0;left:-120%;width:60%;height:100%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.35),transparent);transform:skewX(-20deg);transition:.6s}
.btn-primary:hover{transform:translateY(-2px);box-shadow:0 16px 42px rgba(139,92,246,.55)}
.btn-primary:hover::after{left:140%}
.btn-primary:disabled{opacity:.65;cursor:wait;transform:none}
.btn-ghost{background:var(--panel-2);border:1px solid var(--line)}
.btn-ghost:hover{background:var(--panel-3);border-color:var(--line-2)}
.btn-sm{padding:9px 14px;font-size:13px;border-radius:10px}
.btn.done{background:rgba(52,211,153,.16)!important;border:1px solid var(--ok)!important;color:var(--ok)!important;box-shadow:none!important}
#results{margin-top:30px;display:grid;gap:22px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;animation:rise .5s ease both}
.stat{padding:18px 20px;border-radius:20px}
.stat small{display:block;color:var(--muted);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
.stat strong{font-size:26px;font-weight:800;letter-spacing:-.02em;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.topbar{padding:20px 24px;display:flex;gap:14px;justify-content:space-between;align-items:center;flex-wrap:wrap;border-color:rgba(139,92,246,.35);background:linear-gradient(120deg,rgba(139,92,246,.16),rgba(34,211,238,.08));animation:rise .5s ease both}
.tb-actions{display:flex;gap:10px;flex-wrap:wrap}
.folder{overflow:hidden;animation:rise .55s ease both}
@keyframes rise{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
.f-head{padding:20px 24px;display:flex;gap:16px;justify-content:space-between;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--line);background:linear-gradient(180deg,var(--panel-2),transparent)}
.f-id{display:flex;gap:14px;align-items:center;min-width:0}
.f-ico{width:46px;height:46px;border-radius:14px;flex:none;display:grid;place-items:center;border:1px solid var(--line);background:linear-gradient(135deg,rgba(139,92,246,.28),rgba(34,211,238,.18))}
.f-ico svg{width:22px;height:22px;fill:none;stroke:var(--text);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.f-title{font-size:18px;font-weight:700;word-break:break-word;letter-spacing:-.01em}
.f-meta{font-size:13px;color:var(--muted);margin-top:4px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.src{font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;letter-spacing:.04em}
.src.mega{background:rgba(251,113,133,.14);color:var(--err);border:1px solid rgba(251,113,133,.35)}
.src.mf{background:rgba(34,211,238,.12);color:var(--a2);border:1px solid rgba(34,211,238,.35)}
.src.pd{background:rgba(139,92,246,.16);color:#c4b5fd;border:1px solid rgba(139,92,246,.4)}
.f-tools{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.search,.select{padding:10px 14px;border-radius:11px;border:1px solid var(--line);background:var(--input);color:var(--text);font:500 13px 'Inter','Hind Siliguri',sans-serif;outline:none;transition:.2s}
.search{min-width:180px}
.select{cursor:pointer;appearance:none;-webkit-appearance:none;padding-right:14px}
.select option{background:var(--bg-soft);color:var(--text)}
.search:focus,.select:focus{border-color:var(--a2);box-shadow:0 0 0 3px rgba(34,211,238,.15)}
.selbar{display:flex;align-items:center;gap:12px;padding:10px 24px;border-bottom:1px solid var(--line);font-size:13px;color:var(--muted)}
.cb{appearance:none;-webkit-appearance:none;width:20px;height:20px;border-radius:7px;border:1.5px solid var(--line-2);background:var(--input);cursor:pointer;display:grid;place-items:center;transition:.15s;flex:none}
.cb:checked{background:var(--grad);border-color:transparent}
.cb:checked::after{content:'';width:5px;height:9px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg) translate(-1px,-1px)}
.list{list-style:none}
.item{display:grid;grid-template-columns:22px 44px 1fr auto;gap:14px;align-items:center;padding:14px 24px;border-bottom:1px solid var(--line);transition:.15s;position:relative}
.item:last-child{border-bottom:0}
.item:hover{background:var(--panel-2)}
.item.sel{background:linear-gradient(90deg,rgba(139,92,246,.14),transparent)}
.item.sel::before{content:'';position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:3px;background:var(--grad)}
.idx{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;font-weight:700;font-size:13px;background:linear-gradient(135deg,rgba(139,92,246,.26),rgba(34,211,238,.16));border:1px solid var(--line)}
.name{font-weight:600;font-size:14.5px;word-break:break-word;line-height:1.45}
.sub{font-size:12px;color:var(--muted);margin-top:5px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.pill{padding:2px 9px;border-radius:999px;background:var(--panel-2);border:1px solid var(--line);font-weight:600}
.pill.ext{color:var(--a2);border-color:rgba(34,211,238,.35);text-transform:uppercase;letter-spacing:.04em;font-size:11px}
.actions{display:flex;gap:8px}
.err{padding:22px 24px;color:var(--err);font-weight:600;display:flex;gap:12px;align-items:flex-start}
.err .f-meta{word-break:break-all;font-weight:500}
.empty{padding:34px;text-align:center;color:var(--muted)}
.skeleton{padding:22px 24px;display:grid;gap:14px}
.sk{height:54px;border-radius:14px;background:linear-gradient(100deg,var(--panel-2) 30%,var(--panel-3) 50%,var(--panel-2) 70%);background-size:300% 100%;animation:sk 1.3s ease infinite}
@keyframes sk{from{background-position:100% 0}to{background-position:-100% 0}}
.spinner{width:16px;height:16px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.floatbar{position:fixed;left:50%;bottom:24px;transform:translate(-50%,120px);z-index:40;display:flex;align-items:center;gap:12px;padding:12px 14px 12px 20px;border-radius:18px;background:var(--bg-soft);border:1px solid var(--line-2);box-shadow:0 24px 70px rgba(0,0,0,.55);opacity:0;transition:.35s cubic-bezier(.2,.9,.3,1.2);max-width:calc(100vw - 24px);flex-wrap:wrap;justify-content:center}
.floatbar.show{transform:translate(-50%,0);opacity:1}
.floatbar span{font-weight:700;font-size:14px;margin-right:4px}
.toasts{position:fixed;top:20px;right:20px;z-index:80;display:grid;gap:10px;pointer-events:none}
.toast{background:var(--bg-soft);border:1px solid var(--line-2);padding:12px 18px;border-radius:14px;font-size:14px;font-weight:500;box-shadow:0 16px 40px rgba(0,0,0,.4);display:flex;align-items:center;gap:10px;animation:tin .35s cubic-bezier(.2,.9,.3,1.2) both}
.toast::before{content:'';width:8px;height:8px;border-radius:50%;background:var(--ok);flex:none}
.toast.bad::before{background:var(--err)}
.toast.out{animation:tout .3s ease both}
@keyframes tin{from{opacity:0;transform:translateX(30px)}to{opacity:1;transform:none}}
@keyframes tout{to{opacity:0;transform:translateX(30px)}}
.modal{position:fixed;inset:0;z-index:100;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(3,3,8,.78);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.modal.show{display:flex;animation:fade .25s ease both}
@keyframes fade{from{opacity:0}to{opacity:1}}
.player{width:100%;max-width:960px;border-radius:22px;overflow:hidden;background:#000;border:1px solid var(--line-2);box-shadow:0 40px 100px rgba(0,0,0,.7)}
.p-head{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:14px 18px;background:var(--bg-soft);color:var(--text)}
.p-head b{font-size:14px;word-break:break-word}
.player video{display:block;width:100%;max-height:70vh;background:#000}
footer{text-align:center;margin-top:60px;color:var(--muted);font-size:13px}
footer b{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
@media(max-width:720px){
  .wrap{padding:20px 14px 130px}
  nav{margin-bottom:28px}
  .status{display:none}
  .item{grid-template-columns:22px 1fr;padding:14px 16px;gap:12px}
  .item .idx{display:none}
  .actions{grid-column:1 / -1}
  .actions .btn{flex:1}
  .f-head,.selbar{padding-left:16px;padding-right:16px}
  .search{flex:1;min-width:0}
  .topbar{padding:16px}
  .tb-actions{width:100%}
  .tb-actions .btn{flex:1}
  .toasts{left:14px;right:14px;top:14px}
}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="orb o1"></div><div class="orb o2"></div><div class="orb o3"></div><div class="grid-bg"></div>

<div class="wrap">
  <nav>
    <div class="brand">
      <div class="logo"><svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/></svg></div>
      MegaDL
    </div>
    <div class="nav-r">
      <span class="status"><i></i> Server Online</span>
      <button class="icon-btn" id="theme" title="Theme" aria-label="Theme">
        <svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
      </button>
    </div>
  </nav>

  <header class="hero">
    <h1>MegaDL Premium</h1>
    <p>MEGA, MediaFire ও PixelDrain এর Folder, ZIP বা Single File লিংক দিন, মুহূর্তেই Direct Download ও Stream লিংক পেয়ে যান।</p>
    <div class="chips">
      <span class="chip"><b style="background:var(--err)"></b>MEGA Folder &amp; File</span>
      <span class="chip"><b style="background:var(--a2)"></b>MediaFire Folder &amp; File</span>
      <span class="chip"><b style="background:var(--a1)"></b>PixelDrain Video &amp; ZIP</span>
      <span class="chip"><b style="background:var(--ok)"></b>Resume &amp; Stream Support</span>
    </div>
  </header>

  <section class="card input-card">
    <div class="ta-wrap">
      <textarea id="links" spellcheck="false" placeholder="প্রতি লাইনে একটি করে MEGA, MediaFire বা PixelDrain লিংক দিন&#10;https://mega.nz/folder/XXXXXXXX#YYYYYYYYYYYY&#10;https://www.mediafire.com/folder/XXXXXXXX/name&#10;https://pixeldrain.com/u/XXXXXXXX&#10;https://pixeldrain.com/l/XXXXXXXX"></textarea>
      <div class="ta-tools">
        <span class="counter" id="counter">0 লিংক</span>
        <span style="display:flex;gap:8px">
          <button class="mini" id="paste" type="button">Paste</button>
          <button class="mini" id="clear" type="button">Clear</button>
        </span>
      </div>
    </div>
    <div class="row">
      <span class="hint">একসাথে সর্বোচ্চ ২০টি লিংক · <span class="kbd">Ctrl</span>+<span class="kbd">Enter</span> চাপলেই Generate</span>
      <button class="btn btn-primary" id="go">
        <svg viewBox="0 0 24 24"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>
        <span id="goLabel">Generate Links</span>
      </button>
    </div>
  </section>

  <div id="results"></div>
  <footer>Powered by <b>MegaDL API</b></footer>
</div>

<div class="floatbar" id="floatbar">
  <span id="selCount">0 selected</span>
  <button class="btn btn-primary btn-sm" id="selCopy">Copy Links</button>
  <button class="btn btn-ghost btn-sm" id="selTxt">Download .txt</button>
  <button class="btn btn-ghost btn-sm" id="selClear">Clear</button>
</div>

<div class="toasts" id="toasts"></div>

<div class="modal" id="modal">
  <div class="player">
    <div class="p-head"><b id="pTitle"></b><button class="btn btn-ghost btn-sm" id="pClose">Close</button></div>
    <video id="video" controls playsinline preload="metadata"></video>
  </div>
</div>

<script>
var $ = function (s) { return document.querySelector(s); };
var state = { results: [], sel: {}, q: {}, sort: {} };
var ICON_FOLDER = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
var ICON_FILE = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M10 9l5 3-5 3z"/></svg>';
var ICON_WARN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>';

function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

(function initTheme() {
  var t = load('megadl-theme');
  if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
})();

$('#theme').addEventListener('click', function () {
  var root = document.documentElement;
  var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  root.setAttribute('data-theme', next);
  store('megadl-theme', next);
});

function toast(msg, bad) {
  var box = $('#toasts');
  var t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(function () {
    t.classList.add('out');
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
  }, 2000);
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
  var old = btn.getAttribute('data-label') || btn.innerHTML;
  btn.setAttribute('data-label', old);
  btn.textContent = msg;
  btn.classList.add('done');
  setTimeout(function () {
    btn.innerHTML = old;
    btn.classList.remove('done');
  }, 1400);
}

function saveTxt(name, text) {
  var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}

function extOf(name) {
  var m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m ? m[1] : 'file';
}

function srcOf(link) {
  if (/mediafire\.com/i.test(link)) return 'mf';
  if (/(?:pixeldrain\.(?:com|net|dev|nl|biz|tech)|pixeldra\.in)/i.test(link)) return 'pd';
  return 'mega';
}

function countLinks() {
  var n = $('#links').value.split(/\s+/).filter(Boolean).length;
  $('#counter').textContent = n + ' লিংক';
}

$('#links').addEventListener('input', countLinks);

$('#paste').addEventListener('click', function () {
  if (!navigator.clipboard || !navigator.clipboard.readText) return toast('Paste সাপোর্ট নেই, Ctrl+V ব্যবহার করুন', true);
  navigator.clipboard.readText().then(function (t) {
    var ta = $('#links');
    ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + t.trim();
    countLinks();
  }).catch(function () { toast('Clipboard এক্সেস পাওয়া যায়নি', true); });
});

$('#clear').addEventListener('click', function () {
  $('#links').value = '';
  countLinks();
  $('#links').focus();
});

function visible(ri) {
  var r = state.results[ri];
  var q = (state.q[ri] || '').toLowerCase();
  var list = r.items.filter(function (it) {
    return !q || (it.path + ' ' + it.name).toLowerCase().indexOf(q) > -1;
  });
  var s = state.sort[ri] || 'default';
  if (s === 'name') list.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
  if (s === 'big') list.sort(function (a, b) { return (b.size || 0) - (a.size || 0); });
  if (s === 'small') list.sort(function (a, b) { return (a.size || 0) - (b.size || 0); });
  return list;
}

function itemHtml(it, ri) {
  var on = !!state.sel[it.download];
  return '<li class="item' + (on ? ' sel' : '') + '">' +
    '<input type="checkbox" class="cb" data-pick="' + esc(it.download) + '"' + (on ? ' checked' : '') + '>' +
    '<div class="idx">' + it.index + '</div>' +
    '<div><div class="name">' + esc(it.name) + '</div>' +
    '<div class="sub"><span class="pill ext">' + esc(extOf(it.name)) + '</span>' +
    (it.sizeText ? '<span class="pill">' + esc(it.sizeText) + '</span>' : '') +
    (it.path ? '<span>' + esc(it.path) + '</span>' : '') + '</div></div>' +
    '<div class="actions">' +
    '<button class="btn btn-ghost btn-sm" data-play="' + esc(it.stream) + '" data-title="' + esc(it.name) + '">Play</button>' +
    '<button class="btn btn-ghost btn-sm" data-copy="' + esc(it.download) + '">Copy</button>' +
    '<a class="btn btn-primary btn-sm" href="' + esc(it.download) + '" download>Download</a>' +
    '</div></li>';
}

function listHtml(ri) {
  var items = visible(ri);
  if (!items.length) return '<div class="empty">কোনো ফাইল পাওয়া যায়নি</div>';
  return '<ul class="list">' + items.map(function (it) { return itemHtml(it, ri); }).join('') + '</ul>';
}

function refreshList(ri) {
  var holder = document.querySelector('[data-list="' + ri + '"]');
  if (holder) holder.innerHTML = listHtml(ri);
  syncPickAll(ri);
  updateFloat();
}

function syncPickAll(ri) {
  var box = document.querySelector('[data-pickall="' + ri + '"]');
  if (!box) return;
  var items = visible(ri);
  var all = items.length > 0 && items.every(function (it) { return state.sel[it.download]; });
  box.checked = all;
}

function selectedUrls() {
  return Object.keys(state.sel).filter(function (k) { return state.sel[k]; });
}

function updateFloat() {
  var n = selectedUrls().length;
  $('#selCount').textContent = n + ' টি সিলেক্টেড';
  $('#floatbar').classList.toggle('show', n > 0);
}

function allUrls() {
  var out = [];
  state.results.forEach(function (r) { if (r.ok) r.items.forEach(function (x) { out.push(x.download); }); });
  return out;
}

function totalBytes() {
  var t = 0;
  state.results.forEach(function (r) { if (r.ok) r.items.forEach(function (x) { t += x.size || 0; }); });
  return t;
}

function fmt(bytes) {
  var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 2) + ' ' + u[i];
}

function showSkeleton() {
  $('#results').innerHTML = '<section class="card folder"><div class="skeleton"><div class="sk"></div><div class="sk"></div><div class="sk"></div></div></section>';
}

function render(results) {
  state.results = results;
  state.sel = {};
  state.q = {};
  state.sort = {};
  updateFloat();

  var box = $('#results');
  box.innerHTML = '';

  var okCount = 0, fileCount = 0;
  results.forEach(function (r) { if (r.ok) { okCount++; fileCount += r.items.length; } });

  if (fileCount > 0) {
    var st = document.createElement('div');
    st.className = 'stats';
    st.innerHTML =
      '<div class="card stat"><small>Sources</small><strong>' + okCount + '</strong></div>' +
      '<div class="card stat"><small>Videos</small><strong>' + fileCount + '</strong></div>' +
      '<div class="card stat"><small>Total Size</small><strong>' + esc(fmt(totalBytes())) + '</strong></div>';
    box.appendChild(st);

    var bar = document.createElement('div');
    bar.className = 'card topbar';
    bar.innerHTML =
      '<div><div class="f-title">সব ফাইলের Direct Download লিংক</div>' +
      '<div class="f-meta">মোট ' + fileCount + ' টি ফাইল প্রস্তুত</div></div>' +
      '<div class="tb-actions">' +
      '<button class="btn btn-primary" data-copyevery="1">Copy All Links</button>' +
      '<button class="btn btn-ghost" data-txtevery="1">Download .txt</button></div>';
    box.appendChild(bar);
  }

  results.forEach(function (r, ri) {
    var el = document.createElement('section');
    el.className = 'card folder';
    el.style.animationDelay = (ri * 70) + 'ms';

    if (!r.ok) {
      el.innerHTML = '<div class="err">' + ICON_WARN + '<div>' + esc(r.error || 'Error') +
        '<div class="f-meta">' + esc(r.link) + '</div></div></div>';
      box.appendChild(el);
      return;
    }

    var s = srcOf(r.link);
    var srcLabel = s === 'mf' ? 'MEDIAFIRE' : (s === 'pd' ? 'PIXELDRAIN' : 'MEGA');
    var isFolder = r.items.length !== 1 || /folder|\/l\//i.test(r.link) || /\.zip$/i.test(r.title || '');
    el.innerHTML =
      '<div class="f-head"><div class="f-id"><div class="f-ico">' + (isFolder ? ICON_FOLDER : ICON_FILE) + '</div>' +
      '<div style="min-width:0"><div class="f-title">' + esc(r.title) + '</div>' +
      '<div class="f-meta"><span class="src ' + s + '">' + srcLabel + '</span>' +
      '<span>' + r.count + ' ভিডিও · ' + esc(r.totalSize) + '</span></div></div></div>' +
      '<div class="f-tools">' +
      '<input class="search" placeholder="Search..." data-search="' + ri + '">' +
      '<select class="select" data-sort="' + ri + '">' +
      '<option value="default">Default</option><option value="name">Name A-Z</option>' +
      '<option value="big">Size: Large</option><option value="small">Size: Small</option></select>' +
      '<button class="btn btn-ghost btn-sm" data-copyall="' + ri + '">Copy Folder Links</button></div></div>' +
      (r.items.length > 1
        ? '<div class="selbar"><input type="checkbox" class="cb" data-pickall="' + ri + '"><span>সব সিলেক্ট করুন</span></div>'
        : '') +
      '<div data-list="' + ri + '">' + listHtml(ri) + '</div>';
    box.appendChild(el);
  });
}

$('#results').addEventListener('click', function (e) {
  var t = e.target;

  var c = t.closest('[data-copy]');
  if (c) {
    copyText(c.getAttribute('data-copy')).then(function () {
      flash(c, 'Copied!');
      toast('লিংক কপি হয়েছে');
    });
    return;
  }

  var p = t.closest('[data-play]');
  if (p) {
    openPlayer(p.getAttribute('data-play'), p.getAttribute('data-title'));
    return;
  }

  var ev = t.closest('[data-copyevery]');
  if (ev) {
    var every = allUrls();
    copyText(every.join('\n')).then(function () {
      flash(ev, 'Copied ' + every.length + '!');
      toast(every.length + ' টি লিংক কপি হয়েছে');
    });
    return;
  }

  var tx = t.closest('[data-txtevery]');
  if (tx) {
    saveTxt('megadl-links.txt', allUrls().join('\n'));
    toast('links.txt ডাউনলোড শুরু হয়েছে');
    return;
  }

  var a = t.closest('[data-copyall]');
  if (a) {
    var r = state.results[parseInt(a.getAttribute('data-copyall'), 10)];
    copyText(r.items.map(function (x) { return x.download; }).join('\n')).then(function () {
      flash(a, 'Copied!');
      toast(r.items.length + ' টি লিংক কপি হয়েছে');
    });
  }
});

$('#results').addEventListener('change', function (e) {
  var t = e.target;
  var pick = t.getAttribute('data-pick');
  if (pick !== null) {
    state.sel[pick] = t.checked;
    var li = t.closest('.item');
    if (li) li.classList.toggle('sel', t.checked);
    var holder = t.closest('[data-list]');
    if (holder) syncPickAll(parseInt(holder.getAttribute('data-list'), 10));
    updateFloat();
    return;
  }
  var pa = t.getAttribute('data-pickall');
  if (pa !== null) {
    var ri = parseInt(pa, 10);
    visible(ri).forEach(function (it) { state.sel[it.download] = t.checked; });
    refreshList(ri);
    return;
  }
  var so = t.getAttribute('data-sort');
  if (so !== null) {
    var ri2 = parseInt(so, 10);
    state.sort[ri2] = t.value;
    refreshList(ri2);
  }
});

$('#results').addEventListener('input', function (e) {
  var s = e.target.getAttribute('data-search');
  if (s === null) return;
  var ri = parseInt(s, 10);
  state.q[ri] = e.target.value.trim();
  refreshList(ri);
});

$('#selCopy').addEventListener('click', function () {
  var urls = selectedUrls();
  copyText(urls.join('\n')).then(function () { toast(urls.length + ' টি লিংক কপি হয়েছে'); });
});

$('#selTxt').addEventListener('click', function () {
  saveTxt('megadl-selected.txt', selectedUrls().join('\n'));
  toast('selected.txt ডাউনলোড শুরু হয়েছে');
});

$('#selClear').addEventListener('click', function () {
  state.sel = {};
  state.results.forEach(function (r, ri) { if (r.ok) refreshList(ri); });
  updateFloat();
});

function openPlayer(url, title) {
  var v = $('#video');
  $('#pTitle').textContent = title || '';
  v.src = url;
  $('#modal').classList.add('show');
  var pr = v.play();
  if (pr && pr.catch) pr.catch(function () {});
}

function closePlayer() {
  var v = $('#video');
  v.pause();
  v.removeAttribute('src');
  v.load();
  $('#modal').classList.remove('show');
}

$('#pClose').addEventListener('click', closePlayer);
$('#modal').addEventListener('click', function (e) { if (e.target === this) closePlayer(); });
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && $('#modal').classList.contains('show')) closePlayer();
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') generate();
});

function generate() {
  var btn = $('#go');
  if (btn.disabled) return;
  var links = $('#links').value.split(/\s+/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (!links.length) return toast('কমপক্ষে একটি লিংক দিন', true);

  btn.disabled = true;
  var old = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> Loading...';
  showSkeleton();

  fetch('/api/list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ links: links })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      render(d.results || []);
      var first = $('#results');
      if (first && first.scrollIntoView) first.scrollIntoView({ behavior: 'smooth', block: 'start' });
    })
    .catch(function () {
      $('#results').innerHTML = '';
      toast('সার্ভারে সমস্যা হয়েছে, আবার চেষ্টা করুন', true);
    })
    .finally(function () {
      btn.disabled = false;
      btn.innerHTML = old;
    });
}

$('#go').addEventListener('click', generate);
countLinks();
</script>
</body>
</html>`;

app.get('/', (req, res) => res.type('html').send(PAGE));

const server = app.listen(PORT, () => console.log('MegaDL running on port ' + PORT));
server.requestTimeout = 0;
server.setTimeout(0);
