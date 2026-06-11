require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const ordersDb = require('./orders-db');
const https = require('https');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const tts = require('google-tts-api');

const RENDER_URL = 'https://whatsapp-bridge-8lq2.onrender.com';
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Keep Render awake + save history every 5 minutes
function startKeepAlive() {
  setInterval(() => {
    https.get(RENDER_URL + '/status', res => { res.resume(); }).on('error', () => {});
    saveHistory();
  }, 600000);
}
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const BRIDGE_PORT = process.env.PORT || process.env.BRIDGE_PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
const ADMIN_JID = process.env.ADMIN_JID || '966595510125@s.whatsapp.net';
let latestQr = null;

function loadCreds() {
  const v = process.env.CREDS_JSON;
  if (!v) return;
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(path.join(AUTH_DIR, 'creds.json'), Buffer.from(v, 'base64'));
  console.log('Loaded creds from env');
}

function saveCredsToEnv() {
  const key = process.env.RENDER_API_KEY;
  const sid = process.env.RENDER_SERVICE_ID;
  if (!key || !sid) return;
  const p = path.join(AUTH_DIR, 'creds.json');
  if (!fs.existsSync(p)) return;
  const b64 = fs.readFileSync(p).toString('base64');
  const body = JSON.stringify({ envVars: [{ key: 'CREDS_JSON', value: b64 }] });
  const opts = {
    hostname: 'api.render.com', path: '/v1/services/' + sid + '/env-vars',
    method: 'PUT', timeout: 10000,
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }
  };
  const req = https.request(opts, res => { res.resume(); });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

loadCreds();

function loadFamilyContacts() {
  try { return JSON.parse(fs.readFileSync('./family-contacts.json')); }
  catch(e) { return []; }
}
function saveFamilyContacts(data) {
  fs.writeFileSync('./family-contacts.json', JSON.stringify(data, null, 2));
}

const SYSTEM_PROMPT = 'أنت ماهر البدري، صاحب شركة معدات حريق.\n\n' +
'العنوان: شارع الحج، مكة المكرمة، الصنايعية الجديدة، بجوار مركز تقدير للسيارات\n\n' +
'** مهم جدا: استخدم قائمة المنتجات التالية عند الرد **\n\n' +
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
'- عندك معرفة عامة في كل المجالات\n' +
'- رد بنفس لهجة اللي كلمك (يمني، مصري، سعودي، شامي، عراقي، خليجي)\n' +
'- العربية الفصحى ممنوع. رد بالعامية فقط\n' +
'- إذا سأل عن منتج: قول اسمه وسعره من القائمة\n' +
'- إذا سأل عن الإيجار: قول سعر اليوم\n' +
'- تصليح أو قطع غيار: "موجود كل حاجة إن شاء الله، جيبها الورشة"\n' +
'- إذا طلب طلب: اسأله عن اسمه فقط وشو يبي بالضبط\n' +
'- لما ترد على العائلة: كلمهم كأهلك. لا تعرف بنفسك. استخدم أسلوبهم.\n' +
'- ردودك قصيرة قد السؤال. لا تقول اسمك ولا عنوانك إلا إذا سألوك.\n' +
'- عربي فقط. ممنوع أي إنجليزي.\n' +
'- إذا كان المتصل من العائلة أو الأقارب: رد بطريقة مناسبة حسب صلة القرابة\n' +
'  * الزوجة: رد رومانسي وحنون\n' +
'  * الأخت: اسأل عن أحوالها وأولادها واطمئنان\n' +
'  * الأخ: أسئلة شخصية واطمئنان وسلام\n' +
'  * أولاد الإخوة: رد حنون مناسب\n' +
  '  * الأم/الأب: رد مليء بالاحترام والبر\n' +
  '  * بشكل عام: ليسوا عملاء، رد بطريقة أسرية\n\n' +
  '** قائمة العائلة **\n' +
  '- الزوجة: ام سعاد - ناديها "يا مزتي" أو "يا حياتي"\n' +
  '- الابنة الكبرى: سعاد (سوسه) - ناديها "سوسه" أو "يا بعدي"\n' +
  '- الابنة الوسطى: ايه (ايويه) - ناديها "ايويه" أو "يا قمر"\n' +
  '- الابن الصغير: نورا - ناديها "نورا"\n' +
  '- الابن: حوده - ناديه "حوده"\n' +
  '- الأخت الكبرى: ام السعيد - ناديها "يا أختي"\n' +
  '- الأخت الوسطى: ام ياسمين - ناديها "يا أختي"\n' +
  '- الأخت الصغرى: ام ملك - ناديها "يا أختي"\n' +
  '- بنت الأخت: بطه - ناديها "بطه" أو "يا بنتي"\n' +
  '- بنت الأخت: بوبس - ناديها "بوبس" أو "يا بنتي"\n' +
  '- بنت الأخت: هيومه - ناديها "هيومه" أو "يا بنتي"\n' +
  '- الأخ: ابو عماد - ناديه "يا أخوي" أو "بو عماد"\n\n' +
