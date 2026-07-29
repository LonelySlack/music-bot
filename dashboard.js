import { createServer } from 'http';
import { WebSocketServer } from 'ws';

const MAX_LOGS = 500;
const logBuffer = [];
const clients = new Set();
let botStatus = { uptime: null, guilds: 0, queues: {} };
let controller = null;

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function addLog(level, args) {
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))).join(' ');
  const entry = { ts: timestamp(), level, msg };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
  broadcast({ type: 'log', data: entry });
}

export function patchConsole() {
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.log = (...args) => { origLog(...args); addLog('info', args); };
  console.error = (...args) => { origErr(...args); addLog('error', args); };
  console.warn = (...args) => { origWarn(...args); addLog('warn', args); };
  process.on('uncaughtException', (err) => { addLog('fatal', [`Uncaught Exception: ${err.stack || err.message}`]); });
  process.on('unhandledRejection', (reason) => { addLog('fatal', [`Unhandled Rejection: ${reason}`]); });
}

export function updateStatus(status) {
  botStatus = { ...botStatus, ...status };
  broadcast({ type: 'status', data: botStatus });
}

// Force every connected dashboard to drop its live socket. They auto-reconnect,
// but verifyClient re-checks the (now-rotated) token and rejects stale ones.
export function disconnectClients() {
  for (const ws of clients) { try { ws.close(); } catch {} }
}

