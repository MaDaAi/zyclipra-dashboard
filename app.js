"use strict";
/*
 * Zyclipra website (static, GitHub Pages).
 * - Google sign-in (Google Identity Services, token kept in memory only) → the clips the Zyclipra app uploaded
 *   to Google Drive (drive.file scope: only files Zyclipra made).
 * - PC controls: the app leaves a private "PC link" file in the same Drive folder with this PC's home-network
 *   addresses and a link key. On the same network this page trades the key for a session directly with the
 *   PC (no relay, nothing exposed to the internet). If the browser blocks that, it explains why and links to
 *   the PC's own dashboard instead.
 */
// GitHub Pages can't send X-Frame-Options: refuse to run inside another site's frame (clickjacking).
if (window.top !== window.self) { document.documentElement.style.display = "none"; throw new Error("framed"); }
const CFG = window.ZYCLIPRA || {};
const SCOPE = "https://www.googleapis.com/auth/drive.file openid email profile";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const LINK_NAME = "Zyclipra PC link (keep private).json";

const $ = (id) => document.getElementById(id);
function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
}
let toastTimer = 0;
function toast(msg, error) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (error ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 3500);
}
const fmtTime = (ms) => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
const fmtSize = (b) => b > 1e9 ? (b / 1e9).toFixed(1) + " GB" : b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB";
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""));

// ---------------------------------------------------------------- Google
let gToken = null, gExpiry = 0, tokenClient = null, user = null;

function initGoogle() {
  if (!CFG.googleClientId) { $("login-error").textContent = "This website isn't set up yet (no Google client ID in config.js)."; return; }
  if (!window.google || !google.accounts || !google.accounts.oauth2) { setTimeout(initGoogle, 200); return; }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CFG.googleClientId,
    scope: SCOPE,
    callback: onToken,
    error_callback: (e) => { $("login-error").textContent = e && e.type === "popup_closed" ? "Sign-in was closed." : "Google sign-in didn't work. Allow pop-ups for this site and try again."; },
  });
  $("signin").disabled = false;
}
$("signin").onclick = () => { $("login-error").textContent = ""; tokenClient && tokenClient.requestAccessToken({ prompt: user ? "" : "select_account" }); };

async function onToken(r) {
  if (r.error) { $("login-error").textContent = "Google sign-in was cancelled."; return; }
  if (!google.accounts.oauth2.hasGrantedAllScopes(r, "https://www.googleapis.com/auth/drive.file")) {
    $("login-error").textContent = "Zyclipra needs access to the files it made in your Google Drive. Sign in again and tick that box.";
    return;
  }
  gToken = r.access_token;
  gExpiry = Date.now() + (Number(r.expires_in) || 3600) * 1000;
  const first = !user;
  try {
    user = await (await gfetch("https://www.googleapis.com/oauth2/v3/userinfo")).json();
  } catch (e) { user = { name: "Google account" }; }
  $("who").textContent = user.name || "Google account";
  $("who-mail").textContent = user.email || "";
  if (user.picture) { $("avatar").src = user.picture; $("avatar").hidden = false; }
  $("login").hidden = true;
  $("nav").hidden = false;
  $("conn").hidden = false;
  if (first) show("home");
  loadClips(true);
  findPcs().then(connect);
}

async function gfetch(url, opts) {
  if (!gToken || Date.now() > gExpiry - 30000) { signedOut("Your Google sign-in expired. Sign in again to continue."); throw new Error("signed out"); }
  const o = Object.assign({ cache: "no-store" }, opts || {});
  o.headers = Object.assign({ Authorization: "Bearer " + gToken }, o.headers || {});
  const r = await fetch(url, o);
  if (r.status === 401) { signedOut("Your Google sign-in expired. Sign in again to continue."); throw new Error("signed out"); }
  if (!r.ok) throw new Error("Google Drive error " + r.status);
  return r;
}

function signedOut(msg) {
  gToken = null;
  $("login").hidden = false;
  $("login-error").textContent = msg || "";
  for (const v of ["home", "clips", "sounds", "settings"]) $(v + "-view").hidden = true;
  $("nav").hidden = true;
}

