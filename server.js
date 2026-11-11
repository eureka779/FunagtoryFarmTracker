// Fungatory server: serves the app and keeps one shared copy of the farm data.
// No dependencies. Data lives in $DATA_DIR/fungatory-db.json with a daily backup in $DATA_DIR/backups.
const http = require('http'), https = require('https'), crypto = require('crypto'), fs = require('fs'), path = require('path');
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
    const df = path.join(dir, `fungatory-docs-${new Date().toISOString().slice(0, 10)}.json`), src = path.join(DATA, 'fungatory-docs.json');
    if (!fs.existsSync(df) && fs.existsSync(src)) fs.copyFileSync(src, df);
    const old = fs.readdirSync(dir).filter(n => n.endsWith('.json') && !n.includes('-docs-')).sort();
    const oldD = fs.readdirSync(dir).filter(n => n.includes('-docs-')).sort();
    oldD.slice(0, Math.max(0, oldD.length - 60)).forEach(n => fs.unlinkSync(path.join(dir, n)));          // keep 60 days
    old.slice(0, Math.max(0, old.length - 60)).forEach(n => fs.unlinkSync(path.join(dir, n)));
  } catch (e) { console.error('backup failed', e.message); }
}
backup(); setInterval(backup, 3600e3);
const stop = () => { clearTimeout(saveT); try { writeNow(); } catch (e) {} process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);

// ---------- Inkbird ITC-308 WiFi via the Tuya cloud (optional) ----------
// Set TUYA_ID, TUYA_SECRET, TUYA_DEVICE (and TUYA_REGION: us, eu, cn, in, weu, ueaz) to turn on.
// Every minute the current temperature is saved into a per-day record ("probe/YYYY-MM-DD"),
// which every device receives through the normal sync. Runs pick up readings that fall inside their times.
const TUYA_HOSTS = { us: 'openapi.tuyaus.com', ueaz: 'openapi-ueaz.tuyaus.com', eu: 'openapi.tuyaeu.com', weu: 'openapi-weaz.tuyaeu.com', cn: 'openapi.tuyacn.com', in: 'openapi.tuyain.com' };
const TUYA = { id: process.env.TUYA_ID || '', secret: process.env.TUYA_SECRET || '', device: process.env.TUYA_DEVICE || '',
  host: TUYA_HOSTS[(process.env.TUYA_REGION || 'us').toLowerCase()] || process.env.TUYA_REGION, token: '', exp: 0,
  code: process.env.TUYA_TEMP_CODE || '', unitCode: '', scale: process.env.TUYA_SCALE != null && process.env.TUYA_SCALE !== '' ? +process.env.TUYA_SCALE : null,
  forceUnit: (process.env.TUYA_UNIT || '').toUpperCase(), every: Math.max(30, +process.env.TUYA_EVERY || 60), last: null, err: '', status: null, spec: null };
