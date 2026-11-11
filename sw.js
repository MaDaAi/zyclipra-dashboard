"use strict";
/*
 * Lets <video> play clips straight from your PC. The PC is only reachable through the page's WebRTC connection,
 * which a video element can't use, so requests for pcmedia/<id>/<size>/<kind> are answered here: each byte range
 * the player asks for is fetched by the page over WebRTC and returned as a normal 206 response, so playback
 * starts at once and seeking works. Every other request goes to the network untouched.
 */
const CHUNK = 1024 * 1024;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const m = new URL(e.request.url).pathname.match(/\/pcmedia\/([A-Za-z0-9_-]{1,80})\/(\d{1,12})\/(video|image)$/);
  if (!m) return;
  e.respondWith(serve(e, m[1], Number(m[2]), m[3]));
});

async function serve(e, id, size, kind) {
  let start = 0, end = size - 1;
  const r = /bytes=(\d*)-(\d*)/.exec(e.request.headers.get("Range") || "");
  if (r && r[1]) start = Number(r[1]);
  if (r && !r[1] && r[2]) start = Math.max(0, size - Number(r[2]));      // "last N bytes"
  else if (r && r[2]) end = Number(r[2]);
  if (start >= size) return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + size } });
  // Videos come in pieces (the player asks again for the rest); a screenshot comes whole.
  end = Math.min(end, size - 1, kind === "video" ? start + CHUNK - 1 : size - 1);
  try {
    const client = (e.clientId && await self.clients.get(e.clientId)) || (await self.clients.matchAll({ type: "window" }))[0];
    if (!client) throw new Error("no page");
    const bytes = await ask(client, { type: "pcmedia", id, start, end });
    return new Response(bytes, {
      status: kind === "video" || r ? 206 : 200,
      headers: {
        "Content-Type": kind === "video" ? "video/mp4" : "image/png",
        "Content-Length": String(bytes.byteLength),
        "Content-Range": "bytes " + start + "-" + (start + bytes.byteLength - 1) + "/" + size,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return new Response(null, { status: 503 });
  }
}

function ask(client, msg) {
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => reject(new Error("timeout")), 30000);
    ch.port1.onmessage = (ev) => { clearTimeout(t); ev.data && ev.data.bytes ? resolve(ev.data.bytes) : reject(new Error("failed")); };
    client.postMessage(msg, [ch.port2]);
  });
}