$("signout").onclick = async () => {
  if (pc) { try { await pcApi("web/logout", {}); } catch (e) { /* PC away: its session expires on its own */ } }
  if (gToken) google.accounts.oauth2.revoke(gToken, () => {});
  location.reload();
};

// ---------------------------------------------------------------- views
let view = "home";
function show(v) {
  view = v;
  for (const n of ["home", "clips", "sounds", "settings"]) {
    $(n + "-view").hidden = n !== v;
    $("tab-" + n).classList.toggle("on", n === v);
  }
  if (v === "sounds" && pc) refreshSounds();
  if ((v === "clips" || v === "home") && pc) loadLocal();
}
for (const n of ["home", "clips", "sounds", "settings"]) $("tab-" + n).onclick = () => show(n);
$("see-clips").onclick = () => show("clips");

// ---------------------------------------------------------------- clips from Google Drive
let clips = [], nextPage = null;

async function loadClips(reset) {
  if (reset) { clips = []; nextPage = null; }
  const q = "trashed=false and mimeType != 'application/vnd.google-apps.folder' and mimeType != 'application/json'";
  const fields = "nextPageToken,files(id,name,mimeType,size,createdTime,thumbnailLink,webViewLink,videoMediaMetadata(durationMillis))";
  let url = DRIVE + "?pageSize=60&orderBy=createdTime%20desc&fields=" + encodeURIComponent(fields) + "&q=" + encodeURIComponent(q);
  if (nextPage) url += "&pageToken=" + encodeURIComponent(nextPage);
  try {
    const j = await (await gfetch(url)).json();
    clips = clips.concat(j.files || []);
    nextPage = j.nextPageToken || null;
  } catch (e) {
    if (gToken) toast("Couldn't load your clips from Google Drive.", true);
    return;
  }
  renderClips();
}
$("more").onclick = () => loadClips(false);
$("search").oninput = () => renderClips();
$("kind").onchange = () => renderClips();

function clipCard(f) {
  const b = el("button", "clip-card");
  const th = el("div", "thumb", f.mimeType.startsWith("image/") ? "🖼" : "🎬");
  if (f.thumbnailLink) {
    const img = el("img");
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => img.remove();
    img.src = f.thumbnailLink;
    th.textContent = "";
    th.appendChild(img);
  }
  const body = el("div", "clip-body");
  body.append(el("div", "title", f.name.replace(/\.[a-z0-9]+$/i, "")));
  const d = new Date(f.createdTime);
  const dur = f.videoMediaMetadata && f.videoMediaMetadata.durationMillis ? fmtTime(Number(f.videoMediaMetadata.durationMillis)) + " · " : "";
  body.append(el("div", "meta muted small", dur + d.toLocaleDateString() + " · " + fmtSize(Number(f.size || 0))));
  b.append(th, body);
  b.onclick = () => openClip(f);
  return b;
}

function renderClips() {
  const fromPc = !!pc && $("source").value === "pc";
  $("source").hidden = !pc;
  if (fromPc) { renderLocal(); return; }
  const s = $("search").value.trim().toLowerCase(), k = $("kind").value;
  const list = clips.filter((f) => (!s || f.name.toLowerCase().includes(s)) && (!k || f.mimeType.startsWith(k + "/")));
  $("clip-grid").replaceChildren(...list.map(clipCard));
  $("clip-stats").textContent = clips.length ? list.length + " of " + clips.length + (nextPage ? "+" : "") + " on Google Drive" : "No clips on Google Drive yet – turn on automatic upload in the Zyclipra app.";
  $("more").hidden = !nextPage;
  if (!pc) $("recent").replaceChildren(...clips.slice(0, 6).map(clipCard));
}

// ---------------------------------------------------------------- clips on the PC (while connected)
let local = [];
const thumbCache = new Map();
/** Any website action on the PC, over WebRTC or HTTPS alike. */
function pcCall(action, args) { return pc && pc.rtc ? pcApi(action, args || {}) : pcApi("call", { a: action, b: args || {} }); }

