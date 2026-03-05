#!/usr/bin/env node
// Tiny static file server with COOP/COEP headers for ffmpeg.wasm
const http = require('http');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json',
};

http.createServer((req, res) => {
  const url = (req.url === '/' ? '/index.html' : req.url).split('?')[0];
  const file = path.join(__dirname, url);

  // Required for SharedArrayBuffer (ffmpeg.wasm)
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(3000, () => console.log('\n  Stupid Play → http://localhost:3000\n'));
