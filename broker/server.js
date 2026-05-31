// steel-broker — multi-window broker for one shared Chrome.
//
// Runs inside the browser container's network namespace
// (network_mode: "service:<chrome service>"), so it reaches Chrome's CDP at
// localhost:9222 directly — Chrome binds DevTools to 127.0.0.1 only and rejects
// non-localhost Host headers, so this netns trick is what avoids all of that.
//
// Gives N agents/humans their own browser WINDOW in the ONE shared Chrome
// (single cookie jar / profile), each independently drivable, viewable, and
// human-takeoverable in parallel. Windows live in the one DEFAULT browser
// context, so cookies/logins are shared; isolation is done by filtering CDP's
// Target domain per connection (NOT by separate contexts, which would split the
// cookie jar). See README.
//
//   ws://HOST:3030/cdp            agents: CDP endpoint; 1 connection = 1 window
//   http://HOST:3030/             index: list windows, spawn, get viewer links
//   http://HOST:3030/v/<lease>    humans: live viewer + takeover page
//   ws://HOST:3030/cast/<lease>   viewer transport (jpeg frames down, input up)
//   GET  /windows                 list current page targets
//   POST /lease {targetId}        register a lease for an existing window -> {leaseId}
//   POST /spawn {url?}            open a fresh window AND lease it -> {leaseId, targetId}
//   DELETE /lease/:id             close the window + drop the lease
//
// Security: bind to a trusted network (tailnet/LAN) + unguessable leaseId.
// Shared cookie jar = shared identity: isolation here is anti-collision between
// agents, NOT a security sandbox for untrusted users.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const WS = require('ws');

// Steel's own session-player UI, vendored verbatim (player.ejs). We render it
// ourselves pointed at the broker's window-scoped /cast endpoint, so we get
// Steel's exact viewer (tab strip, nav bar, takeover) without forking Steel's
// image — and the backend stays per-window isolated. See README.
const PLAYER_TPL = fs.readFileSync(path.join(__dirname, 'player.ejs'), 'utf8');
function renderPlayer(leaseId, host) {
  return ejs.render(PLAYER_TPL, {
    theme: 'dark', singlePageMode: false, interactive: true, showControls: true,
    wsUrl: 'ws://' + host + '/cast/' + leaseId,
    dimensions: { width: SCREENCAST_MAXW, height: SCREENCAST_MAXH },
  });
}

const CHROME = process.env.CHROME || 'localhost:9222';
const [CH_HOST, CH_PORT] = CHROME.split(':');
const PORT = parseInt(process.env.PORT || '3030', 10);
const IDLE_TTL_MS = parseInt(process.env.IDLE_TTL_MS || '900000', 10); // 15 min
const SCREENCAST_QUALITY = parseInt(process.env.SCREENCAST_QUALITY || '75', 10);
const SCREENCAST_MAXW = parseInt(process.env.SCREENCAST_MAXW || '1920', 10);
const SCREENCAST_MAXH = parseInt(process.env.SCREENCAST_MAXH || '1080', 10);

// Chrome validates the Host header on its DevTools HTTP+WS endpoints; from inside
// the netns we are localhost so this is naturally fine, but we set it explicitly
// to stay robust if CHROME is ever pointed elsewhere.
const HDR = { Host: 'localhost:' + CH_PORT };

// ---- tiny CDP helper over a ws to Chrome's browser endpoint ----
function cdp(ws) {
  let id = 0; const pend = new Map(); const subs = [];
  ws.on('message', buf => {
    const m = JSON.parse(buf);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    else if (m.method) subs.forEach(fn => fn(m));
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const m = ++id; const o = { id: m, method, params }; if (sessionId) o.sessionId = sessionId;
    pend.set(m, { res, rej }); ws.send(JSON.stringify(o));
    setTimeout(() => { if (pend.has(m)) { pend.delete(m); rej(new Error('cdp timeout: ' + method)); } }, 15000);
  });
  return { send, on: fn => subs.push(fn) };
}

const getJSON = path => new Promise((res, rej) =>
  http.get({ host: CH_HOST, port: CH_PORT, path, headers: HDR }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej));

async function browserWSURL() {
  const ver = await getJSON('/json/version');
  // normalise host:port to our CHROME (Chrome sometimes emits a port-less url)
  return ver.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+\//, 'ws://' + CHROME + '/');
}
async function openBrowserCDP() {
  const ws = new WS(await browserWSURL(), { headers: HDR });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  return ws;
}