// Safely pull the current player state from the bot, for a specific server
// (guildId) or the auto-picked one when none is given.
function playerState(guildId) {
  if (!controller) return { connected: false };
  try { return controller.getState(guildId); } catch (e) { return { connected: false, error: String(e.message || e) }; }
}
// Push each connected client the state of the server IT is currently viewing
// (clients can be on different servers), rather than one shared broadcast.
function pushPlayerState() {
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'player', data: playerState(ws._guildId) }));
  }
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Music67 · Dashboard</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --bg:#0b0f17; --panel:#141a26; --panel2:#0f1420; --line:#232c3d; --text:#e6edf6; --muted:#8b98ad; --accent:#7c5cff; --accent2:#22d3ee; --green:#3fb950; --red:#f85149; }
  body { background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; height:100vh; overflow:hidden; }
  .wrap { display:flex; flex-direction:column; height:100vh; max-width:1200px; margin:0 auto; }
  header { display:flex; align-items:center; justify-content:space-between; padding:14px 20px; border-bottom:1px solid var(--line); }
  header .brand { display:flex; align-items:center; gap:10px; font-weight:700; font-size:17px; }
  header .brand .logo { width:26px; height:26px; border-radius:8px; background:linear-gradient(135deg,var(--accent),var(--accent2)); display:flex; align-items:center; justify-content:center; font-size:15px; }
  header .conn { font-size:12px; color:var(--muted); display:flex; align-items:center; gap:7px; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--red); }
  .dot.ok { background:var(--green); box-shadow:0 0 8px var(--green); }
  main { flex:1; display:grid; grid-template-columns:1.15fr 1fr; gap:16px; padding:16px 20px; overflow:hidden; }
  @media (max-width:820px){ main{ grid-template-columns:1fr; overflow:auto; } body{ overflow:auto; } }
  .col { display:flex; flex-direction:column; gap:16px; min-height:0; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:16px; }
  .card h3 { font-size:12px; text-transform:uppercase; letter-spacing:1.3px; color:var(--muted); margin-bottom:12px; display:flex; align-items:center; gap:8px; }
  .badge { background:var(--panel2); border:1px solid var(--line); color:var(--muted); border-radius:20px; padding:1px 9px; font-size:11px; }
  .gsel { background:var(--panel2); border:1px solid var(--line); color:var(--text); border-radius:20px; padding:4px 10px; font-size:12px; cursor:pointer; max-width:230px; }
  .gsel:focus { outline:none; border-color:var(--accent); }
  .gsel:hover { border-color:var(--accent); }
  /* now playing */
  .np-title { font-size:20px; font-weight:700; line-height:1.3; word-break:break-word; }
  .np-sub { color:var(--muted); font-size:13px; margin-top:4px; }
  .np-empty { color:var(--muted); font-size:15px; padding:8px 0; }
  .progress { margin-top:16px; }
  .bar { height:6px; background:var(--panel2); border-radius:4px; overflow:hidden; }
  .bar > div { height:100%; width:0%; background:linear-gradient(90deg,var(--accent),var(--accent2)); transition:width .3s linear; }
  .times { display:flex; justify-content:space-between; font-size:11px; color:var(--muted); margin-top:6px; font-variant-numeric:tabular-nums; }
  .controls { display:flex; align-items:center; gap:10px; margin-top:16px; flex-wrap:wrap; }
  button.ctl { background:var(--panel2); border:1px solid var(--line); color:var(--text); width:42px; height:42px; border-radius:50%; cursor:pointer; font-size:16px; display:flex; align-items:center; justify-content:center; transition:.15s; }
  button.ctl:hover { border-color:var(--accent); color:#fff; }
  button.ctl.play { width:52px; height:52px; background:linear-gradient(135deg,var(--accent),var(--accent2)); border:none; font-size:20px; }
  button.ctl.on { border-color:var(--accent); color:var(--accent2); box-shadow:inset 0 0 0 1px var(--accent); }
  .vol { display:flex; align-items:center; gap:8px; margin-left:auto; color:var(--muted); font-size:13px; }
  .vol input { width:90px; accent-color:var(--accent); }
  /* add box */
  .addrow { display:flex; gap:8px; }
  .addrow input { flex:1; background:var(--panel2); border:1px solid var(--line); color:var(--text); border-radius:10px; padding:10px 12px; font-size:14px; }
  .addrow input:focus { outline:none; border-color:var(--accent); }
  .btn { background:var(--accent); border:none; color:#fff; border-radius:10px; padding:0 16px; font-size:13px; font-weight:600; cursor:pointer; }
  .btn.ghost { background:var(--panel2); border:1px solid var(--line); color:var(--text); }
  .btn:hover { filter:brightness(1.1); }
  .hint { color:var(--muted); font-size:11px; margin-top:8px; }
  /* lists */
  .list { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:6px; min-height:60px; padding-right:2px; }
  .row { display:flex; align-items:center; gap:10px; background:var(--panel2); border:1px solid var(--line); border-radius:10px; padding:9px 10px; }
  .row.drag-over { border-color:var(--accent); }
  .row.dragging { opacity:.4; }
  .row .idx { color:var(--muted); font-size:12px; width:20px; text-align:center; flex-shrink:0; font-variant-numeric:tabular-nums; }
  .row .grip { color:var(--muted); cursor:grab; font-size:14px; flex-shrink:0; }
  .row .info { flex:1; min-width:0; }
  .row .t { font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .row .m { font-size:11px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:1px; }
  .row .act { display:flex; gap:4px; flex-shrink:0; }
  .row .act button { background:transparent; border:none; color:var(--muted); cursor:pointer; font-size:14px; padding:4px; border-radius:6px; }
  .row .act button:hover { color:#fff; background:var(--line); }
  .row .pending { color:var(--accent2); }
  .empty { color:var(--muted); font-size:13px; text-align:center; padding:18px 0; }
  .col.right { min-height:0; }
  /* favorites */
  .favrefresh { margin-left:auto; padding:2px 10px; font-size:11px; font-weight:600; }
  .favuser { display:flex; align-items:center; gap:8px; margin:6px 0 2px; }
  .favuser:first-child { margin-top:0; }
  .favuser .nm { font-size:12px; font-weight:600; color:var(--text); }
  .favuser .cnt { font-size:11px; color:var(--muted); }
  .favuser .qall { margin-left:auto; background:var(--panel2); border:1px solid var(--line); color:var(--muted); border-radius:8px; padding:3px 9px; font-size:11px; cursor:pointer; }
  .favuser .qall:hover { border-color:var(--accent); color:#fff; }
  .row .act button.star { color:var(--accent2); }
  .card.grow { display:flex; flex-direction:column; min-height:0; flex:1; }
  ::-webkit-scrollbar { width:8px; } ::-webkit-scrollbar-thumb { background:var(--line); border-radius:8px; }
  #toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:var(--panel); border:1px solid var(--line); padding:10px 16px; border-radius:10px; font-size:13px; opacity:0; transition:.3s; pointer-events:none; }
  #toast.show { opacity:1; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand"><span class="logo">&#127925;</span> Music67 <select class="gsel" id="guildSel" title="Choose which server to control" onchange="onGuildChange(this.value)"><option>&mdash;</option></select></div>
    <div class="conn"><span class="dot" id="dot"></span><span id="connText">connecting&hellip;</span></div>
  </header>
  <main>
    <div class="col">
      <div class="card" id="npCard">
        <h3>Now Playing <span id="apBadge" class="badge" style="display:none">&#128251; autoplay</span></h3>
        <div id="npBody"><div class="np-empty">Nothing playing. Add a song below to start.</div></div>
        <div class="progress" id="progress" style="display:none">
          <div class="bar"><div id="barFill"></div></div>
          <div class="times"><span id="tCur">0:00</span><span id="tDur">0:00</span></div>
        </div>
        <div class="controls" id="controls" style="display:none">
          <button class="ctl" title="Previous" onclick="ctl('back')">&#9198;</button>
          <button class="ctl play" id="playBtn" title="Play/Pause" onclick="ctl('pause')">&#9208;</button>
          <button class="ctl" title="Skip" onclick="ctl('skip')">&#9197;</button>
          <button class="ctl" id="loopBtn" title="Loop" onclick="ctl('loop')">&#128257;</button>
          <button class="ctl" id="shufBtn" title="Shuffle" onclick="ctl('shuffle')">&#128256;</button>
          <button class="ctl" id="apBtn" title="Autoplay" onclick="ctl('autoplay')">&#128251;</button>
          <div class="vol">&#128266;<input type="range" min="0" max="200" value="100" id="vol" oninput="volLabel(this.value)" onchange="ctl('volume',{volume:+this.value})"><span id="volTxt">100%</span></div>
        </div>
      </div>
      <div class="card">
        <h3>Add to queue</h3>
        <div class="addrow">
          <input id="addInput" placeholder="Song name, YouTube or Spotify link&hellip;" onkeydown="if(event.key==='Enter')add(false)">
          <button class="btn" onclick="add(false)">Add</button>
          <button class="btn ghost" onclick="add(true)" title="Play right after the current song">Play next</button>
        </div>
        <div class="hint">Drag rows in <b>Up Next</b> to reorder &middot; &#9654; plays now &middot; &#10005; removes</div>
      </div>
      <div class="card grow">
        <h3>&#11088; Favorites <span class="badge" id="favCount">0</span><button class="btn ghost favrefresh" title="Reload favorites" onclick="loadFavorites()">&#8635; Refresh</button></h3>
        <div class="list" id="favorites"><div class="empty">Loading&hellip;</div></div>
      </div>
    </div>
    <div class="col right">
      <div class="card grow">
        <h3>Up Next <span class="badge" id="qCount">0</span></h3>
        <div class="list" id="queue"><div class="empty">Queue is empty</div></div>
      </div>
      <div class="card grow">
        <h3>Previously Played <span class="badge" id="hCount">0</span></h3>
        <div class="list" id="history"><div class="empty">No history yet</div></div>
      </div>
    </div>
  </main>
</div>
<div id="toast"></div>
<script>
var TOKEN = new URLSearchParams(location.search).get('token') || '';
var state = null, recvAt = 0, dragFrom = null, selectedGuild = null, ws = null, favs = [];

function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmt(sec){ sec=Math.max(0,Math.floor(sec||0)); var m=Math.floor(sec/60), s=sec%60; return m+':'+(s<10?'0':'')+s; }
function toast(msg){ var t=document.getElementById('toast'); t.textContent=msg; t.className='show'; clearTimeout(window._tt); window._tt=setTimeout(function(){t.className='';},2600); }

function ctl(action, extra){
  var body = Object.assign({ action:action, guildId:selectedGuild }, extra||{});
  fetch('/api/control', { method:'POST', headers:{ 'Content-Type':'application/json', 'x-dash-token':TOKEN }, body:JSON.stringify(body) })
    .then(function(r){ return r.json(); })
    .then(function(j){ if(j && j.error) toast(j.error); if(j && j.state) apply(j.state); })
    .catch(function(){ toast('Request failed'); });
}
function add(next){
  var el=document.getElementById('addInput'); var v=el.value.trim(); if(!v) return;
  el.value=''; toast(next?'Adding (play next)&hellip;':'Adding&hellip;');
  ctl('add',{ query:v, next:!!next });
}
function volLabel(v){ document.getElementById('volTxt').textContent=v+'%'; }

function rowHtml(s, kind){
  var meta = [];
  if(s.uploader) meta.push(esc(s.uploader));
  if(s.duration) meta.push(esc(s.duration));
  if(s.pending) meta.push('<span class="pending">resolving&hellip;</span>');
  if(s.by) meta.push('added by '+esc(s.by));
  var m = meta.join(' &middot; ');
  if(kind==='queue'){
    return '<div class="row" draggable="true" data-pos="'+s.pos+'">'
      + '<span class="grip">&#8942;&#8942;</span><span class="idx">'+s.pos+'</span>'
      + '<div class="info"><div class="t">'+esc(s.title)+'</div><div class="m">'+m+'</div></div>'
      + '<div class="act"><button title="Play now" onclick="ctl(\\'jump\\',{pos:'+s.pos+'})">&#9654;</button>'
      + '<button title="Remove" onclick="ctl(\\'remove\\',{pos:'+s.pos+'})">&#10005;</button></div></div>';
  }
  return '<div class="row">'
    + '<span class="idx">&#8635;</span>'
    + '<div class="info"><div class="t">'+esc(s.title)+'</div><div class="m">'+m+'</div></div>'
    + '<div class="act"><button title="Play again" onclick="replay('+JSON.stringify(s.url||s.title).replace(/"/g,'&quot;')+')">&#8634;</button></div></div>';
}
function replay(q){ toast('Queuing again&hellip;'); ctl('add',{ query:q }); }

// pack a string as a safe onclick argument (matches the replay() escaping)
function jsstr(v){ return JSON.stringify(v==null?'':String(v)).replace(/"/g,'&quot;'); }
function loadFavorites(){
  fetch('/api/favorites',{ headers:{ 'x-dash-token':TOKEN } })
    .then(function(r){ return r.json(); }).then(renderFavorites).catch(function(){});
}
function renderFavorites(list){
  favs = list || [];
  var total = favs.reduce(function(a,g){ return a + (g.songs?g.songs.length:0); }, 0);
  document.getElementById('favCount').textContent = total;
  var el = document.getElementById('favorites');
  if(!favs.length){ el.innerHTML = '<div class="empty">No favorites yet &mdash; hit &#11088; or <b>67 like</b> while a song plays</div>'; return; }
  el.innerHTML = favs.map(function(g){
    var head = '<div class="favuser"><span class="nm">'+esc(g.name)+'</span>'
      + '<span class="cnt">'+g.songs.length+' song'+(g.songs.length===1?'':'s')+'</span>'
      + '<button class="qall" title="Queue all of these" onclick="playFavAll('+jsstr(g.userId)+')">&#9654; Queue all</button></div>';
    var rows = g.songs.map(function(s){
      var meta=[]; if(s.uploader) meta.push(esc(s.uploader)); if(s.duration) meta.push(esc(s.duration));
      return '<div class="row"><span class="idx">&#11088;</span>'
        + '<div class="info"><div class="t">'+esc(s.title)+'</div><div class="m">'+meta.join(' &middot; ')+'</div></div>'
        + '<div class="act"><button class="star" title="Add to queue" onclick="favPlay('+jsstr(s.url||s.title)+')">&#9654;</button></div></div>';
    }).join('');
    return head + rows;
  }).join('');
}
function favPlay(q){ toast('Adding&hellip;'); ctl('add',{ query:q }); }
function playFavAll(uid){ toast('Queuing favorites&hellip;'); ctl('favall',{ userId:uid }); }

function renderGuilds(s){
  var gs = s.guilds || [];
  // Default to the server the server-side auto-picked, and keep the local
  // selection in sync if the picked server changed or ours vanished.
  if(selectedGuild==null) selectedGuild = s.guildId || null;
  if(selectedGuild && !gs.some(function(g){return g.id===selectedGuild;})) selectedGuild = s.guildId || null;
  var sel = document.getElementById('guildSel');
  // Only rebuild the <option>s when the set of servers changes, so switching
  // one doesn't clobber an open dropdown on every 1s state push.
  var sig = gs.map(function(g){return g.id;}).join(',');
  if(sel._sig !== sig){
    sel.innerHTML = gs.length
      ? gs.map(function(g){ return '<option value="'+esc(g.id)+'">'+esc(g.name)+'</option>'; }).join('')
      : '<option value="">\\u2014 no servers \\u2014</option>';
    sel._sig = sig;
  }
  if(selectedGuild) sel.value = selectedGuild;
}
function onGuildChange(v){
  selectedGuild = v || null;
  if(ws && ws.readyState===1) ws.send(JSON.stringify({ type:'select', guildId:selectedGuild }));
  fetchState(); // update the view immediately, don't wait for the next push
}
function fetchState(){
  fetch('/api/player'+(selectedGuild?('?guildId='+encodeURIComponent(selectedGuild)):''), { headers:{ 'x-dash-token':TOKEN } })
    .then(function(r){ return r.json(); }).then(apply).catch(function(){});
}

function apply(s){
  state = s; recvAt = Date.now();
  renderGuilds(s);
  // now playing
  var np=document.getElementById('npBody'), pr=document.getElementById('progress'), co=document.getElementById('controls');
  if(s.current){
    np.innerHTML = '<div class="np-title">'+esc(s.current.title)+'</div>'
      + '<div class="np-sub">'+esc(s.current.uploader||'')+(s.current.by?'  &middot;  added by '+esc(s.current.by):'')+'</div>';
    pr.style.display=''; co.style.display='';
    document.getElementById('tDur').textContent = fmt(s.current.durationSec);
    document.getElementById('playBtn').innerHTML = s.paused ? '&#9654;' : '&#9208;';
  } else {
    np.innerHTML = '<div class="np-empty">Nothing playing. Add a song below to start.</div>';
    pr.style.display='none'; co.style.display='none';
  }
  document.getElementById('loopBtn').className = 'ctl'+(s.loop?' on':'');
  document.getElementById('apBtn').className = 'ctl'+(s.autoplay?' on':'');
  document.getElementById('apBadge').style.display = s.autoplay ? '' : 'none';
  if(document.activeElement && document.activeElement.id==='vol'){} else { document.getElementById('vol').value = s.volume||100; volLabel(s.volume||100); }
  tick();
  // queue
  var q=document.getElementById('queue'); document.getElementById('qCount').textContent=(s.queue||[]).length;
  if(!s.queue || !s.queue.length){ q.innerHTML='<div class="empty">Queue is empty</div>'; }
  else { q.innerHTML = s.queue.map(function(x){ return rowHtml(x,'queue'); }).join(''); wireDrag(); }
  // history
  var h=document.getElementById('history'); document.getElementById('hCount').textContent=(s.history||[]).length;
  if(!s.history || !s.history.length){ h.innerHTML='<div class="empty">No history yet</div>'; }
  else { h.innerHTML = s.history.map(function(x){ return rowHtml(x,'history'); }).join(''); }
}

function tick(){
  if(!state || !state.current){ return; }
  var pos = state.position + (state.playing && !state.paused ? (Date.now()-recvAt)/1000 : 0);
  var dur = state.current.durationSec || 0;
  if(dur>0) pos=Math.min(pos,dur);
  document.getElementById('tCur').textContent = fmt(pos);
  document.getElementById('barFill').style.width = (dur>0 ? (pos/dur*100) : 0)+'%';
}
setInterval(tick, 500);

function wireDrag(){
  var rows = document.querySelectorAll('#queue .row');
  rows.forEach(function(row){
    row.addEventListener('dragstart', function(){ dragFrom=+row.dataset.pos; row.classList.add('dragging'); });
    row.addEventListener('dragend', function(){ row.classList.remove('dragging'); rows.forEach(function(r){r.classList.remove('drag-over');}); });
    row.addEventListener('dragover', function(e){ e.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', function(){ row.classList.remove('drag-over'); });
    row.addEventListener('drop', function(e){ e.preventDefault(); var to=+row.dataset.pos; if(dragFrom && to && dragFrom!==to){ toast('Reordering&hellip;'); ctl('move',{from:dragFrom,to:to}); } });
  });
}

function connect(){
  var proto = location.protocol==='https:'?'wss:':'ws:';
  ws = new WebSocket(proto+'//'+location.host+'/ws'+(TOKEN?('?token='+encodeURIComponent(TOKEN)):''));
  ws.onopen = function(){ document.getElementById('dot').className='dot ok'; document.getElementById('connText').textContent='live'; ws.send(JSON.stringify({ type:'select', guildId:selectedGuild })); };
  ws.onclose = function(){ document.getElementById('dot').className='dot'; document.getElementById('connText').textContent='reconnecting&hellip;'; setTimeout(connect,2000); };
  ws.onerror = function(){ ws.close(); };
  ws.onmessage = function(e){ try { var m=JSON.parse(e.data); if(m.type==='player') apply(m.data); } catch(err){} };
}
connect();
loadFavorites();
</script>
</body>
</html>`;

const LOGIN = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Music67 · Sign in</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0b0f17;color:#e6edf6;font-family:-apple-system,Segoe UI,Roboto,sans-serif;height:100vh;display:flex;align-items:center;justify-content:center}
.box{background:#141a26;border:1px solid #232c3d;border-radius:14px;padding:28px;width:320px;text-align:center}.logo{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,#7c5cff,#22d3ee);display:flex;align-items:center;justify-content:center;font-size:22px;margin:0 auto 14px}
h1{font-size:16px;margin-bottom:4px}p{color:#8b98ad;font-size:12px;margin-bottom:16px}input{width:100%;background:#0f1420;border:1px solid #232c3d;color:#e6edf6;border-radius:10px;padding:11px 12px;font-size:14px;margin-bottom:10px}input:focus{outline:none;border-color:#7c5cff}
button{width:100%;background:#7c5cff;border:none;color:#fff;border-radius:10px;padding:11px;font-size:14px;font-weight:600;cursor:pointer}button:hover{filter:brightness(1.1)}.err{color:#f85149;font-size:12px;height:16px;margin-bottom:6px}</style></head>
<body><div class="box"><div class="logo">&#127925;</div><h1>Music67 Dashboard</h1><p>Enter your access token to continue</p>
<div class="err" id="err"></div><input id="tok" type="password" placeholder="Access token" autofocus onkeydown="if(event.key==='Enter')go()">
<button onclick="go()">Unlock</button></div>
<script>if(new URLSearchParams(location.search).get('bad')==='1')document.getElementById('err').textContent='Wrong token, try again.';
function go(){var v=document.getElementById('tok').value.trim();if(v)location='/?token='+encodeURIComponent(v);}</script></body></html>`;

export function startDashboard(port = 3000, ctrl = null) {
  controller = ctrl;
  // Read the token live (not captured once) so `67 rotatetoken` takes effect
  // immediately without a restart.
  const tokenOf = (req) => { try { return req.headers['x-dash-token'] || new URL(req.url, 'http://x').searchParams.get('token') || ''; } catch { return ''; } };
  const authed = (req) => { const TOKEN = process.env.DASHBOARD_TOKEN || ''; return !TOKEN || tokenOf(req) === TOKEN; };

  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const server = createServer(async (req, res) => {
    const url = (req.url || '').split('?')[0];
    // Landing page: serve the app if authed, a wrong token bounces to the login with an error, otherwise the login.
    if (url === '/' || url === '/index.html') {
      if (authed(req)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); return; }
      let hasTok = false; try { hasTok = new URL(req.url, 'http://x').searchParams.has('token'); } catch {}
      if (hasTok) { res.writeHead(302, { Location: '/?bad=1' }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(LOGIN); return;
    }
    if (url.startsWith('/api/')) {
      if (!authed(req)) return json(res, 401, { error: 'Unauthorized' });
      if (url === '/api/player') { let gid = null; try { gid = new URL(req.url, 'http://x').searchParams.get('guildId'); } catch {} return json(res, 200, playerState(gid)); }
      if (url === '/api/logs') return json(res, 200, logBuffer);
      if (url === '/api/status') return json(res, 200, botStatus);
      if (url === '/api/favorites') { const list = controller ? await controller.favorites().catch(() => []) : []; return json(res, 200, list); }
      if (url === '/api/control' && req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
        req.on('end', async () => {
          let out = { ok: false, error: 'No controller' };
          try {
            const b = JSON.parse(body || '{}');
            if (controller) out = await runAction(controller, b);
          } catch (e) { out = { ok: false, error: String(e.message || e) }; }
          let gid = null; try { gid = JSON.parse(body || '{}').guildId || null; } catch {}
          out.state = playerState(gid);
          pushPlayerState(); // refresh every client on their own selected server
          json(res, 200, out);
        });
        return;
      }
      return json(res, 404, { error: 'Not found' });
    }
    res.writeHead(404); res.end('Not found');
  });

  // Gate the WebSocket too, so state can't be streamed to an unauthenticated client.
  const wss = new WebSocketServer({ server, path: '/ws', verifyClient: (info) => authed(info.req) });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws._guildId = null; // which server this client is viewing; set via a 'select' message
    // Client tells us which server it's viewing (and re-tells us when it switches).
    ws.on('message', (raw) => {
      try { const m = JSON.parse(raw); if (m && m.type === 'select') ws._guildId = m.guildId || null; } catch {}
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'player', data: playerState(ws._guildId) }));
    });
    ws.send(JSON.stringify({ type: 'player', data: playerState(ws._guildId) }));
    ws.on('close', () => clients.delete(ws));
  });

  // Push live player state (progress, external Discord changes) to each client
  // for the specific server it's viewing.
  setInterval(() => { if (controller && clients.size) pushPlayerState(); }, 1000);

  server.listen(port, '0.0.0.0', () => {
    console.log(`📊 Dashboard running at http://0.0.0.0:${port}`);
  });
}

// Map a control request from the browser onto the bot controller.
async function runAction(c, b) {
  const gid = b.guildId || null;
  switch (b.action) {
    case 'add':      return await c.add(b.query, { next: !!b.next, guildId: gid });
    case 'skip':     return c.skip(gid);
    case 'back':     return c.back(gid);
    case 'pause':    return c.togglePause(gid);
    case 'shuffle':  return c.shuffle(gid);
    case 'loop':     return c.loop(gid);
    case 'autoplay': return c.autoplay(gid);
    case 'volume':   return c.volume(b.volume, gid);
    case 'remove':   return c.remove(b.pos, gid);
    case 'jump':     return c.jump(b.pos, gid);
    case 'move':     return c.move(b.from, b.to, gid);
    case 'favall':   return await c.playFavorites(b.userId, { guildId: gid });
    default:         return { ok: false, error: 'Unknown action: ' + b.action };
  }
}