'** انضمام الجروب **\n' +
'إذا طلب أحد الانضمام لجروب الواتساب الخاص بالمؤسسة:\n' +
'1. اسأله أولاً: "هل أنت سباك؟"\n' +
'2. إذا قال نعم أو أي تأكيد: أعطه رابط الجروب: https://chat.whatsapp.com/DL3qCnpSs6fHU5VYZgDgNL\n' +
'3. وحذره: لا تنشر أي صور لمواد السباكة أو الحريق (حديد أو بلاستيك) لأن هذا جروب خاص بالمؤسسة فقط';

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

// Persistent conversation memory: saved to file, survives restarts
const HISTORY_FILE = './conversation-history.json';
const MAX_HISTORY = 30;
let conversationHistory = loadHistory();
let familyContacts = loadFamilyContacts();

function transcribeAudio(audioBuffer) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', 'ar');
    const opts = {
      hostname: 'api.groq.com', path: '/openai/v1/audio/transcriptions',
      method: 'POST', timeout: 30000,
      headers: form.getHeaders({ 'Authorization': 'Bearer ' + GROQ_API_KEY })
    };
    const req = https.request(opts, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try { const j = JSON.parse(b); resolve(j.text || ''); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    form.pipe(req);
  });
}

function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE));
    return new Map(Object.entries(data));
  } catch (e) {
    // Try loading from env var as fallback
    try {
      const envData = process.env.HISTORY_JSON;
      if (envData) return new Map(Object.entries(JSON.parse(Buffer.from(envData, 'base64').toString())));
    } catch (e2) {}
    return new Map();
  }
}
function saveHistory() {
  const obj = {};
  for (const [key, val] of conversationHistory) {
    obj[key] = val;
  }
  const str = JSON.stringify(obj);
  fs.writeFileSync(HISTORY_FILE, str);
  // Also save to Render env var for persistence
  try {
    if (process.env.RENDER_API_KEY && process.env.RENDER_SERVICE_ID) {
      const b64 = Buffer.from(str).toString('base64');
      const body = JSON.stringify({ envVars: [{ key: 'HISTORY_JSON', value: b64 }] });
      const opts = {
        hostname: 'api.render.com', path: '/v1/services/' + process.env.RENDER_SERVICE_ID + '/env-vars',
        method: 'PUT', timeout: 10000,
        headers: { 'Authorization': 'Bearer ' + process.env.RENDER_API_KEY, 'Content-Type': 'application/json' }
      };
      const req = https.request(opts, res => { res.resume(); });
      req.on('error', () => {});
      req.write(body);
      req.end();
    }
  } catch (e) {}
}