// ---- lease registry ----
// leaseId -> { targetId, viewers:Set<ws>, lastSeen }
const leases = new Map();
const newLeaseId = () => 'L' + crypto.randomBytes(6).toString('hex');

async function spawnWindow(url) {
  const ws = await openBrowserCDP(); const c = cdp(ws);
  const { targetId } = await c.send('Target.createTarget', { url: url || 'about:blank', newWindow: true });
  ws.close();
  return targetId;
}

async function closeWindow(targetId) {
  try { const ws = await openBrowserCDP(); const c = cdp(ws); await c.send('Target.closeTarget', { targetId }); ws.close(); } catch {}
}

// page targets grouped by their OS window (CDP has no window object — we derive
// it from Browser.getWindowForTarget). One entry per window, tabs nested, plus a
// ready one-click `view` link. This is what /windows returns and the index renders.
async function listWindows(host) {
  const ws = await openBrowserCDP(); const c = cdp(ws);
  try {
    const pages = (await getJSON('/json/list')).filter(t => t.type === 'page');
    const byWin = new Map();
    for (const p of pages) {
      let wid; try { wid = (await c.send('Browser.getWindowForTarget', { targetId: p.id })).windowId; } catch { wid = 'unknown'; }
      if (!byWin.has(wid)) byWin.set(wid, []);
      byWin.get(wid).push({ id: p.id, title: p.title, url: p.url });
    }
    const base = host ? 'http://' + host : '';
    return [...byWin.entries()].map(([windowId, tabs]) => ({
      windowId, tabs, view: base + '/view/' + tabs[0].id,
    }));
  } finally { ws.close(); }
}

// idle reaper: drop leases with no viewers, untouched past TTL. Only CLOSE the
// underlying window if WE spawned it (POST /spawn). Leases that merely VIEW an
// existing window (POST /lease, GET /view — typically an agent's window) just get
// dropped; we must never auto-close a window we didn't open.
setInterval(() => {
  const now = Date.now();
  for (const [id, L] of leases) {
    if (L.viewers.size === 0 && now - L.lastSeen > IDLE_TTL_MS) {
      leases.delete(id); if (L.spawned) closeWindow(L.targetId);
    }
  }
}, 60000).unref();

// ---- HTTP ----
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  u.pathname = u.pathname.replace(/\/+$/, '') || '/'; // tolerate trailing slash (Playwright appends one)
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    // Agent CDP discovery: Playwright connectOverCDP("http://HOST/cdp") fetches this
    // first, then dials the returned webSocketDebuggerUrl. Point it back at our /cdp WS.
    if (u.pathname === '/cdp/json/version') {
      const ver = await getJSON('/json/version');
      ver.webSocketDebuggerUrl = 'ws://' + req.headers.host + '/cdp';
      return send(200, ver);
    }
    if (u.pathname === '/cdp/json/list' || u.pathname === '/cdp/json') {
      return send(200, await getJSON('/json/list'));
    }

    // window-grouped list, each entry with a ready /view link (agents relay `.view`)
    if (u.pathname === '/windows' && req.method === 'GET') return send(200, await listWindows(req.headers.host));

    if (u.pathname === '/lease' && req.method === 'POST') {
      const body = await readBody(req); const { targetId } = JSON.parse(body || '{}');
      if (!targetId) return send(400, { error: 'targetId required' });
      const leaseId = newLeaseId();
      leases.set(leaseId, { targetId, spawned: false, viewers: new Set(), lastSeen: Date.now() });
      return send(200, { leaseId, viewer: '/v/' + leaseId });
    }

    if (u.pathname === '/spawn' && req.method === 'POST') {
      const body = await readBody(req); const { url } = JSON.parse(body || '{}');
      const targetId = await spawnWindow(url);
      const leaseId = newLeaseId();
      leases.set(leaseId, { targetId, spawned: true, viewers: new Set(), lastSeen: Date.now() });
      return send(200, { leaseId, targetId, viewer: '/v/' + leaseId });
    }

    // One-shot link to a window's live view: reuse a lease for this target or mint
    // one (viewing only — never marks it spawned), then redirect to the player.
    const view = u.pathname.match(/^\/view\/([0-9A-Fa-f]+)$/);
    if (view && req.method === 'GET') {
      const targetId = view[1];
      let leaseId = null;
      for (const [lid, L] of leases) if (L.targetId === targetId) { leaseId = lid; break; }
      if (!leaseId) { leaseId = newLeaseId(); leases.set(leaseId, { targetId, spawned: false, viewers: new Set(), lastSeen: Date.now() }); }
      res.writeHead(302, { Location: '/v/' + leaseId }); return res.end();
    }

    const del = u.pathname.match(/^\/lease\/(L[0-9a-f]+)$/);
    if (del && req.method === 'DELETE') {
      const L = leases.get(del[1]); if (!L) return send(404, { error: 'no such lease' });
      leases.delete(del[1]); if (L.spawned) await closeWindow(L.targetId); return send(200, { ok: true });
    }

    const mv = u.pathname.match(/^\/v\/(L[0-9a-f]+)$/);
    if (mv) {
      if (!leases.has(mv[1])) { res.writeHead(404); return res.end('no such lease'); }
      res.writeHead(200, { 'content-type': 'text/html' }); return res.end(renderPlayer(mv[1], req.headers.host));
    }
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(indexHTML()); }
    res.writeHead(404); res.end('not found');
  } catch (e) { res.writeHead(500); res.end('err: ' + e.message); }
});

