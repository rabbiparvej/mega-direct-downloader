// Mega Folder → Direct Download (Render ready)
// Env: MEGA_FOLDER_URL = https://mega.nz/folder/XXXXXXXX#YYYYYYYY
const express = require('express');
const { File } = require('megajs');

const PORT = process.env.PORT || 3000;
const MEGA_FOLDER_URL = process.env.MEGA_FOLDER_URL || '';
const CACHE_MS = 10 * 60 * 1000;
const VIDEO_EXT = /\.(mp4|mkv|webm|avi|mov|m4v|flv|wmv|ts|3gp|mpg|mpeg)$/i;

const app = express();
app.disable('x-powered-by');

/* ---------- Mega folder loader ---------- */
let state = { at: 0, title: '', items: [], map: new Map() };
let loading = null;

function walk(node, prefix, out, map) {
  for (const child of node.children || []) {
    if (child.directory) {
      walk(child, prefix + child.name + ' / ', out, map);
    } else if (VIDEO_EXT.test(child.name || '')) {
      const id = child.nodeId;
      map.set(id, child);
      out.push({ id, name: child.name, folder: prefix, size: child.size || 0 });
    }
  }
}

async function loadFolder(force = false) {
  if (!MEGA_FOLDER_URL) throw new Error('MEGA_FOLDER_URL সেট করা হয়নি');
  if (!force && state.items.length && Date.now() - state.at < CACHE_MS) return state;
  if (loading) return loading;
  loading = (async () => {
    const root = File.fromURL(MEGA_FOLDER_URL);
    await root.loadAttributes();
    const items = [], map = new Map();
    walk(root, '', items, map);
    // নাম অনুযায়ী সিরিয়াল (1, 2, 10 — সঠিক সংখ্যা ক্রমে)
    items.sort((a, b) =>
      (a.folder + a.name).localeCompare(b.folder + b.name, undefined, { numeric: true, sensitivity: 'base' })
    );
    items.forEach((it, i) => { it.no = i + 1; it.url = `/dl/${encodeURIComponent(it.id)}/${encodeURIComponent(it.name)}`; });
    state = { at: Date.now(), title: root.name || 'Videos', items, map };
    return state;
  })();
  try { return await loading; } finally { loading = null; }
}