function tuyaCall(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const t = Date.now().toString(), bodyStr = body ? JSON.stringify(body) : '';
    const hash = crypto.createHash('sha256').update(bodyStr).digest('hex');
    const isToken = urlPath.startsWith('/v1.0/token');
    const toSign = TUYA.id + (isToken ? '' : TUYA.token) + t + [method, hash, '', urlPath].join('\n');
    const sign = crypto.createHmac('sha256', TUYA.secret).update(toSign).digest('hex').toUpperCase();
    const headers = { client_id: TUYA.id, sign, t, sign_method: 'HMAC-SHA256', 'Content-Type': 'application/json' };
    if (!isToken) headers.access_token = TUYA.token;
    const req = https.request({ host: TUYA.host, path: urlPath, method, headers, timeout: 15000 }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { const j = JSON.parse(d); j.success ? resolve(j.result) : reject(new Error(`${j.code || ''} ${j.msg || 'Tuya error'}`.trim())); } catch (e) { reject(new Error('Bad reply from Tuya')); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Tuya timed out')));
    if (bodyStr) req.write(bodyStr); req.end();
  });
}
async function tuyaToken() {
  if (TUYA.token && Date.now() < TUYA.exp - 60e3) return;
  TUYA.token = ''; const r = await tuyaCall('GET', '/v1.0/token?grant_type=1');
  TUYA.token = r.access_token; TUYA.exp = Date.now() + (r.expire_time || 7200) * 1000;
}
async function tuyaRead() {
  await tuyaToken();
  if (!TUYA.spec) { try { TUYA.spec = await tuyaCall('GET', `/v1.0/iot-03/devices/${TUYA.device}/specification`); } catch (e) { TUYA.spec = { status: [] }; } }
  const status = await tuyaCall('GET', `/v1.0/iot-03/devices/${TUYA.device}/status`); TUYA.status = status;
  const codes = status.map(x => x.code), num = status.filter(x => typeof x.value === 'number');
  if (!TUYA.code) TUYA.code = (codes.find(c => /^temp_current$/i.test(c)) || codes.find(c => /temp.*(current|now)|(current|now).*temp/i.test(c))
    || (num.find(x => /temp/i.test(x.code) && !/set|target|alarm|limit|diff|calib|delay|high|low/i.test(x.code)) || {}).code || '');
  if (!TUYA.unitCode) TUYA.unitCode = codes.find(c => /unit|temp_f|c_f|cf/i.test(c)) || '';
  const item = status.find(x => x.code === TUYA.code); if (!item) throw new Error('No current-temperature value found — set TUYA_TEMP_CODE (see /api/probe/test)');
  const sp = (TUYA.spec.status || []).find(x => x.code === TUYA.code); let vals = {}; try { vals = JSON.parse(sp && sp.values || '{}'); } catch (e) {}
  const scale = TUYA.scale != null ? TUYA.scale : (vals.scale != null ? +vals.scale : 0);
  let unit = TUYA.forceUnit;
  if (!unit) { const u = status.find(x => x.code === TUYA.unitCode); unit = u ? (/f/i.test(String(u.value)) ? 'F' : 'C') : (/℉|f/i.test(vals.unit || '') ? 'F' : 'C'); }
  const raw = item.value / Math.pow(10, scale), c = unit === 'F' ? (raw - 32) * 5 / 9 : raw;
  return { t: Date.now(), c: Math.round(c * 10) / 10, raw: item.value, scale, unit, code: TUYA.code };
}
async function tuyaPoll() {
  try {
    const r = await tuyaRead(); TUYA.last = r; TUYA.err = '';
    const day = new Date(r.t).toISOString().slice(0, 10), key = 'probe/' + day, cur = st.records[key] && st.records[key].val || [];
    st.version++; st.records[key] = { ver: st.version, val: cur.concat([[r.t, r.c]]) };
    const cutoff = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);              // keep 60 days
    for (const k of Object.keys(st.records)) if (k.startsWith('probe/') && k.slice(6) < cutoff && st.records[k].val !== null) { st.version++; st.records[k] = { ver: st.version, val: null }; }
    persist();
  } catch (e) { TUYA.err = e.message; if (/token|sign|1010|1004/i.test(e.message)) TUYA.token = ''; console.error('Tuya:', e.message); }
}
if (TUYA.id && TUYA.secret && TUYA.device) { setTimeout(tuyaPoll, 3000); setInterval(tuyaPoll, TUYA.every * 1000); console.log(`Tuya polling ${TUYA.device} every ${TUYA.every}s via ${TUYA.host}`); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const send = (res, code, body, type) => { res.writeHead(code, { 'content-type': type || 'application/json', 'cache-control': 'no-store' }); res.end(body); };

// ---------- SOPs & recipes: kept on the server only (never sent through the normal sync) ----------
// Admins see everything. Others only see documents an admin has shared with them, until the share expires.
const DOCS_FILE = path.join(DATA, 'fungatory-docs.json');
let docs = { docs: [], shares: [] };
try { docs = JSON.parse(fs.readFileSync(DOCS_FILE, 'utf8')); } catch (e) {}
function saveDocs() { const tmp = DOCS_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(docs)); fs.renameSync(tmp, DOCS_FILE); }
const sessions = new Map(), fails = new Map();
const people = () => ((st.records['_/settings'] || {}).val || {}).people || [];
const sha = (salt, pw) => crypto.createHash('sha256').update(salt + ':' + pw).digest('hex');
function readBody(req) { return new Promise((ok, bad) => { let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { bad(e); } }); }); }
function who(req) { const t = req.headers['x-doc-token'], s = t && sessions.get(t); if (!s || s.exp < Date.now()) return null;
  const p = people().find(x => x.id === s.pid && !x.removed); if (!p) return null; s.exp = Date.now() + 30 * 6e4; return p; }