function readBody(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }); }

// ---- WS routing: /cdp (agents) and /cast/<lease> (viewers) ----
const wss = new WS.Server({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  const u = new URL(req.url, 'http://x');

  // AGENTS: each /cdp connection gets its OWN fresh window and only ever sees
  // that window — hard isolation, so two parallel agents never collide on the
  // same page. Cookies/logins stay shared because all windows live in the one
  // default browser context (requirement #3). We proxy Chrome's browser-level
  // CDP but filter the Target domain so the client only learns about its own
  // window target (and that page's child sessions: iframes/workers).
  if (u.pathname === '/cdp') {
    wss.handleUpgrade(req, socket, head, async client => {
      const early = []; const buffer = (d) => early.push(d);
      client.on('message', buffer);
      let ownTargetId = null, upstream = null;
      const ownedTargets = new Set();    // top-level targets this agent owns: its window + tabs/popups IT opens
      const ownedSessions = new Set();   // flatten-mode sessions for those targets + their iframe/worker children
      const pendingCreate = new Set();   // client Target.createTarget request ids awaiting a targetId
      const bufferedAttach = new Map();  // targetId -> attach msg, held until a pendingCreate response claims it
      const fwd = obj => { if (client.readyState === 1) client.send(JSON.stringify(obj)); };

      // browser_tabs "new" / newPage() send Target.createTarget WITHOUT newWindow. Chrome
      // would put that tab in the FOCUSED window — which is some OTHER agent's window
      // (createTarget's windowId param is ignored by Chrome; verified). So we don't forward
      // those: we run window.open() on this agent's OWN page, which by browser rule lands the
      // new tab in this agent's window, then reply to the client with the new tab's id. The
      // tab attaches with openerId = our page (adopted below) so the client also sees it.
      let sideWs = null, sideSession = null, sideClient = null;
      const createQ = [];                // FIFO of client createTarget ids awaiting their tab
      const ensureSide = async () => {
        if (sideClient) return;
        sideWs = await openBrowserCDP(); sideClient = cdp(sideWs);
        ({ sessionId: sideSession } = await sideClient.send('Target.attachToTarget', { targetId: ownTargetId, flatten: true }));
      };
      const translateOpen = async (url) => {
        // window.open() places the tab in the calling page's window — but only reliably
        // when that window is focused; under another agent's focus the tab can leak to the
        // focused window. So bring THIS agent's window to front first (browser-level
        // activateTarget), making placement deterministic regardless of who was being
        // viewed. (Momentary focus steal only.)
        try {
          await ensureSide();
          await sideClient.send('Target.activateTarget', { targetId: ownTargetId }).catch(() => {});
          await sideClient.send('Runtime.evaluate', { expression: 'window.open(' + JSON.stringify(url || 'about:blank') + ", '_blank')", userGesture: true }, sideSession);
        } catch {}
      };
      try {
        ownTargetId = await spawnWindow('about:blank');   // dedicated window for this agent
        ownedTargets.add(ownTargetId);
        upstream = new WS(await browserWSURL(), { headers: HDR });
        await new Promise((r, j) => { upstream.on('open', r); upstream.on('error', j); });

        // client -> chrome. CDP requires TEXT frames — `ws` sends a Buffer as binary,
        // which Chrome drops, so always stringify. Also force setAutoAttach's
        // waitForDebuggerOnStart=false: we hide foreign targets from this client, so a
        // paused foreign target would never get resumed and would stall the browser.
        const up = d => {
          if (upstream.readyState !== 1) return;
          let s = d.toString();
          try {
            const m = JSON.parse(s);
            if (m.method === 'Target.setAutoAttach' && m.sessionId === undefined && m.params) {
              m.params.waitForDebuggerOnStart = false; s = JSON.stringify(m);
            }
            if (m.method === 'Target.createTarget' && m.id !== undefined) {
              if (m.params && !m.params.newWindow) {
                // Bare createTarget -> translate to window.open on our own page so the tab
                // lands in THIS agent's window (not the focused one). Swallow it here; the
                // client gets its response when the new tab attaches (see below).
                createQ.push(m.id); translateOpen(m.params.url); return;
              }
              // Explicit newWindow: a deliberate separate window — forward as-is and adopt
              // the result via its createTarget response.
              pendingCreate.add(m.id);
            }
          } catch {}
          upstream.send(s);
        };
        client.off('message', buffer);
        for (const d of early) up(d);
        client.on('message', up);

        // chrome -> client: show ONLY targets this agent owns (its window + tabs/popups it
        // opens) and their session subtrees. New tabs are claimed two ways: by correlating
        // the client's createTarget request id with the response, and by openerId for popups.
        upstream.on('message', raw => {
          let m; try { m = JSON.parse(raw.toString()); } catch { return; }
          // session-scoped messages (flatten mode): forward only if it's one of ours.
          // Track nested attaches so iframe/worker child sessions become owned too.
          if (m.sessionId !== undefined) {
            if (!ownedSessions.has(m.sessionId)) return;
            if (m.method === 'Target.attachedToTarget' && m.params && m.params.sessionId) ownedSessions.add(m.params.sessionId);
            else if (m.method === 'Target.detachedFromTarget' && m.params && m.params.sessionId) ownedSessions.delete(m.params.sessionId);
            return fwd(m);
          }
          // command responses (id, no sessionId)
          if (m.id !== undefined) {
            // our createTarget came back -> adopt the new tab + flush its buffered attach
            if (pendingCreate.has(m.id)) {
              pendingCreate.delete(m.id);
              const tid = m.result && m.result.targetId;
              if (tid) {
                ownedTargets.add(tid);
                const buf = bufferedAttach.get(tid);
                if (buf) { bufferedAttach.delete(tid); if (buf.params.sessionId) ownedSessions.add(buf.params.sessionId); fwd(buf); }
              }
            }
            if (m.result && Array.isArray(m.result.targetInfos))
              m.result.targetInfos = m.result.targetInfos.filter(t => ownedTargets.has(t.targetId));
            return fwd(m);
          }
          // browser-level Target.* events: keep only our targets / our sessions
          if (m.method && m.method.startsWith('Target.')) {
            if (m.method === 'Target.attachedToTarget') {
              const ti = m.params.targetInfo || {};
              const ownedByOpener = ti.openerId && ownedTargets.has(ti.openerId);  // window.open child of an owned page
              const owned = ownedTargets.has(ti.targetId) || ownedByOpener;
              if (owned) {
                ownedTargets.add(ti.targetId); ownedSessions.add(m.params.sessionId);
                fwd(m);
                // If this tab is the result of a translated bare createTarget, answer the
                // waiting client with its targetId (FIFO). A genuine agent window.open with
                // no pending create just falls through (already forwarded above).
                if (ownedByOpener && ti.type === 'page' && createQ.length) {
                  fwd({ id: createQ.shift(), result: { targetId: ti.targetId } });
                }
                return;
              }
              // A brand-new page with no owner yet may be THIS agent's createTarget whose
              // response hasn't arrived (the attach fires a beat earlier). Hold it briefly;
              // the create response flushes it, otherwise it expires (it was a foreign tab).
              if (ti.type === 'page') {
                bufferedAttach.set(ti.targetId, m);
                setTimeout(() => bufferedAttach.delete(ti.targetId), 5000);
              }
              return;
            }
            if (m.method === 'Target.detachedFromTarget') {
              if (ownedSessions.has(m.params.sessionId)) { ownedSessions.delete(m.params.sessionId); return fwd(m); }
              return;
            }
            if (['Target.targetCreated', 'Target.targetInfoChanged', 'Target.targetDestroyed'].includes(m.method)) {
              const id = (m.params.targetInfo && m.params.targetInfo.targetId) || m.params.targetId;
              if (m.method === 'Target.targetDestroyed') ownedTargets.delete(id);
              return ownedTargets.has(id) ? fwd(m) : undefined;
            }
            return fwd(m);
          }
          return fwd(m);   // Browser.*, etc.
        });

        let ended = false;
        const end = () => { if (ended) return; ended = true; try { client.close(); } catch {} try { upstream.close(); } catch {} try { sideWs && sideWs.close(); } catch {} if (ownTargetId) closeWindow(ownTargetId); };
        client.on('close', end); upstream.on('close', end); client.on('error', end); upstream.on('error', end);
      } catch (e) { try { client.close(); } catch {} if (ownTargetId) closeWindow(ownTargetId); }
    });
    return;
  }

  // VIEWERS: one screencast per connection (Steel's exact mechanism).
  const mc = u.pathname.match(/^\/cast\/(L[0-9a-f]+)$/);
  if (mc) {
    const L = leases.get(mc[1]);
    if (!L) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, client => castSession(client, L, u.searchParams));
    return;
  }
  socket.destroy();
});