async function loadLocal() {
  if (!pc) return;
  try {
    const j = await pcCall("clips", { limit: 120 });
    local = Array.isArray(j) ? j : j.clips || [];
  } catch (e) { return; }
  renderClips();
  $("recent").replaceChildren(...local.slice(0, 6).map(localCard));
}
$("source").onchange = () => renderClips();

function localCard(c) {
  const b = el("button", "clip-card");
  const shot = c.kind === "screenshot";
  const th = el("div", "thumb", shot ? "🖼" : "🎬");
  const show = (url) => { const img = el("img"); img.alt = ""; img.src = url; th.textContent = ""; th.appendChild(img); };
  if (thumbCache.has(c.id)) show(thumbCache.get(c.id));
  else thumbQueue.push(() => pcCall("clip/thumb", { id: c.id }).then((t) => {
    const url = "data:image/jpeg;base64," + t.data;
    thumbCache.set(c.id, url);
    show(url);
  }).catch(() => {}));
  pumpThumbs();
  const body = el("div", "clip-body");
  body.append(el("div", "title", c.title || "Clip"));
  const dur = c.durationSec ? fmtTime(c.durationSec * 1000) + " · " : "";
  body.append(el("div", "meta muted small", dur + new Date(c.createdAt).toLocaleDateString() + " · " + fmtSize(Number(c.sizeBytes || 0))));
  b.append(th, body);
  b.onclick = () => openLocal(c);
  return b;
}

const thumbQueue = [];
let thumbsBusy = 0;
function pumpThumbs() {
  while (thumbsBusy < 3 && thumbQueue.length) {
    thumbsBusy++;
    thumbQueue.shift()().finally(() => { thumbsBusy--; pumpThumbs(); });
  }
}

function renderLocal() {
  const s = $("search").value.trim().toLowerCase(), k = $("kind").value;
  const list = local.filter((c) => (!s || (c.title || "").toLowerCase().includes(s))
    && (!k || (k === "image" ? c.kind === "screenshot" : c.kind !== "screenshot")));
  $("clip-grid").replaceChildren(...list.map(localCard));
  $("clip-stats").textContent = local.length ? list.length + " of " + local.length + " on your PC" : "No clips on your PC yet.";
  $("more").hidden = true;
}

/** Copies a clip from the PC in pieces (several at once), then plays it here. */
async function fetchLocal(c, progress) {
  const first = await pcCall("clip/part", { id: c.id, offset: 0 });
  const size = first.size, part = 36 * 1024;
  const parts = new Array(Math.ceil(size / part) || 1);
  const dec = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  parts[0] = dec(first.data);
  let next = 1, done = 1;
  const worker = async () => {
    while (next < parts.length) {
      const i = next++;
      parts[i] = dec((await pcCall("clip/part", { id: c.id, offset: i * part })).data);
      progress(++done / parts.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return URL.createObjectURL(new Blob(parts, { type: c.kind === "screenshot" ? "image/png" : "video/mp4" }));
}

/** Bytes start..end (inclusive) of a PC clip, fetched in parallel pieces over the connection. */
async function readRange(id, start, end) {
  const part = 36 * 1024, offsets = [];
  for (let o = start; o <= end; o += part) offsets.push(o);
  const dec = (b64) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  const got = new Array(offsets.length);
  let next = 0;
  const worker = async () => {
    while (next < offsets.length) {
      const i = next++;
      got[i] = dec((await pcCall("clip/part", { id, offset: offsets[i] })).data);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, offsets.length) }, worker));
  const out = new Uint8Array(end - start + 1);
  let at = 0;
  for (const g of got) { const n = Math.min(g.length, out.length - at); out.set(g.subarray(0, n), at); at += n; }
  return out.buffer.slice(0, at);
}

// The streaming helper (sw.js) asks the page for byte ranges; the page fetches them from the PC.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js?v=1").then(async () => {
    await navigator.serviceWorker.ready;
    // iPhone only lets the helper handle requests after the page loads again: do that once, before sign-in.
    if (!navigator.serviceWorker.controller && !gToken) {
      try { if (!sessionStorage.getItem("zy-sw")) { sessionStorage.setItem("zy-sw", "1"); location.reload(); } } catch (e) { /* storage blocked */ }
    }
  }).catch(() => {});
  navigator.serviceWorker.addEventListener("message", async (ev) => {
    if (!ev.data || ev.data.type !== "pcmedia" || !ev.ports[0]) return;
    try {
      const bytes = await readRange(ev.data.id, ev.data.start, ev.data.end);
      ev.ports[0].postMessage({ bytes }, [bytes]);
    } catch (e) { ev.ports[0].postMessage({ error: e.message }); }
  });
}

