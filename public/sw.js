// Stupid Play service worker — intercepts HLS requests and serves from wasm FS via main page
const PREFIX = '/__stupidplay__/';
const TIMEOUT_MS = 30000;
const sessions = new Map();

self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('message', e => {
  const { type, sessionId } = e.data || {};
  if (type === 'init') {
    sessions.set(sessionId, { playlist: '', segments: new Map(), inFlight: new Map() });
  } else if (type === 'playlist') {
    const s = sessions.get(sessionId);
    if (s) s.playlist = e.data.playlist;
  } else if (type === 'close') {
    sessions.delete(sessionId);
  }
});

async function fetchSegmentFromClient(sessionId, uri) {
  const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of allClients) {
    try {
      const ch = new MessageChannel();
      const result = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
        ch.port1.onmessage = ev => { clearTimeout(t); resolve(ev.data); };
        client.postMessage({ type: 'need-segment', sessionId, uri }, [ch.port2]);
      });
      if (result?.data instanceof ArrayBuffer) return result;
    } catch { /* try next client */ }
  }
  return null;
}

async function getSegment(sessionId, uri) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  const cached = session.segments.get(uri);
  if (cached) return cached;

  const existing = session.inFlight.get(uri);
  if (existing) return existing;

  const pending = (async () => {
    const result = await fetchSegmentFromClient(sessionId, uri);
    if (result) {
      session.segments.set(uri, result);
    }
    return result;
  })();

  session.inFlight.set(uri, pending);
  try { return await pending; } finally { session.inFlight.delete(uri); }
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const idx = url.pathname.indexOf(PREFIX);

  // For non-stupidplay requests: inject COOP/COEP headers for cross-origin isolation
  if (idx === -1) {
    if (e.request.cache === 'only-if-cached' && e.request.mode !== 'same-origin') return;
    e.respondWith(
      fetch(e.request).then(r => {
        if (r.status === 0) return r; // opaque response, can't modify
        const headers = new Headers(r.headers);
        headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
        if (e.request.mode === 'navigate') {
          headers.set('Cross-Origin-Opener-Policy', 'same-origin');
          headers.set('Cache-Control', 'no-cache');
        }
        return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
      }).catch(err => {
        if (e.request.mode === 'navigate') throw err;
        return fetch(e.request); // fallback for non-navigations
      })
    );
    return;
  }

  const rest = url.pathname.slice(idx + PREFIX.length);
  const slash = rest.indexOf('/');
  const sessionId = rest.slice(0, slash);
  const resource = rest.slice(slash + 1);
  const session = sessions.get(sessionId);

  if (!session) {
    e.respondWith(new Response('no session', { status: 404 }));
    return;
  }

  if (resource === 'playlist.m3u8') {
    e.respondWith(new Response(session.playlist, {
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' },
    }));
    return;
  }

  e.respondWith((async () => {
    const seg = await getSegment(sessionId, resource);
    if (!seg) return new Response('segment not found', { status: 404 });
    // Slice to avoid detaching the cached buffer
    return new Response(seg.data.slice(0), {
      headers: { 'Content-Type': seg.contentType || 'video/mp2t', 'Cache-Control': 'no-store' },
    });
  })());
});