// Speaks Steel's session-player wire protocol, scoped to ONE window (the lease's).
// The player opens two kinds of connections to /cast/<lease>:
//   ?tabInfo=true  -> discovery channel: we push {type:'tabList', tabs, firstTabId}
//                     listing only the pages in THIS lease's OS window.
//   ?pageId=<id>   -> per-page screencast: attach + bringToFront (kills the
//                     occlusion throttle) + Page.startScreencast, streaming
//                     {pageId,url,title,data} frames and handling mouse/key/nav input.
// Cross-agent isolation holds: a pageId outside the lease's window is refused.
async function castSession(client, L, q) {
  L.viewers.add(client); L.lastSeen = Date.now();
  const wantTabs = q.get('tabInfo') === 'true';
  const pageId = q.get('pageId');
  const touch = () => { L.lastSeen = Date.now(); };
  let bws, c;
  try {
    bws = await openBrowserCDP(); c = cdp(bws);
    const { windowId } = await c.send('Browser.getWindowForTarget', { targetId: L.targetId });

    if (wantTabs) {
      const push = async () => {
        if (client.readyState !== 1) return;
        const pages = (await getJSON('/json/list')).filter(t => t.type === 'page');
        const tabs = [];
        for (const p of pages) {
          try { const w = await c.send('Browser.getWindowForTarget', { targetId: p.id }); if (w.windowId === windowId) tabs.push({ id: p.id, title: p.title, url: p.url, favicon: p.faviconUrl }); } catch {}
        }
        client.send(JSON.stringify({ type: 'tabList', tabs, firstTabId: tabs[0] ? tabs[0].id : null }));
      };
      await push();
      const iv = setInterval(() => { touch(); push().catch(() => {}); }, 1500);
      const stop = () => { clearInterval(iv); L.viewers.delete(client); try { bws.close(); } catch {} };
      client.on('close', stop); client.on('error', stop);
      return;
    }

    if (!pageId) { client.close(); try { bws.close(); } catch {} return; }
    // isolation: requested page must live in this lease's window
    const w = await c.send('Browser.getWindowForTarget', { targetId: pageId }).catch(() => null);
    if (!w || w.windowId !== windowId) { client.close(); try { bws.close(); } catch {} return; }

    const { sessionId } = await c.send('Target.attachToTarget', { targetId: pageId, flatten: true });
    await c.send('Page.enable', {}, sessionId);
    await c.send('Target.activateTarget', { targetId: pageId });   // bringToFront -> no occlusion throttle
    // Match Steel: pin the viewport + screencast at full res so (a) the image isn't
    // downscaled (crisp) and (b) the player's click coords (image px) map 1:1 to page
    // CSS px. Set via OUR session, so Chrome auto-clears the override when the viewer
    // detaches — the agent's page isn't permanently resized.
    const VW = SCREENCAST_MAXW, VH = SCREENCAST_MAXH;
    await c.send('Page.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false, screenWidth: VW, screenHeight: VH, screenOrientation: { angle: 0, type: 'landscapePrimary' } }, sessionId).catch(() => {});

    let info = { url: '', title: '' };
    const refreshInfo = async () => { try { const r = await c.send('Target.getTargetInfo', { targetId: pageId }); info = { url: r.targetInfo.url, title: r.targetInfo.title }; } catch {} };
    await refreshInfo();
    const infoIv = setInterval(() => refreshInfo().catch(() => {}), 1000);

    c.on(msg => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Page.screencastFrame') {
        c.send('Page.screencastFrameAck', { sessionId: msg.params.sessionId }, sessionId).catch(() => {});
        touch();
        if (client.readyState === 1) client.send(JSON.stringify({ pageId, url: info.url, title: info.title, data: msg.params.data }));
      }
    });
    await c.send('Page.startScreencast', { format: 'jpeg', quality: SCREENCAST_QUALITY, maxWidth: SCREENCAST_MAXW, maxHeight: SCREENCAST_MAXH }, sessionId);

    client.on('message', buf => {
      touch();
      let e; try { e = JSON.parse(buf); } catch { return; }
      if (e.type === 'mouseEvent') { const ev = e.event; c.send('Input.dispatchMouseEvent', { type: ev.type, x: ev.x, y: ev.y, button: ev.button, buttons: ev.button === 'none' ? 0 : 1, clickCount: ev.clickCount || 1, modifiers: ev.modifiers || 0, deltaX: ev.deltaX, deltaY: ev.deltaY }, sessionId).catch(() => {}); }
      else if (e.type === 'keyEvent') { const ev = e.event; c.send('Input.dispatchKeyEvent', { type: ev.type, text: ev.text, unmodifiedText: ev.text ? ev.text.toLowerCase() : undefined, code: ev.code, key: ev.key, windowsVirtualKeyCode: ev.keyCode, nativeVirtualKeyCode: ev.keyCode }, sessionId).catch(() => {}); }
      else if (e.type === 'navigation') { const a = e.event || {}; if (a.url) c.send('Page.navigate', { url: a.url }, sessionId).catch(() => {}); else if (a.action === 'refresh') c.send('Page.reload', {}, sessionId).catch(() => {}); else if (a.action === 'back') c.send('Runtime.evaluate', { expression: 'history.back()' }, sessionId).catch(() => {}); else if (a.action === 'forward') c.send('Runtime.evaluate', { expression: 'history.forward()' }, sessionId).catch(() => {}); }
      else if (e.type === 'closeTab') { c.send('Target.closeTarget', { targetId: pageId }).catch(() => {}); }
    });

    const stop = () => { clearInterval(infoIv); L.viewers.delete(client); try { c.send('Page.stopScreencast', {}, sessionId).catch(() => {}); } catch {} try { bws.close(); } catch {} };
    client.on('close', stop); client.on('error', stop);
  } catch (err) {
    try { client.send(JSON.stringify({ type: 'error', msg: err.message })); } catch {}
    try { bws && bws.close(); } catch {}
  }
}