async function openLocal(c) {
  const f = { name: (c.title || "clip") + (c.kind === "screenshot" ? ".png" : ".mp4"), local: c };
  playerFile = f;
  $("player-title").textContent = c.title || "Clip";
  $("player-meta").textContent = "On your PC · " + new Date(c.createdAt).toLocaleString() + " · " + fmtSize(Number(c.sizeBytes || 0));
  $("player-drive").hidden = true;
  $("player-media").replaceChildren();
  $("player").showModal();
  if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = null; }
  const size = Number(c.sizeBytes || 0);
  if (navigator.serviceWorker && navigator.serviceWorker.controller && size > 0) {
    // Plays straight from the PC: the player fetches only the parts it needs, so it starts at once and can seek.
    const shot = c.kind === "screenshot";
    const m = shot ? el("img") : el("video");
    if (!shot) { m.controls = true; m.playsInline = true; m.preload = "metadata"; }
    m.onerror = () => $("player-media").replaceChildren(el("p", "error-text", "Couldn't play it from your PC."));
    m.src = "pcmedia/" + encodeURIComponent(c.id) + "/" + size + "/" + (shot ? "image" : "video");
    $("player-media").replaceChildren(m);
    return;
  }
  const msg = el("p", "muted", "Copying from your PC…");
  $("player-media").replaceChildren(msg);
  try {
    if (playerUrl) URL.revokeObjectURL(playerUrl);
    playerUrl = null;
    const url = await fetchLocal(c, (p) => { msg.textContent = "Copying from your PC… " + Math.round(p * 100) + "%"; });
    if (playerFile !== f) { URL.revokeObjectURL(url); return; }
    playerUrl = url;
    const m = c.kind === "screenshot" ? el("img") : el("video");
    if (m.tagName === "VIDEO") { m.controls = true; m.playsInline = true; }
    m.src = url;
    $("player-media").replaceChildren(m);
  } catch (e) { $("player-media").replaceChildren(el("p", "error-text", "Couldn't copy it from your PC: " + e.message)); }
}

let playerUrl = null, playerFile = null;
async function fetchBlob(f) {
  const r = await gfetch(DRIVE + "/" + encodeURIComponent(f.id) + "?alt=media");
  return URL.createObjectURL(await r.blob());
}
async function openClip(f) {
  playerFile = f;
  $("player-title").textContent = f.name;
  $("player-meta").textContent = new Date(f.createdTime).toLocaleString() + " · " + fmtSize(Number(f.size || 0));
  $("player-drive").href = f.webViewLink || "https://drive.google.com";
  $("player-drive").hidden = false;
  $("player-media").replaceChildren(el("p", "muted", "Loading from Google Drive…"));
  $("player").showModal();
  if (Number(f.size) > 300e6) { $("player-media").replaceChildren(el("p", "muted", "This one is large – use Download or open it in Google Drive.")); return; }
  try {
    if (playerUrl) URL.revokeObjectURL(playerUrl);
    playerUrl = await fetchBlob(f);
    if (playerFile !== f) return;
    const m = f.mimeType.startsWith("image/") ? el("img") : el("video");
    if (m.tagName === "VIDEO") { m.controls = true; m.playsInline = true; }
    m.src = playerUrl;
    $("player-media").replaceChildren(m);
  } catch (e) { $("player-media").replaceChildren(el("p", "error-text", "Couldn't load it from Google Drive.")); }
}
$("player-close").onclick = () => $("player").close();
$("player").addEventListener("close", () => { $("player-media").replaceChildren(); if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = null; } });
$("player-download").onclick = async () => {
  const f = playerFile;
  if (!f) return;
  $("player-download").disabled = true;
  try {
    if (f.local && !playerUrl) {
      toast("Copying from your PC…");
      playerUrl = await fetchLocal(f.local, (p) => { $("player-download").textContent = "Copying " + Math.round(p * 100) + "%"; });
      $("player-download").textContent = "Download";
    }
    const url = playerUrl || await fetchBlob(f);
    const a = el("a");
    a.href = url; a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
  } catch (e) { toast("Download failed.", true); }
  $("player-download").disabled = false;
};

