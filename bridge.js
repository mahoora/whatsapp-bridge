require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const ordersDb = require('./orders-db');
const https = require('https');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const BRIDGE_PORT = process.env.PORT || process.env.BRIDGE_PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
const ADMIN_JID = process.env.ADMIN_JID || '966595510125@s.whatsapp.net';
let latestQr = null;

const SYSTEM_PROMPT = 'أنت ماهر البدري، صاحب شركة معدات حريق. تتحدث بالعربية.\n\n' +
'** مهم جدا: استخدم قائمة المنتجات التالية عند الرد على أسئلة العملاء عن الأسعار أو الإيجار **\n\n' +
'قائمة المنتجات للإيجار مع الأسعار (ريال/اليوم):\n' +
'1. ماكينة سن 2 بوصة ← 100 ريال/اليوم\n' +
'2. ماكينة سن 3 بوصة ← 120 ريال/اليوم\n' +
'3. مكنة جروف ← 80 ريال/اليوم\n' +
'4. خواشة مواسير ← 50 ريال/اليوم\n' +
'5. مكنة باركود HDP ← 200 ريال/اليوم\n' +
'6. مكنة ضغط مياه (كهرباء) ← 50 ريال/اليوم\n' +
'7. مكنة ضغط مياه (ديزل) ← 70 ريال/اليوم\n' +
'8. مكنة HDP راس في راس ← 200 ريال/اليوم\n' +
'9. مولد كهرباء 3 كيلو ← 100 ريال/اليوم\n' +
'10. مقص 8 بوصة لقص المواسير الحديد ← 100 ريال/اليوم\n\n' +
'** تعليمات الرد **\n' +
'- إذا سأل العميل عن منتج معين: اذكر اسم المنتج وسعره بالضبط من القائمة\n' +
'- إذا سأل عن الإيجار: اذكر السعر لليوم وقل السعر يتغير حسب المدة\n' +
'- الصيانة: تحتاج معاينة من فني\n' +
'- إذا طلب العميل طلب: اسأل عن المنتج والمدة واسمه ورقم هاتفه\n' +
'- ردودك مختصرة ومفيدة وبالعربية فقط';

function callGroq(messages) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ model: 'llama-3.3-70b-versatile', messages });
    const opts = {
      hostname: 'api.groq.com', path: '/openai/v1/chat/completions',
      method: 'POST', timeout: 30000,
      headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(opts, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try { const j = JSON.parse(b); resolve(j.choices?.[0]?.message?.content || ''); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Conversation memory: keep last 30 messages per user
const conversationHistory = new Map();
const MAX_HISTORY = 30;

async function startBridge() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Chrome', 'Chrome', '120.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr && qr !== latestQr) {
      latestQr = qr;
      console.log('\n========================================');
      console.log('  امسح QR code هذا بالواتساب');
      console.log('========================================');
      console.log('افتح الرابط في المتصفح:');
      console.log('/qr');
      console.log('========================================\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log('WhatsApp connected! ' + (sock.user?.id || ''));
    }
    if (connection === 'close') {
      console.log('WhatsApp disconnected. Reason: ' + (lastDisconnect?.error?.message || 'unknown'));
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBridge();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.key || msg.key.fromMe) continue;
      if (msg.key.remoteJid.endsWith('@g.us')) continue;

      const text = msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        '';

      if (!text) continue;

      const from = msg.key.remoteJid;
      const sender = msg.pushName || 'Unknown';
      console.log('From ' + sender + ': ' + text);

      // Get or create conversation history for this user
      if (!conversationHistory.has(from)) {
        conversationHistory.set(from, []);
      }
      const history = conversationHistory.get(from);
      history.push({ role: 'user', content: text });
      if (history.length > MAX_HISTORY) history.shift();

      try {
        // Prepare messages for Groq: system + history + current message
        const groqMessages = [
          { role: 'system', content: SYSTEM_PROMPT },
          ...history.slice(-10), // last 10 messages for context
          { role: 'user', content: text }
        ];

        // Call Groq directly for the reply
        const replyText = await callGroq(groqMessages);

        if (replyText) {
          await sock.sendMessage(from, { text: replyText });
          history.push({ role: 'assistant', content: replyText });
          if (history.length > MAX_HISTORY) history.shift();
          console.log('Replied: ' + replyText.substring(0, 50));
        }
      } catch (err) {
        console.error('Error: ' + err.message);
      }
    }
  });

  const app = express();
  app.use(express.json());

  app.post('/send', async (req, res) => {
    const { to, text } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'Missing fields' });
    try {
      await sock.sendMessage(to, { text });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/status', (req, res) => {
    res.json({ connected: sock.user ? true : false, user: sock.user?.id || null });
  });

  app.get('/qr', async (req, res) => {
    if (!latestQr) return res.status(404).send('No QR available yet. Wait for the bridge to start.');
    res.setHeader('Content-Type', 'image/png');
    res.send(await QRCode.toBuffer(latestQr, { type: 'png', width: 400 }));
  });

  app.post('/order', async (req, res) => {
    const { customerName, customerPhone, items, notes, totalPrice } = req.body;
    if (!customerName || !customerPhone || !items) {
      return res.status(400).json({ error: 'Missing required fields: customerName, customerPhone, items' });
    }
    try {
      const order = ordersDb.createOrder({ customerName, customerPhone, items, notes, totalPrice });
      // Notify admin
      const summary = `🛒 طلب جديد #${order.id}\nالعميل: ${customerName}\nالهاتف: ${customerPhone}\nالمنتجات: ${items.map(i => i.name).join('، ')}\nالإجمالي: ${totalPrice || 'يحتسب'} ريال\nالحالة: قيد المراجعة`;
      sock.sendMessage(ADMIN_JID, { text: summary }).catch(() => {});
      res.json(order);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/orders', (req, res) => {
    const { status } = req.query;
    res.json(ordersDb.listOrders(status));
  });

  app.get('/orders/:id', (req, res) => {
    const order = ordersDb.getOrder(Number(req.params.id));
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  });

  app.patch('/orders/:id/status', (req, res) => {
    const { status } = req.body;
    if (!['pending', 'confirmed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Use: pending, confirmed, cancelled' });
    }
    const order = ordersDb.setOrderStatus(Number(req.params.id), status);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  });

  app.get('/', (req, res) => {
    const connected = sock.user ? true : false;
    res.send(`<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>ماher Al-Badri - Fire Safety</title><style>body{font-family:sans-serif;text-align:center;padding:40px;background:#1a1a2e;color:#eee}h1{color:#e94560}.status{padding:20px;border-radius:10px;margin:20px}.connected{background:#0f3460}.disconnected{background:#16213e}img{margin:20px;border:4px solid #e94560;border-radius:10px}code{background:#333;padding:4px 8px;border-radius:4px}</style></head><body><h1>🔧 ماهر البدري - معدات حريق</h1><div class="status ${connected ? 'connected' : 'disconnected'}"><h2>${connected ? '✅ متصل بالواتساب' : '❌ غير متصل'}</h2><p>${connected ? 'رقم: ' + sock.user?.id : 'امسح QR أدناه للاتصال'}</p></div>${!connected && latestQr ? `<div><p>افتح واتساب جوالك ← الأجهزة المرتبطة ← امسح QR:</p><img src="/qr" alt="QR Code"></div>` : ''}<p style="margin-top:40px;color:#888">API: <code>/status</code> <code>/send</code> <code>/order</code> <code>/orders</code></p></body></html>`);
  });

  app.listen(BRIDGE_PORT, () => {
    console.log('Bridge API on http://localhost:' + BRIDGE_PORT);
  });
}

startBridge().catch(console.error);