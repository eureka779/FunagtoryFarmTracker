// Fungatory server: serves the app and keeps one shared copy of the farm data.
// No dependencies. Data lives in $DATA_DIR/fungatory-db.json with a daily backup in $DATA_DIR/backups.
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = __dirname, DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA, 'fungatory-db.json'), KEY = process.env.FARM_KEY || '', PORT = +process.env.PORT || 80;
fs.mkdirSync(DATA, { recursive: true });

let st = { version: 0, records: {} };
try { st = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}

function writeNow() { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(st)); fs.renameSync(tmp, FILE); }
let saveT = null;
function persist() { clearTimeout(saveT); saveT = setTimeout(writeNow, 200); }
function backup() {
  try {
    const dir = path.join(DATA, 'backups'); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `fungatory-${new Date().toISOString().slice(0, 10)}.json`);
    if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify(st));
    const old = fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort();          // keep 60 days
    old.slice(0, Math.max(0, old.length - 60)).forEach(n => fs.unlinkSync(path.join(dir, n)));
  } catch (e) { console.error('backup failed', e.message); }
}
backup(); setInterval(backup, 3600e3);
const stop = () => { clearTimeout(saveT); try { writeNow(); } catch (e) {} process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const send = (res, code, body, type) => { res.writeHead(code, { 'content-type': type || 'application/json', 'cache-control': 'no-store' }); res.end(body); };

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/sync') {
    if (KEY && req.headers['x-farm-key'] !== KEY) return send(res, 401, '{"error":"farm key required"}');
    if (req.method === 'GET') {
      const since = +u.searchParams.get('since') || 0, changes = {};
      for (const [k, r] of Object.entries(st.records)) if (r.ver > since) changes[k] = r.val;
      return send(res, 200, JSON.stringify({ version: st.version, changes }));
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 50e6) req.destroy(); });
      req.on('end', () => {
        try {
          const { changes } = JSON.parse(body);
          for (const [k, v] of Object.entries(changes || {})) { st.version++; st.records[k] = { ver: st.version, val: v }; }
          persist(); send(res, 200, JSON.stringify({ version: st.version }));
        } catch (e) { send(res, 400, '{"error":"bad request"}'); }
      });
      return;
    }
    return send(res, 405, '{"error":"method"}');
  }
  // static files
  let p = decodeURIComponent(u.pathname);
  if (p === '/' || p === '') p = fs.existsSync(path.join(ROOT, 'index.html')) ? '/index.html' : '/fungatory.html';
  const f = path.join(ROOT, path.normalize(p));
  const rel = path.relative(ROOT, f);
  if (rel.startsWith('..') || rel.split(path.sep).some(s => s.startsWith('.')) || rel === 'server.js' || rel.startsWith('data'))
    return send(res, 404, 'Not found', 'text/plain');
  fs.readFile(f, (e, d) => {
    if (e) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(d);
  });
}).listen(PORT, () => console.log(`Fungatory on :${PORT}, data in ${DATA}${KEY ? ', farm key on' : ', NO farm key set'}`));