function indexHTML() {
  return `<!doctype html><meta charset=utf8><title>steel broker</title><body style="font:14px system-ui;padding:20px;max-width:860px;margin:auto">
<h3>Steel broker — one Chrome, per-window links</h3>
<p><button onclick="spawn()">+ spawn new window</button></p>
<div id=list>loading…</div>
<script>
// One row per WINDOW (tabs grouped); each row is a direct one-click link to that
// window's live view. window.open(view) follows the /view -> /v/<lease> redirect.
function refresh(){fetch('/windows').then(r=>r.json()).then(ws=>{
  document.getElementById('list').innerHTML = ws.length ? ws.map(function(w){
    var tabs = w.tabs.map(function(t){return '&nbsp;&nbsp;• '+((t.title||t.url||'tab').replace(/</g,'&lt;'))+' <small>'+(t.url||'')+'</small>';}).join('<br>');
    var label = (w.tabs[0] && (w.tabs[0].title||w.tabs[0].url)) || 'window';
    return '<p><a href="'+w.view+'" target=_blank><b>▶ view window</b></a> — '+w.tabs.length+' tab'+(w.tabs.length>1?'s':'')+'<br>'+tabs+'</p>';
  }).join('') : '<i>no windows</i>';
});}
function spawn(){fetch('/spawn',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.json()).then(j=>{window.open(j.viewer,'_blank');setTimeout(refresh,500);});}
refresh();setInterval(refresh,5000);
</script>`;
}

server.listen(PORT, () => console.log('steel broker on :' + PORT + ' chrome=' + CHROME));