async function startBridge() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Chrome', 'Chrome', '120.0'],
  });

  sock.ev.on('creds.update', () => { saveCreds(); saveCredsToEnv(); });

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

      let text = msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        '';

      const from = msg.key.remoteJid;
      let sender = msg.pushName || 'Unknown';

      // Handle voice messages
      const audioMsg = msg.message?.audioMessage;
      let isVoice = false;
      if (audioMsg && !text) {
        isVoice = true;
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          text = await transcribeAudio(buffer);
          console.log('Voice from ' + sender + ': ' + text);
        } catch (e) {
          console.error('Voice error: ' + e.message);
          continue;
        }
      }

      if (!text) continue;

      // Get or create conversation history for this user
      if (!conversationHistory.has(from)) {
        conversationHistory.set(from, []);
      }
      const history = conversationHistory.get(from);
      history.push({ role: 'user', content: text });
      if (history.length > MAX_HISTORY) history.shift();
      saveHistory();

      // Check if sender is family
      const family = familyContacts.find(f => f.phone && from.includes(f.phone));
      let familyContext = '';
      if (family) {
        familyContext = ' [هذا من العائلة: ' + family.relationship + ' (' + family.name + '). رد طبيعي بدون تعريف بنفسك، ' + family.style + ']';
      }

      try {
        // Prepare messages for Groq: system + history + current message
        const groqMessages = [
          { role: 'system', content: SYSTEM_PROMPT },
          ...history.slice(-10), // last 10 messages for context
          { role: 'user', content: text + familyContext }
        ];

        // Call Groq directly for the reply
        const replyText = await callGroq(groqMessages);

        if (replyText) {
          await sock.sendMessage(from, { text: replyText });
          history.push({ role: 'assistant', content: replyText });
          if (history.length > MAX_HISTORY) history.shift();
          saveHistory();
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

  app.get('/family', (req, res) => {
    res.json(familyContacts);
  });

  app.post('/family', (req, res) => {
    const { phone, name, relationship, style } = req.body;
    if (!phone || !name || !relationship) return res.status(400).json({ error: 'Missing fields: phone, name, relationship' });
    const contact = { phone, name, relationship, style: style || 'custom' };
    familyContacts = familyContacts.filter(f => f.phone !== phone);
    familyContacts.push(contact);
    saveFamilyContacts(familyContacts);
    res.json(contact);
  });

  app.delete('/family/:phone', (req, res) => {
    const phone = req.params.phone;
    familyContacts = familyContacts.filter(f => f.phone !== phone);
    saveFamilyContacts(familyContacts);
    res.json({ success: true });
  });

  app.get('/', (req, res) => {
    const connected = sock.user ? true : false;
    res.send(`<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>ماher Al-Badri - Fire Safety</title><style>body{font-family:sans-serif;text-align:center;padding:40px;background:#1a1a2e;color:#eee}h1{color:#e94560}.status{padding:20px;border-radius:10px;margin:20px}.connected{background:#0f3460}.disconnected{background:#16213e}img{margin:20px;border:4px solid #e94560;border-radius:10px}code{background:#333;padding:4px 8px;border-radius:4px}</style></head><body><h1>🔧 ماهر البدري - معدات حريق</h1><div class="status ${connected ? 'connected' : 'disconnected'}"><h2>${connected ? '✅ متصل بالواتساب' : '❌ غير متصل'}</h2><p>${connected ? 'رقم: ' + sock.user?.id : 'امسح QR أدناه للاتصال'}</p></div>${!connected && latestQr ? `<div><p>افتح واتساب جوالك ← الأجهزة المرتبطة ← امسح QR:</p><img src="/qr" alt="QR Code"></div>` : ''}<p style="margin-top:40px;color:#888">API: <code>/status</code> <code>/send</code> <code>/order</code> <code>/orders</code></p></body></html>`);
  });

  app.listen(BRIDGE_PORT, () => {
    console.log('Bridge API on http://localhost:' + BRIDGE_PORT);
  });
}

startKeepAlive();
startBridge().catch(console.error);