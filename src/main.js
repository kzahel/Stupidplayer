import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny';
import Hls from 'hls.js';
import coreJsUrl from '../vendor/ffmpeg-core.js?url';
import coreWasmUrl from '../vendor/ffmpeg-core.wasm?url';
// classWorkerURL served from public/ (not blob URL) so its relative imports resolve

const $ = id => document.getElementById(id);
const status = msg => $('status').textContent = msg;
const log = (msg, cls = 'd') => {
  const el = $('log');
  el.innerHTML += `<span class="${cls}">${msg}\n</span>`;
  el.scrollTop = el.scrollHeight;
};

// ─── 1. Service worker ───
status('Registering service worker...');
await navigator.serviceWorker.register('./sw.js');
await navigator.serviceWorker.ready;
if (!navigator.serviceWorker.controller) {
  await new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
}
log('Service worker ready', 'g');

// ─── Cross-origin isolation check ───
// GitHub Pages doesn't send COOP/COEP headers; the service worker injects them.
// On first visit the SW isn't active yet, so we reload once after it takes control.
if (!crossOriginIsolated) {
  const reloaded = sessionStorage.getItem('coi-reload');
  if (!reloaded) {
    sessionStorage.setItem('coi-reload', '1');
    log('Not cross-origin isolated — reloading...', 'y');
    status('Enabling cross-origin isolation...');
    location.reload();
    await new Promise(() => {}); // halt execution
  }
  log('Warning: not cross-origin isolated after reload', 'r');
}
sessionStorage.removeItem('coi-reload');
log(`Cross-origin isolated: ${crossOriginIsolated}`, crossOriginIsolated ? 'g' : 'y');

// ─── 2. Load ffmpeg.wasm ───
const ffmpeg = new FFmpeg();
ffmpeg.on('log', ({ message }) => log(`ffmpeg: ${message}`, 'd'));

const t0 = performance.now();
const tick = setInterval(() => status(`Initializing ffmpeg... ${((performance.now() - t0) / 1000).toFixed(0)}s elapsed`), 500);
status('Initializing ffmpeg...');
try {
  await ffmpeg.load({
    coreURL: await toBlobURL(coreJsUrl, 'text/javascript'),
    wasmURL: await toBlobURL(coreWasmUrl, 'application/wasm'),
    classWorkerURL: new URL('./ffmpeg-worker/worker.js', window.location.href).href,
  });
} catch (e) {
  log(`ffmpeg.load failed: ${e.message}`, 'r');
  status('ffmpeg.wasm failed to load — check log');
  throw e;
} finally {
  clearInterval(tick);
}
const loadMs = (performance.now() - t0).toFixed(0);
log(`ffmpeg.wasm ready (${loadMs}ms)`, 'g');
status('Ready — pick a video file');

// ─── State ───
let inputPath = null;
let segmentPlan = [];
let opQueue = Promise.resolve();

function runSerialized(fn) {
  const p = opQueue.then(fn, fn);
  opQueue = p.then(() => {}, () => {});
  return p;
}

// ─── 3. Keyframe detection via mediabunny ───
async function getKeyframeIndex(file) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error('No video track found');

    const [fileDur, trackDur] = await Promise.allSettled([
      input.computeDuration(), videoTrack.computeDuration(),
    ]);
    const duration = [fileDur, trackDur]
      .map(r => r.status === 'fulfilled' ? Number(r.value) : NaN)
      .find(v => Number.isFinite(v) && v > 0);
    if (!duration) throw new Error('Could not determine duration');

    const sink = new EncodedPacketSink(videoTrack);
    const keyframes = [];
    let packet = await sink.getKeyPacket(0, { metadataOnly: true });
    while (packet) {
      const ts = Number(packet.timestamp);
      if (Number.isFinite(ts) && ts >= 0) keyframes.push(ts);
      const next = await sink.getNextKeyPacket(packet, { metadataOnly: true });
      if (!next || Number(next.sequenceNumber) === Number(packet.sequenceNumber)) break;
      packet = next;
    }
    if (!keyframes.length) throw new Error('No keyframes found');
    return { keyframes, duration };
  } finally {
    input.dispose();
  }
}