// ---------------------------------------------------------------- your PC (same network only)
let links = [], pc = null, connecting = false;

/** Home-network, VPN or this-device addresses only: the link key is never sent anywhere else. */
function privateUrl(u) {
  let x;
  try { x = new URL(u); } catch (e) { return false; }
  if (x.protocol !== "https:" || x.pathname !== "/" || x.search || x.username) return false;
  const h = x.hostname;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return h === "localhost";
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

async function findPcs() {
  links = [];
  try {
    const q = "name = '" + LINK_NAME.replace(/'/g, "\\'") + "' and trashed=false";
    const j = await (await gfetch(DRIVE + "?pageSize=10&fields=files(id,modifiedTime)&q=" + encodeURIComponent(q))).json();
    for (const f of j.files || []) {
      try {
        const l = await (await gfetch(DRIVE + "/" + encodeURIComponent(f.id) + "?alt=media")).json();
        if (l.v !== 1 || typeof l.key !== "string" || !Array.isArray(l.urls)) continue;
        l.urls = l.urls.filter(privateUrl).map((u) => u.replace(/\/$/, ""));
        // On the PC itself 127.0.0.1 answers; elsewhere the home-network address does.
        l.urls.sort((a, b) => (b.includes("127.0.0.1") ? 1 : 0) - (a.includes("127.0.0.1") ? 1 : 0));
        l.updated = f.modifiedTime;
        if (l.urls.length) links.push(l);
      } catch (e) { /* unreadable file: skip */ }
    }
  } catch (e) { /* shown below */ }
  renderPcs();
}

function timeout(ms) { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; }

async function connect() {
  if (connecting) return;
  connecting = true;
  pc = null;
  setPcState("connecting");
  const tries = [];
  for (const l of links) for (const base of l.urls) {
    tries.push((async () => {
      const r = await fetch(base + "/api/web/session", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: l.key }),
        signal: timeout(4000), mode: "cors", credentials: "omit", referrerPolicy: "no-referrer",
      });
      if (!r.ok) throw new Error("refused " + r.status);
      const j = await r.json();
      return { base, token: j.token, link: l, name: l.name || j.pc };
    })());
  }
  try { pc = tries.length ? await Promise.any(tries) : null; } catch (e) { pc = null; }
  if (!pc) {
    for (const l of links) {
      if (!l.signal) continue;
      try { pc = await rtcConnect(l); break; } catch (e) { console.warn("WebRTC:", e.message); }
    }
  }
  connecting = false;
  setPcState(pc ? "online" : links.length ? "offline" : "nolink");
  if (pc) { $("source").value = "pc"; refreshStatus(); loadLocal(); if (view === "sounds") refreshSounds(); }
  else renderClips();
}
$("pc-retry").onclick = () => findPcs().then(connect);

function setPcState(s) {
  const conn = $("conn");
  conn.className = "conn " + (s === "online" ? "conn-online" : s === "connecting" ? "conn-connecting" : "conn-interrupted");
  $("conn-text").textContent = s === "online" ? "PC connected" : s === "connecting" ? "Looking for your PC…" : "PC not reachable";
  $("controls").hidden = s !== "online";
  $("sb-live").hidden = s !== "online";
  $("sb-offline").hidden = s === "online";
  const l = pc ? pc.link : links[0];
  $("pc-title").textContent = l && l.name ? l.name : "Your PC";
  $("pc-help").hidden = s !== "offline" && s !== "nolink";
  $("pc-state").textContent = {
    online: "Connected on your home network.",
    connecting: "Looking for your PC on this network…",
    offline: "Not reachable from this device right now. Your clips on Google Drive still work.",
    nolink: "No PC is set up for this website yet. In the Zyclipra app turn on Settings › Hosting › Zyclipra website.",
  }[s];
  if (l) {
    const lan = l.urls.find((u) => !u.includes("127.0.0.1")) || l.urls[0];
    $("pc-open").href = lan + "/";
    $("pc-fp").textContent = l.fingerprint ? "PC certificate fingerprint: " + l.fingerprint : "";
  }
  $("pc-open").hidden = !l;
  renderPcs();
}

