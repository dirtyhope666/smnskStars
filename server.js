// smnskStars — серверный посредник. Ключ API живёт только здесь, в переменной окружения.
// Запуск: OWNER_KEY=own_xxx node server.js   (нужен Node.js 18+, пакеты не требуются)
const http = require('http'), fs = require('fs'), path = require('path');

const KEY = process.env.OWNER_KEY;
const BASE = (process.env.OWNER_BASE || 'https://umarkets.life/api/v1/owner').replace(/\/$/, '');
const PORT = process.env.PORT || 3000;
if (!KEY) { console.error('Задайте переменную окружения OWNER_KEY'); process.exit(1); }

const hits = new Map();
const limited = ip => {
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60000);
  a.push(now); hits.set(ip, a); return a.length > 40;
};

async function upstream(p, method, body) {
  try {
    const r = await fetch(BASE + p, {
      method,
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let d; try { d = await r.json(); } catch { d = {}; }
    if (r.status === 401 || r.status === 403 || r.status === 501) {
      console.error('Ошибка ключа/бота', r.status, d);
      return [502, { detail: 'Сервис временно недоступен' }];
    }
    return [r.status, d];
  } catch (e) {
    console.error(e); return [502, { detail: 'Сервис временно недоступен' }];
  }
}

const readBody = req => new Promise(res => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 2048) req.destroy(); });
  req.on('end', () => { try { res(JSON.parse(s || '{}')); } catch { res({}); } });
});
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const USER = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'smnskstars.html')).pipe(res);
  }
  if (!url.pathname.startsWith('/api/')) return send(res, 404, { detail: 'Не найдено' });
  if (limited(ip)) return send(res, 429, { detail: 'Слишком много запросов. Подождите минуту.' });

  if (req.method === 'GET' && url.pathname === '/api/methods') {
    const [c, d] = await upstream('/methods', 'GET');
    return send(res, c, c === 200 ? { methods: (d.methods || []).map(m => ({ key: m.key })) } : d);
  }

  if (req.method === 'POST' && url.pathname === '/api/check') {
    const { username } = await readBody(req);
    if (!USER.test(String(username || ''))) return send(res, 400, { detail: 'Некорректный username' });
    const [c, d] = await upstream('/check-recipient', 'POST', { username });
    return send(res, c, c === 200 ? { exists: !!d.exists } : d);
  }

  if (req.method === 'POST' && url.pathname === '/api/order') {
    const { recipient, quantity, method_key } = await readBody(req);
    const q = Number(quantity);
    if (!USER.test(String(recipient || ''))) return send(res, 400, { detail: 'Некорректный username' });
    if (!Number.isInteger(q) || q < 50 || q > 10000) return send(res, 400, { detail: 'Количество — от 50 до 10 000' });
    if (!/^[a-z0-9_]{3,40}$/.test(String(method_key || ''))) return send(res, 400, { detail: 'Некорректный метод оплаты' });
    const [c, d] = await upstream('/order', 'POST', { recipient, quantity: q, method_key });
    return send(res, c, c === 200
      ? { order_id: d.order_id, status: d.status, payment_url: d.payment_url, amount_rub: d.amount_rub, review_after_payment: !!d.review_after_payment }
      : d);
  }

  const m = url.pathname.match(/^\/api\/order\/([A-Za-z0-9_-]{6,64})$/);
  if (req.method === 'GET' && m) {
    const [c, d] = await upstream('/order/' + m[1], 'GET');
    return send(res, c, c === 200 ? { status: d.status, paid: !!d.paid } : d);
  }
  send(res, 404, { detail: 'Не найдено' });
}).listen(PORT, () => console.log('smnskStars: http://localhost:' + PORT));