// ─── 4. Build segment plan from keyframe timestamps ───
function buildSegmentPlan(keyframes, duration, target = 4) {
  const kfs = [...keyframes].filter(t => t >= 0 && t <= duration + 0.001).sort((a, b) => a - b);
  if (!kfs.length || kfs[0] > 0.001) kfs.unshift(0);
  if (duration - kfs[kfs.length - 1] > 0.001) kfs.push(duration);

  const segs = [];
  let i = 0;
  while (i < kfs.length - 1) {
    const start = kfs[i];
    let end = i + 1;
    while (end < kfs.length - 1 && kfs[end] - start + 0.001 < target) end++;
    const dur = Math.max(0.001, kfs[end] - start);
    segs.push({ sequence: segs.length, uri: `seg-${segs.length}.ts`, startSec: start, durationSec: dur });
    i = end;
  }
  return segs;
}

// ─── 5. Generate m3u8 playlist ───
function generatePlaylist(segs) {
  const maxDur = Math.ceil(Math.max(...segs.map(s => s.durationSec)));
  let m = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${maxDur}\n#EXT-X-MEDIA-SEQUENCE:0\n`;
  for (const s of segs) m += `#EXTINF:${s.durationSec.toFixed(6)},\n${s.uri}\n`;
  m += '#EXT-X-ENDLIST\n';
  return m;
}

// ─── 6. Handle on-demand segment requests from service worker ───
navigator.serviceWorker.addEventListener('message', async e => {
  if (e.data?.type !== 'need-segment') return;
  const port = e.ports?.[0];
  if (!port) return;
  const uri = e.data.uri;
  const seg = segmentPlan.find(s => s.uri === uri);

  if (!seg || !inputPath) {
    port.postMessage({ error: 'not found' });
    return;
  }

  try {
    const t0 = performance.now();
    const raw = await runSerialized(async () => {
      const out = `/tmp_${Date.now()}.ts`;
      const code = await ffmpeg.exec([
        '-ss', seg.startSec.toFixed(6),
        '-i', inputPath,
        '-t', seg.durationSec.toFixed(6),
        '-c', 'copy',
        '-copyts',
        '-avoid_negative_ts', 'make_zero',
        '-f', 'mpegts',
        '-v', 'error',
        out,
      ]);
      if (code !== 0) throw new Error(`ffmpeg exit ${code}`);
      const data = await ffmpeg.readFile(out);
      try { await ffmpeg.deleteFile(out); } catch {}
      return data;
    });
    const ms = (performance.now() - t0).toFixed(0);
    const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    port.postMessage({ data: buf, contentType: 'video/mp2t' }, [buf]);
    log(`${uri} → ${(buf.byteLength / 1024).toFixed(0)} KB in ${ms}ms`, 'g');
  } catch (err) {
    log(`${uri} failed: ${err.message}`, 'r');
    port.postMessage({ error: err.message });
  }
});

// ─── 7. File selection → keyframe index → play ───
$('file').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  log(`\nSelected: ${file.name} (${(file.size / 1048576).toFixed(1)} MB)`, 'y');

  try {
    status('Reading keyframe index...');
    const t0 = performance.now();
    const { keyframes, duration } = await getKeyframeIndex(file);
    const probeMs = (performance.now() - t0).toFixed(0);
    log(`${keyframes.length} keyframes, ${duration.toFixed(1)}s duration (parsed in ${probeMs}ms)`, 'g');

    segmentPlan = buildSegmentPlan(keyframes, duration);
    log(`${segmentPlan.length} segments planned (~4s each)`, 'g');

    const playlist = generatePlaylist(segmentPlan);

    // Mount file in ffmpeg.wasm (zero-copy via WORKERFS)
    status('Mounting file...');
    const mountPoint = `/in-${Date.now()}`;
    try { await ffmpeg.createDir(mountPoint); } catch {}
    await ffmpeg.mount('WORKERFS', { files: [file] }, mountPoint);
    inputPath = `${mountPoint}/${file.name}`;
    log(`Mounted: ${inputPath}`, 'g');

    // Init service worker session
    const sessionId = `sp-${Date.now()}`;
    navigator.serviceWorker.controller.postMessage({ type: 'init', sessionId });
    navigator.serviceWorker.controller.postMessage({ type: 'playlist', sessionId, playlist });

    // Play with hls.js
    status('Starting playback...');
    const url = `./__stupidplay__/${sessionId}/playlist.m3u8`;
    const video = $('v');
    video.style.display = 'block';

    if (Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 60 });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); status('Playing'); });
      hls.on(Hls.Events.ERROR, (_, d) => {
        log(`hls.js: ${d.details}`, d.fatal ? 'r' : 'd');
        if (d.fatal) status('Playback error');
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      status('Playing (native HLS)');
    } else {
      log('No HLS support', 'r');
      status('Browser does not support HLS');
    }
  } catch (err) {
    log(`Error: ${err.message}`, 'r');
    status('Failed — check log');
  }
});
