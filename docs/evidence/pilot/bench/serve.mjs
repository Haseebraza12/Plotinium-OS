import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const types = { '.html':'text/html', '.mjs':'text/javascript', '.js':'text/javascript', '.wasm':'application/wasm', '.json':'application/json' };
const root = process.cwd();
http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  fs.readFile(p === root + '/' ? root + '/index.html' : p, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); res.end(data);
  });
}).listen(18923, () => console.log('listening'));