function renderPcs() {
  const host = $("pcs");
  if (!links.length) { host.replaceChildren(el("p", "muted small", "None yet.")); return; }
  host.replaceChildren(...links.map((l) => {
    const row = el("div", "pc-row");
    const left = el("div");
    left.append(el("div", "", l.name || "PC"), el("div", "muted small", l.urls.join("  ·  ")));
    row.append(left, el("span", "small " + (pc && pc.link === l ? "ok-text" : "muted"), pc && pc.link === l ? "Connected" : "Not connected"));
    return row;
  }));
}

// ---- WebRTC: works on iPhone and Android without certificate warnings. The offer/answer (with each side's
// certificate fingerprint) go through a small file in your Google Drive; after that everything flows directly
// between this device and the PC on your network, encrypted.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rtcConnect(l) {
  const peer = new RTCPeerConnection();
  const dc = peer.createDataChannel("zyclipra");
  try {
    await peer.setLocalDescription(await peer.createOffer());
    await new Promise((r) => {
      if (peer.iceGatheringState === "complete") r();
      peer.onicegatheringstatechange = () => peer.iceGatheringState === "complete" && r();
      setTimeout(r, 2500);
    });
    const id = newId().replace(/-/g, "");
    await gfetch("https://www.googleapis.com/upload/drive/v3/files/" + encodeURIComponent(l.signal) + "?uploadType=media", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: 1, id, key: l.key, offer: peer.localDescription.sdp, t: Date.now() }),
    });
    let answer = null;
    for (const end = Date.now() + 15000; !answer && Date.now() < end;) {
      await sleep(700);
      try {
        const j = await (await gfetch(DRIVE + "/" + encodeURIComponent(l.signal) + "?alt=media")).json();
        if (j.id === id && typeof j.answer === "string") answer = j.answer;
      } catch (e) { /* keep waiting */ }
    }
    if (!answer) throw new Error("the PC didn't answer");
    await peer.setRemoteDescription({ type: "answer", sdp: answer });
    await new Promise((res, rej) => {
      if (dc.readyState === "open") res();
      dc.onopen = res;
      setTimeout(() => rej(new Error("couldn't reach the PC on this network")), 8000);
    });
  } catch (e) { peer.close(); throw e; }
  const conn = { rtc: dc, peer, link: l, name: l.name, waiting: new Map() };
  dc.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch (x) { return; }
    const w = conn.waiting.get(m.i);
    if (w) { conn.waiting.delete(m.i); w(m); }
  };
  const lost = () => { if (pc === conn) { pc = null; setPcState("offline"); } for (const w of conn.waiting.values()) w({ s: 0 }); conn.waiting.clear(); };
  dc.onclose = lost;
  peer.onconnectionstatechange = () => { if (peer.connectionState === "failed" || peer.connectionState === "closed") lost(); };
  return conn;
}

function rtcCall(conn, action, body) {
  return new Promise((resolve) => {
    const i = newId().replace(/-/g, "");
    const t = setTimeout(() => { conn.waiting.delete(i); resolve({ s: 0 }); }, 30000);
    conn.waiting.set(i, (m) => { clearTimeout(t); resolve(m); });
    conn.rtc.send(JSON.stringify({ i, a: action, b: body || {} }));
  });
}