// Scalable recipes: admins store amounts for a base quantity; staff only ever receive the final totals.
function fmtAmt(v, unit) {
  let u = String(unit || '').trim(), x = v;
  if (/^kg$/i.test(u)) { x *= 1000; u = 'g'; }
  if (/^g$/i.test(u) && x >= 1000) { x /= 453.592; u = 'lb'; } else if (/^ml$/i.test(u) && x >= 1000) { x /= 1000; u = 'L'; }
  if (/^(each|jars?|bags?|pcs?|pieces?|x|)$/i.test(u)) x = Math.ceil(x - 1e-9);
  const n = x >= 100 ? Math.round(x) : x >= 10 ? Math.round(x * 10) / 10 : Math.round(x * 100) / 100;
  return (n.toLocaleString('en-US') + (/^(each|x|pcs?|pieces?)$/i.test(u) ? '' : ' ' + u)).trim();
}
function scaleDoc(d, qty, size) {
  const c = d.calc || {}, sized = !!c.sizeOn && size > 0, total = sized ? qty * size : 0;
  const f = (sized ? total : qty) / (+c.base || 1), unit = c.unit || 'batch', plural = qty === 1 || /s$/i.test(unit) ? unit : unit + 's';
  const items = (c.items || []).filter(i => i.name).map(i => ({ name: i.name, text: fmtAmt((+i.amount || 0) * f, i.unit) }));
  const body = String(d.body || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, k) => {
    if (/^(qty|quantity|count)$/i.test(k)) return String(qty); if (/^unit$/i.test(k)) return plural;
    if (/^size$/i.test(k) && sized) return fmtAmt(size, c.sizeUnit); if (/^total$/i.test(k) && sized) return fmtAmt(total, c.sizeUnit);
    const it = items.find(i => i.name.toLowerCase() === k.toLowerCase()); if (it) return it.text;
    const per = k.match(/^(.+?)\s+(each|per\s+\S+)$/i), raw = per && (c.items || []).find(i => i.name && i.name.toLowerCase() === per[1].toLowerCase());
    return raw ? fmtAmt((+raw.amount || 0) * f / qty, raw.unit) : m; });
  return { qty, unit: plural, items, body, size: sized ? fmtAmt(size, c.sizeUnit) : undefined, total: sized ? fmtAmt(total, c.sizeUnit) : undefined };
}
const activeShares = () => docs.shares.filter(x => x.until > Date.now());
const visibleTo = p => p.admin ? docs.docs : docs.docs.filter(d => activeShares().some(x => x.pid === p.id && (x.docId === d.id || x.docId === '*')));
async function docsApi(req, res, u) {
  try {
    if (u.pathname === '/api/docs/auth' && req.method === 'POST') {
      const { pid, password } = await readBody(req), p = people().find(x => x.id === pid && !x.removed);
      const f = fails.get(pid) || { n: 0, t: 0 }; if (f.n >= 5 && Date.now() - f.t < 5 * 6e4) return send(res, 429, '{"error":"Too many tries — wait 5 minutes"}');
      if (!p || !p.hash || sha(p.salt || '', password || '') !== p.hash) { fails.set(pid, { n: f.n + 1, t: Date.now() }); return send(res, 401, '{"error":"Wrong password"}'); }
      fails.delete(pid); const token = crypto.randomBytes(24).toString('hex'); sessions.set(token, { pid: p.id, exp: Date.now() + 30 * 6e4 });
      return send(res, 200, JSON.stringify({ token, admin: !!p.admin }));
    }
    const p = who(req); if (!p) return send(res, 401, '{"error":"locked"}');
    if (u.pathname === '/api/docs' && req.method === 'GET') {
      const list = visibleTo(p).map(d => Object.assign({}, d, { versions: p.admin ? d.versions : undefined,
        calc: d.calc && d.calc.on ? (p.admin ? d.calc : { on: true, unit: d.calc.unit, sizeOn: !!d.calc.sizeOn, sizeUnit: d.calc.sizeUnit, items: (d.calc.items || []).map(i => ({ name: i.name })) }) : undefined,
        sharedUntil: p.admin ? undefined : Math.max(...activeShares().filter(x => x.pid === p.id && (x.docId === d.id || x.docId === '*')).map(x => x.until)) }));
      return send(res, 200, JSON.stringify({ admin: !!p.admin, docs: list, shares: p.admin ? activeShares() : [] }));
    }
    if (u.pathname === '/api/docs/scale' && req.method === 'POST') {
      const b = await readBody(req), d = visibleTo(p).find(x => x.id === b.id), q = Math.round(+b.qty * 100) / 100, sz = +b.size || 0;
      if (!d || !d.calc || !d.calc.on) return send(res, 404, '{"error":"Not found"}');
      if (!(q > 0 && q <= 100000)) return send(res, 400, '{"error":"Enter a number above 0"}');
      if (d.calc.sizeOn && !(sz > 0 && sz <= 1e6)) return send(res, 400, '{"error":"Enter how much goes in each one"}');
      return send(res, 200, JSON.stringify(scaleDoc(d, q, sz)));
    }
    if (!p.admin) return send(res, 403, '{"error":"Admins only"}');
    const b = await readBody(req);
    if (u.pathname === '/api/docs/save') {
      const now = Date.now(); let d = docs.docs.find(x => x.id === b.id);
      if (!d) { d = { id: crypto.randomBytes(8).toString('hex'), created: now, versions: [] }; docs.docs.push(d); }
      else if (d.body !== b.body || d.title !== b.title) d.versions = (d.versions || []).concat([{ t: d.updated, by: d.by, title: d.title, body: d.body }]).slice(-20);
      const calc = b.calc && b.calc.on ? { on: true, unit: String(b.calc.unit || 'batch').slice(0, 40), base: Math.max(0.01, +b.calc.base || 1), sizeOn: !!b.calc.sizeOn, sizeUnit: String(b.calc.sizeUnit || 'ml').slice(0, 12),
        items: (b.calc.items || []).filter(i => i && i.name).slice(0, 60).map(i => ({ name: String(i.name).slice(0, 80), amount: +i.amount || 0, unit: String(i.unit || '').slice(0, 12) })) } : undefined;
      Object.assign(d, { type: b.type === 'Recipe' ? 'Recipe' : 'SOP', title: String(b.title || 'Untitled').slice(0, 200), body: String(b.body || ''), calc, updated: now, by: p.name });
      saveDocs(); return send(res, 200, JSON.stringify(d));
    }
    if (u.pathname === '/api/docs/delete') { docs.docs = docs.docs.filter(x => x.id !== b.id); docs.shares = docs.shares.filter(x => x.docId !== b.id); saveDocs(); return send(res, 200, '{}'); }
    if (u.pathname === '/api/docs/share') {
      const until = +b.until; if (!(until > Date.now())) return send(res, 400, '{"error":"Pick a time in the future"}');
      (b.pids || []).forEach(pid => (b.docIds || []).forEach(docId => docs.shares.push({ id: crypto.randomBytes(6).toString('hex'), pid, docId, until, by: p.name, t: Date.now() })));
      docs.shares = docs.shares.filter(x => x.until > Date.now() - 7 * 864e5); saveDocs(); return send(res, 200, '{}');
    }
    if (u.pathname === '/api/docs/unshare') { docs.shares = docs.shares.filter(x => x.id !== b.id); saveDocs(); return send(res, 200, '{}'); }
    send(res, 404, '{"error":"unknown"}');
  } catch (e) { send(res, 400, '{"error":"bad request"}'); }
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/docs')) {
    if (KEY && req.headers['x-farm-key'] !== KEY) return send(res, 401, '{"error":"farm key required"}');
    return docsApi(req, res, u);
  }
  if (u.pathname === '/api/probe/status' || u.pathname === '/api/probe/test') {
    if (KEY && req.headers['x-farm-key'] !== KEY && u.searchParams.get('key') !== KEY) return send(res, 401, '{"error":"farm key required"}');
    if (u.pathname === '/api/probe/status') return send(res, 200, JSON.stringify({ configured: !!(TUYA.id && TUYA.secret && TUYA.device), last: TUYA.last, error: TUYA.err, every: TUYA.every }));
    if (!(TUYA.id && TUYA.secret && TUYA.device)) return send(res, 200, JSON.stringify({ configured: false, help: 'Set TUYA_ID, TUYA_SECRET, TUYA_DEVICE and TUYA_REGION' }, null, 1));
    tuyaRead().then(r => send(res, 200, JSON.stringify({ reading: r, status: TUYA.status, specification: TUYA.spec }, null, 1)))
      .catch(e => send(res, 200, JSON.stringify({ error: e.message, status: TUYA.status }, null, 1)));
    return;
  }
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
  if (rel.startsWith('..') || rel.split(path.sep).some(s => s.startsWith('.')) || rel === 'server.js' || rel.startsWith('data') || rel.includes('fungatory-docs'))
    return send(res, 404, 'Not found', 'text/plain');
  fs.readFile(f, (e, d) => {
    if (e) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(d);
  });
}).listen(PORT, () => console.log(`Fungatory on :${PORT}, data in ${DATA}${KEY ? ', farm key on' : ', NO farm key set'}`));