/* ---------- API ---------- */
app.get('/api/files', async (req, res) => {
  try {
    const s = await loadFolder(req.query.refresh === '1');
    res.json({ title: s.title, count: s.items.length, items: s.items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- Direct download (stream, resume supported) ---------- */
app.get('/dl/:id/:name?', async (req, res) => {
  try {
    let s = await loadFolder();
    let file = s.map.get(req.params.id);
    if (!file) { s = await loadFolder(true); file = s.map.get(req.params.id); }
    if (!file) return res.status(404).send('ফাইল পাওয়া যায়নি');

    const size = file.size;
    const safe = file.name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };

    let start = 0, end = size - 1, status = 200;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = parseInt(m[1], 10); if (m[2]) end = Math.min(parseInt(m[2], 10), size - 1); }
      else { start = Math.max(size - parseInt(m[2], 10), 0); }
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);

    const stream = file.download({ start, end: end + 1 });
    req.on('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(500).send('ডাউনলোড ব্যর্থ: ' + e.message);
    else res.destroy();
  }
});

app.get('/health', (_, res) => res.send('ok'));

/* ---------- Premium UI ---------- */
const PAGE = `<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Video Library</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;500;600&family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Manrope:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0d1020; --bg2:#141934; --line:#262d52; --ink:#eceef8; --mute:#8a92b4;
  --gold:#e6c883; --gold2:#b8975a; --ok:#7fd6a8;
  --sans:'Manrope','Hind Siliguri',system-ui,sans-serif;
  --serif:'Fraunces','Hind Siliguri',Georgia,serif;
}
*{box-sizing:border-box;margin:0}
html{background:var(--bg)}
body{font-family:var(--sans);color:var(--ink);min-height:100vh;
  background:radial-gradient(900px 500px at 85% -10%,#2a2150 0,transparent 60%),
             radial-gradient(700px 400px at -10% 10%,#16264f 0,transparent 55%),var(--bg);
  padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
.wrap{max-width:960px;margin:0 auto;padding:56px 22px 90px}
header h1{font-family:var(--serif);font-weight:600;font-size:clamp(30px,6vw,52px);letter-spacing:-.02em;line-height:1.1;
  background:linear-gradient(120deg,#fff 20%,var(--gold));-webkit-background-clip:text;background-clip:text;color:transparent;word-break:break-word}
.stats{margin-top:14px;color:var(--mute);font-size:15px;display:flex;gap:18px;flex-wrap:wrap}
.stats b{color:var(--gold);font-weight:700}
.bar{display:flex;gap:10px;margin:34px 0 8px;flex-wrap:wrap}
.search{flex:1;min-width:200px;position:relative}
.search input{width:100%;background:rgba(255,255,255,.04);border:1px solid var(--line);color:var(--ink);
  padding:14px 16px;border-radius:14px;font:inherit;font-size:15px;outline:none;transition:border-color .2s,background .2s}
.search input:focus{border-color:var(--gold2);background:rgba(255,255,255,.07)}
.btn{font:inherit;font-size:14px;font-weight:600;cursor:pointer;border-radius:12px;padding:12px 18px;border:1px solid var(--line);
  background:rgba(255,255,255,.04);color:var(--ink);text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;
  transition:transform .15s,border-color .2s,background .2s;white-space:nowrap}
.btn:hover{border-color:var(--gold2);background:rgba(230,200,131,.08)}
.btn:active{transform:scale(.97)}
.btn:focus-visible,input:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
.btn.gold{background:linear-gradient(135deg,var(--gold),var(--gold2));color:#1a1405;border-color:transparent}
.btn.gold:hover{filter:brightness(1.08);background:linear-gradient(135deg,var(--gold),var(--gold2))}
.btn.done{border-color:var(--ok);color:var(--ok)}
ol{list-style:none;padding:0}
li{display:grid;grid-template-columns:64px 1fr auto;gap:18px;align-items:center;padding:20px 4px;border-bottom:1px solid var(--line)}
.no{font-family:var(--serif);font-size:34px;font-weight:500;color:var(--gold);opacity:.85;text-align:right;font-variant-numeric:tabular-nums}
.info{min-width:0}
.name{font-size:17px;font-weight:600;line-height:1.4;word-break:break-word}
.meta{margin-top:5px;color:var(--mute);font-size:13px;display:flex;gap:12px;flex-wrap:wrap}
.meta .path{opacity:.85}
.act{display:flex;gap:8px}
.state{padding:70px 0;text-align:center;color:var(--mute)}
.spin{width:34px;height:34px;border:3px solid var(--line);border-top-color:var(--gold);border-radius:50%;margin:0 auto 16px;animation:s 1s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
.toast{position:fixed;left:50%;bottom:calc(26px + env(safe-area-inset-bottom));transform:translate(-50%,20px);opacity:0;pointer-events:none;
  background:#1d2347;border:1px solid var(--gold2);color:var(--ink);padding:12px 20px;border-radius:999px;font-size:14px;
  transition:opacity .25s,transform .25s;z-index:9}
.toast.show{opacity:1;transform:translate(-50%,0)}
@media(max-width:640px){
  .wrap{padding-top:40px}
  li{grid-template-columns:44px 1fr;gap:12px}
  .no{font-size:26px}
  .act{grid-column:1/-1}
  .act .btn{flex:1}
}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1 id="title">Video Library</h1>
    <div class="stats" id="stats"></div>
  </header>
  <div class="bar">
    <div class="search"><input id="q" type="search" placeholder="ভিডিও খুঁজুন…" autocomplete="off"></div>
    <button class="btn" id="copyAll">সব লিংক কপি</button>
    <button class="btn" id="refresh">রিফ্রেশ</button>
  </div>
  <ol id="list"></ol>
  <div class="state" id="state"><div class="spin"></div>ভিডিও লোড হচ্ছে…</div>
</div>
<div class="toast" id="toast"></div>
<script>
const $=s=>document.querySelector(s);
let ALL=[];
const fmt=b=>{if(!b)return'—';const u=['B','KB','MB','GB','TB'];let i=0;while(b>=1024&&i<4){b/=1024;i++}return b.toFixed(i?1:0)+' '+u[i]};
const full=u=>location.origin+u;
function toast(t){const el=$('#toast');el.textContent=t;el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('show'),1800)}
async function copy(text){
  try{await navigator.clipboard.writeText(text)}
  catch{const a=document.createElement('textarea');a.value=text;document.body.appendChild(a);a.select();document.execCommand('copy');a.remove()}
}
function render(){
  const q=$('#q').value.trim().toLowerCase();
  const list=$('#list');list.textContent='';
  const rows=ALL.filter(v=>(v.folder+v.name).toLowerCase().includes(q));
  for(const v of rows){
    const li=document.createElement('li');
    const no=document.createElement('div');no.className='no';no.textContent=v.no;
    const info=document.createElement('div');info.className='info';
    const n=document.createElement('div');n.className='name';n.textContent=v.name;
    const m=document.createElement('div');m.className='meta';
    const sz=document.createElement('span');sz.textContent=fmt(v.size);m.append(sz);
    if(v.folder){const p=document.createElement('span');p.className='path';p.textContent=v.folder.replace(/ \\/ $/,'');m.append(p)}
    info.append(n,m);
    const act=document.createElement('div');act.className='act';
    const c=document.createElement('button');c.className='btn';c.textContent='লিংক কপি';
    c.onclick=async()=>{await copy(full(v.url));c.textContent='কপি হয়েছে';c.classList.add('done');toast('Direct link কপি হয়েছে');
      setTimeout(()=>{c.textContent='লিংক কপি';c.classList.remove('done')},1600)};
    const d=document.createElement('a');d.className='btn gold';d.href=v.url;d.textContent='ডাউনলোড';d.setAttribute('download',v.name);
    act.append(c,d);
    li.append(no,info,act);list.append(li);
  }
  const st=$('#state');
  if(!rows.length){st.style.display='block';st.textContent=ALL.length?'কোনো ভিডিও মেলেনি':'এই ফোল্ডারে কোনো ভিডিও নেই'}else st.style.display='none';
}
async function load(refresh){
  $('#state').style.display='block';$('#state').innerHTML='<div class="spin"></div>ভিডিও লোড হচ্ছে…';$('#list').textContent='';
  try{
    const r=await fetch('/api/files'+(refresh?'?refresh=1':''));
    const j=await r.json();if(!r.ok)throw new Error(j.error);
    ALL=j.items;$('#title').textContent=j.title;document.title=j.title;
    const total=ALL.reduce((a,b)=>a+b.size,0);
    $('#stats').innerHTML='<span><b>'+j.count+'</b> টি ভিডিও</span><span>মোট <b>'+fmt(total)+'</b></span>';
    render();
  }catch(e){$('#state').textContent='লোড ব্যর্থ: '+e.message}
}
$('#q').addEventListener('input',render);
$('#refresh').onclick=()=>load(true);
$('#copyAll').onclick=async()=>{if(!ALL.length)return;await copy(ALL.map(v=>full(v.url)).join('\\n'));toast(ALL.length+' টি লিংক কপি হয়েছে')};
load();
</script>
</body>
</html>`;

app.get('/', (_, res) => res.type('html').send(PAGE));

app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
  loadFolder().then(s => console.log('Loaded ' + s.items.length + ' videos')).catch(e => console.error(e.message));
});