/** A call to the PC. Commands carry an id so a retried tap never runs twice. */
async function pcApi(path, body, command) {
  if (!pc) throw new Error("Your PC isn't connected.");
  if (pc.rtc) {
    if (path === "web/logout") { pc.peer.close(); return {}; }
    const m = await rtcCall(pc, path, body);
    if (!m.s) { pc = null; setPcState("offline"); throw new Error("Lost the connection to your PC."); }
    if (m.s !== 200) throw new Error((m.b && (m.b.error || m.b.ok)) || "Your PC said no (" + m.s + ").");
    return m.b;
  }
  const h = { Authorization: "Bearer " + pc.token };
  if (body) h["Content-Type"] = "application/json";
  if (command) h["X-Command-Id"] = newId();
  let r;
  try {
    r = await fetch(pc.base + "/api/" + path, { method: body ? "POST" : "GET", headers: h, body: body ? JSON.stringify(body) : undefined,
      signal: timeout(command ? 30000 : 6000), mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" });
  } catch (e) {
    pc = null;
    setPcState("offline");
    throw new Error("Lost the connection to your PC.");
  }
  if (r.status === 401) { pc = null; connect(); throw new Error("Reconnecting to your PC…"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Your PC said no (" + r.status + ").");
  return j;
}

/** Runs a command and shows what the PC answered – success only after the PC confirms. */
async function run(action, args, button) {
  if (button) button.classList.add("busy");
  try {
    const j = await pcApi(action, args || {}, true);
    if (j.ok && j.ok !== "true") toast(j.ok);
    return j;
  } catch (e) { toast(e.message, true); return null; }
  finally {
    if (button) button.classList.remove("busy");
    refreshStatus();
    if (["replay/save", "screenshot", "recording/stop"].includes(action)) setTimeout(loadLocal, 800);
  }
}

// ---------------------------------------------------------------- dashboard controls
let status = null, statusAt = 0;
async function refreshStatus() {
  if (!pc) return;
  try { status = await pcApi("status"); statusAt = Date.now(); renderStatus(); } catch (e) { /* state already updated */ }
}
function renderStatus() {
  const s = status;
  if (!s) return;
  $("clip-it").disabled = !s.replay;
  $("clip-it").classList.toggle("off", !s.replay);
  $("clip-it-sub").textContent = s.replay ? "Saves the last " + s.replaySeconds + " s" : "Turn on instant replay first";
  const rec = s.recording;
  $("rec-btn").classList.toggle("on", rec);
  $("rec-text").textContent = rec ? "Stop" : "Record";
  $("rec-timer").textContent = rec ? fmtTime(s.elapsedMs + (Date.now() - statusAt)) : "";
  $("replay-switch").checked = !!s.replay;
  $("replay-state").textContent = s.replay ? "On – " + Math.min(s.replayAvailable || 0, s.replaySeconds) + " s ready" : "Off";
  if (document.activeElement !== $("replay-length")) $("replay-length").value = String(s.replaySeconds);
}
$("clip-it").onclick = () => run("replay/save", {}, $("clip-it"));
$("rec-btn").onclick = () => run(status && status.recording ? "recording/stop" : "recording/start", {}, $("rec-btn"));
$("shot-btn").onclick = () => run("screenshot", {}, $("shot-btn"));
$("replay-switch").onchange = (e) => run(e.target.checked ? "replay/on" : "replay/off", {});
$("replay-length").onchange = (e) => run("replay/length", { seconds: Number(e.target.value) });

// ---------------------------------------------------------------- soundboard
let sounds = null, page = "";

function gainSlider(host, label, onChange, onCommit) {
  host.replaceChildren();
  const top = el("div", "gain-top"), pct = el("output", "gain-pct", "100%");
  top.append(el("span", "gain-name", label), pct);
  const range = el("input");
  range.type = "range"; range.min = "0"; range.max = "300"; range.step = "1";
  range.setAttribute("aria-label", label + " volume, 0 to 300 percent");
  const marks = el("div", "gain-marks");
  for (const m of ["0%", "100%", "200%", "300%"]) marks.appendChild(el("span", "", m));
  host.append(top, range, marks);
  let dragging = false;
  const paint = () => {
    const v = Number(range.value);
    pct.textContent = v + "%";
    pct.className = "gain-pct" + (v > 100 ? " amp" : "");
    range.style.setProperty("--fill", v / 3 + "%");
    range.classList.toggle("amp", v > 100);
  };
  range.addEventListener("pointerdown", () => (dragging = true));
  range.addEventListener("input", () => { if (Math.abs(Number(range.value) - 100) <= 3) range.value = "100"; paint(); onChange(Number(range.value) / 100); });
  range.addEventListener("change", () => { dragging = false; onCommit(Number(range.value) / 100); });
  return (g) => { if (!dragging && document.activeElement !== range) { range.value = String(Math.round(g * 100)); paint(); } };
}
let lastMaster = 0;
const setMaster = gainSlider($("master-gain"), "Soundboard", (g) => {
  const now = Date.now();
  if (now - lastMaster > 150) { lastMaster = now; pcApi("sounds/master", { gain: g }, true).catch(() => {}); }
}, (g) => run("sounds/master", { gain: g }));

async function refreshSounds() {
  if (!pc) return;
  try { sounds = await pcApi("sounds"); renderSounds(); } catch (e) { /* offline state shown */ }
}

function renderSounds() {
  const s = sounds;
  if (!s) return;
  setMaster(s.master);
  const pages = s.pages && s.pages.length ? s.pages : [];
  if (page && !pages.includes(page)) page = "";
  const chips = [el("button", "chip" + (page === "" ? " on" : ""), "All")];
  chips[0].onclick = () => { page = ""; renderSounds(); };
  for (const p of pages) {
    const c = el("button", "chip" + (page === p ? " on" : ""), p);
    c.onclick = () => { page = p; renderSounds(); };
    chips.push(c);
  }
  $("sb-pages").replaceChildren(...chips);
  $("sb-pages").hidden = pages.length < 2;
  const pads = $("pads");
  const list = s.sounds.filter((x) => !page || x.category === page);
  // Update existing pads in place so a tap in progress isn't lost.
  if (pads.dataset.sig !== list.map((x) => x.id + x.name + x.color + x.icon).join("|")) {
    pads.dataset.sig = list.map((x) => x.id + x.name + x.color + x.icon).join("|");
    pads.replaceChildren(...list.map(pad));
    if (!list.length) pads.replaceChildren(el("p", "muted", "No sounds yet – add some in the Zyclipra app."));
  }
  for (const x of list) {
    const b = pads.querySelector('[data-id="' + x.id + '"]');
    if (!b) continue;
    b.classList.toggle("playing", x.playing);
    b.querySelector(".sound-progress").style.width = (x.playing ? Math.max(2, x.progress * 100) : 0) + "%";
  }
}

function pad(x) {
  const b = el("button", "sound");
  b.dataset.id = x.id;
  if (x.color) b.style.setProperty("--pad", x.color);
  b.append(el("span", "sound-icon", x.icon || "♪"), el("span", "sound-name", x.name),
    el("span", "sound-meta", (x.volume !== 1 ? Math.round(x.volume * 100) + "% · " : "") + (x.duration ? x.duration.toFixed(1) + " s" : "")),
    el("span", "sound-progress"), el("span", "sound-stop", "■"));
  b.onclick = async (ev) => {
    const stop = ev.target.classList.contains("sound-stop");
    b.classList.add("pressed");
    setTimeout(() => b.classList.remove("pressed"), 120);
    try { await pcApi(stop ? "sounds/stop" : "sounds/play", { id: x.id }, true); }
    catch (e) { b.classList.add("failed"); setTimeout(() => b.classList.remove("failed"), 900); toast(e.message, true); }
    refreshSounds();
  };
  return b;
}
$("stop-all").onclick = () => run("sounds/stopAll", {}, $("stop-all")).then(refreshSounds);

// ---------------------------------------------------------------- polling (only while the page is visible)
let tick = 0;
setInterval(() => {
  if (document.hidden || !gToken) return;
  tick++;
  if (pc) {
    if (tick % 4 === 0) refreshStatus(); else if (status && status.recording) renderStatus();
    if (view === "sounds" && tick % 2 === 0) refreshSounds();
  } else if (links.length && !connecting && tick % 40 === 0) connect();   // came back into range
}, 500);
document.addEventListener("visibilitychange", () => { if (!document.hidden && gToken) { if (pc) { refreshStatus(); refreshSounds(); } else connect(); } });

initGoogle();
