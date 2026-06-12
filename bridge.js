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
const { exec } = require('child_process');

const RENDER_URL = 'https://whatsapp-bridge-8lq2.onrender.com';


// Keep Render awake + save history every 5 minutes
function startKeepAlive() {
  setInterval(() => {
    https.get(RENDER_URL + '/status', res => { res.resume(); }).on('error', () => {});
    saveHistory();
  }, 600000);
}
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

function renderUpdateEnv(keyName, value) {
  const apiKey = process.env.RENDER_API_KEY;
  const sid = process.env.RENDER_SERVICE_ID;
  if (!apiKey || !sid) return;
  const body = JSON.stringify({ value });
  const opts = {
    hostname: 'api.render.com', path: '/v1/services/' + sid + '/env-vars/' + keyName,
    method: 'PUT', timeout: 10000,
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' }
  };
  const req = https.request(opts, res => { res.resume(); });
  req.on('error', () => {});
  req.write(body);
  req.end();
}
function saveCredsToEnv() {
  const p = path.join(AUTH_DIR, 'creds.json');
  if (!fs.existsSync(p)) return;
  renderUpdateEnv('CREDS_JSON', fs.readFileSync(p).toString('base64'));
}

loadCreds();

function loadFamilyContacts() {
  try { return JSON.parse(fs.readFileSync('./family-contacts.json')); }
  catch(e) { return []; }
}
function saveFamilyContacts(data) {
  fs.writeFileSync('./family-contacts.json', JSON.stringify(data, null, 2));
}
function loadAiDisabledPhones() {
  try { return JSON.parse(fs.readFileSync('./ai-disabled.json')); }
  catch(e) { return []; }
}
function saveAiDisabledPhones(data) {
  fs.writeFileSync('./ai-disabled.json', JSON.stringify(data, null, 2));
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
'- للعائلة: رد بنفس لهجة اللي كلمك\n' +
'- العربية الفصحى ممنوع. رد بالعامية فقط\n' +
'- **العملاء (غير العائلة): رد باللهجة المصرية فقط**\n' +
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
  '** مهم: قائمة العائلة أدناه للرجوع لها فقط إذا ذُكر أن المتصل من العائلة. لا تفترض أن كل من يرسل هو من العائلة **\n' +
  '  * العملاء (غير العائلة): رد باللهجة المصرية فقط وتعامل معهم كعملاء\n' +
  '  * العائلة: رد بنفس لهجة المتصل\n' +
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

let aiQueue = Promise.resolve();
function callAI(systemPrompt, history, userMsg, retries = 2) {
  const doCall = () => new Promise((resolve, reject) => {
    let done = false;
    const safeResolve = (v) => { if (!done) { done = true; resolve(v); } };
    const safeReject = (e) => { if (!done) { done = true; reject(e); } };
    const messages = [{ role: 'system', content: systemPrompt }];
    for (const msg of history) {
      messages.push({ role: msg.role, content: msg.content });
    }
    messages.push({ role: 'user', content: userMsg });
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) { safeReject(new Error('No GROQ_API_KEY')); return; }
    const body = { model: 'llama-3.3-70b-versatile', messages, temperature: 0.7, max_tokens: 1024 };
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'api.groq.com', path: '/openai/v1/chat/completions',
      method: 'POST', timeout: 30000,
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(opts, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          if (res.statusCode === 429 && retries > 0) {
            const wait = (retries === 2 ? 30000 : 60000);
            console.error('AI 429, retrying in ' + wait + 'ms...');
            setTimeout(() => { safeResolve(callAI(systemPrompt, history, userMsg, retries - 1)); }, wait);
            return;
          }
          if (res.statusCode !== 200) {
            console.error('AI HTTP ' + res.statusCode + ': ' + b.substring(0, 200));
            safeReject(new Error('AI ' + res.statusCode));
            return;
          }
          safeResolve(j.choices?.[0]?.message?.content || '');
        } catch(e) { safeReject(e); }
      });
    });
    req.on('error', (e) => safeReject(e));
    req.on('timeout', () => { req.destroy(); safeReject(new Error('AI timeout')); });
    req.write(data);
    req.end();
  });
  const p = aiQueue.then(() => doCall());
  aiQueue = p.catch(() => {}).then(() => new Promise(r => setTimeout(r, 2000)));
  return p;
}

// Persistent conversation memory: saved to file, survives restarts
const HISTORY_FILE = './conversation-history.json';
const MAX_HISTORY = 30;
let conversationHistory = loadHistory();
let familyContacts = loadFamilyContacts();
let aiDisabledPhones = loadAiDisabledPhones();
let aiMode = 'ai';

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
  try { renderUpdateEnv('HISTORY_JSON', Buffer.from(str).toString('base64')); }
  catch (e) {}
}

const app = express();
app.use(express.json());
let currentSock = null;
let wsConnected = false;
let msgCount = 0;
let lastError = '';
let lastFrom = '';
let lastReply = '';
let restartTimer = null;
const lidToJid = new Map();

app.post('/send', async (req, res) => {
  const { to, text } = req.body;
  if (!to || !text) return res.status(400).json({ error: 'Missing fields' });
  try {
    await currentSock.sendMessage(to, { text });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/status', (req, res) => {
  res.json({ connected: wsConnected, user: currentSock?.user?.id || null });
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
    const summary = `🛒 طلب جديد #${order.id}\nالعميل: ${customerName}\nالهاتف: ${customerPhone}\nالمنتجات: ${items.map(i => i.name).join('، ')}\nالإجمالي: ${totalPrice || 'يحتسب'} ريال\nالحالة: قيد المراجعة`;
    currentSock.sendMessage(ADMIN_JID, { text: summary }).catch(() => {});
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/get-creds', (req, res) => {
  try {
    const p = path.join(AUTH_DIR, 'creds.json');
    if (!fs.existsSync(p)) return res.json({ creds: null });
    res.json({ creds: fs.readFileSync(p).toString('base64') });
  } catch(e) { res.status(500).json({ error: e.message }); }
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

app.get('/ai-disabled', (req, res) => {
  res.json(aiDisabledPhones);
});

app.post('/ai-disabled', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Missing phone' });
  if (!aiDisabledPhones.includes(phone)) {
    aiDisabledPhones.push(phone);
    saveAiDisabledPhones(aiDisabledPhones);
  }
  res.json(aiDisabledPhones);
});

app.delete('/ai-disabled/:phone', (req, res) => {
  const phone = req.params.phone;
  aiDisabledPhones = aiDisabledPhones.filter(p => p !== phone);
  saveAiDisabledPhones(aiDisabledPhones);
  res.json(aiDisabledPhones);
});

app.get('/history', (req, res) => {
  const obj = {};
  for (const [key, val] of conversationHistory) {
    obj[key] = val.slice(-10);
  }
  res.json(obj);
});
app.get('/diag', (req, res) => {
  res.json({ msgCount, lastError, lastFrom, lastReply, wsConnected, aiMode, aiDisabledCount: aiDisabledPhones.length, user: currentSock?.user?.id, sockExists: !!currentSock, sendTestMsg: lastSendTestMsg });
});
let lastSendTestMsg = '';
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>ماher Al-Badri - Fire Safety</title><style>body{font-family:sans-serif;text-align:center;padding:40px;background:#1a1a2e;color:#eee}h1{color:#e94560}.status{padding:20px;border-radius:10px;margin:20px}.connected{background:#0f3460}.disconnected{background:#16213e}img{margin:20px;border:4px solid #e94560;border-radius:10px}code{background:#333;padding:4px 8px;border-radius:4px}</style></head><body><h1>🔧 ماهر البدري - معدات حريق</h1><div class="status ${wsConnected ? 'connected' : 'disconnected'}"><h2>${wsConnected ? '✅ متصل بالواتساب' : '❌ غير متصل'}</h2><p>${wsConnected ? 'رقم: ' + currentSock?.user?.id : 'امسح QR أدناه للاتصال'}</p></div>${!wsConnected && latestQr ? `<div><p>افتح واتساب جوالك ← الأجهزة المرتبطة ← امسح QR:</p><img src="/qr" alt="QR Code"></div>` : ''}<p style="margin-top:40px;color:#888">API: <code>/status</code> <code>/send</code> <code>/order</code> <code>/orders</code></p></body></html>`);
});

async function startBridge() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Chrome', 'Chrome', '120.0'],
  });
  currentSock = sock;

  sock.ev.on('creds.update', () => { saveCreds(); saveCredsToEnv(); });

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      latestQr = qr;
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      wsConnected = true;
      console.log('WhatsApp connected! ' + (sock.user?.id || ''));
    }
    if (connection === 'close') {
      wsConnected = false;
      console.log('Disconnected. Reason: ' + (lastDisconnect?.error?.message || 'unknown'));
      if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut && !restartTimer) {
        restartTimer = setTimeout(() => { restartTimer = null; startBridge(); }, 10000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
        try { for (const msg of messages) {
      if (!msg.key || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;

      let text = msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        '';

      const from = jid;
      let sendTo = from;
      let sender = msg.pushName || 'Unknown';

      const senderPhone = from.split('@')[0].replace(/[^0-9]/g, '');
      if (aiDisabledPhones.some(p => senderPhone.includes(p) || from.includes(p))) {
        console.log('Skipping disabled phone: ' + senderPhone);
        continue;
      }

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

      msgCount++;
      lastFrom = from;

      if (!conversationHistory.has(from)) {
        conversationHistory.set(from, []);
      }
      const history = conversationHistory.get(from);
      history.push({ role: 'user', content: text });
      if (history.length > MAX_HISTORY) history.shift();
      try { saveHistory(); } catch(e) {}

      const tlow = text.trim();
      if (tlow === 'يدوي' || tlow === 'يدي') {
        aiMode = 'manual';
        await sock.sendMessage(sendTo, { text: '✅ تم التحويل إلى الرد اليدوي. أنت هترد بنفسك.' });
        lastReply = 'MODE: manual';
        continue;
      }
      if (tlow === 'تلقائي' || tlow === 'زكاء') {
        aiMode = 'ai';
        await sock.sendMessage(sendTo, { text: '✅ تم التشغيل. الزكاء هيرد على الرسايل.' });
        lastReply = 'MODE: ai';
        continue;
      }
      if (tlow === 'قائمة' || tlow === 'اعدادات' || tlow === 'menu') {
        const st = aiMode === 'ai' ? 'تلقائي (الزكاء)' : 'يدوي';
        try {
          await sock.sendMessage(sendTo, {
            text: 'الوضع الحالي: ' + st,
            footer: 'ماهر البدري',
            title: '⚙️ الإعدادات',
            buttonText: 'اختر',
            sections: [{
              title: 'وضع الرد',
              rows: [
                { title: '🖐 رد يدوي', description: 'أنا أرد بنفسي', rowId: 'manual' },
                { title: '🤖 رد الزكاء', description: 'الذكاء يرد تلقائي', rowId: 'ai' },
                { title: '🚫 إلغاء شخص', description: 'أكتب الرقم اللي مايردش عليه', rowId: 'disable' }
              ]
            }]
          });
        } catch(e) {
          await sock.sendMessage(sendTo, { text: 'الوضع: ' + st + '\nأرسل:\n"يدوي" → رد يدوي\n"تلقائي" → رد الزكاء' });
        }
        lastReply = 'MENU';
        continue;
      }
      if (tlow.startsWith('الغاء ') || tlow.startsWith('إلغاء ') || tlow.startsWith('منع ')) {
        const num = tlow.split(' ')[1];
        if (num && num.length >= 9) {
          if (!aiDisabledPhones.includes(num)) {
            aiDisabledPhones.push(num);
            saveAiDisabledPhones(aiDisabledPhones);
          }
          await sock.sendMessage(sendTo, { text: '✅ تم إيقاف الزكاء عن الرقم ' + num + '. أنت هترد عليه.' });
        } else {
          await sock.sendMessage(sendTo, { text: 'أكتب الرقم كامل، مثال:\nالغاء 201093122475' });
        }
        lastReply = 'DISABLE: ' + num;
        continue;
      }
      if (tlow.startsWith('تفعيل ') || tlow.startsWith('تشغيل ')) {
        const num = tlow.split(' ')[1];
        if (num) {
          aiDisabledPhones = aiDisabledPhones.filter(p => p !== num);
          saveAiDisabledPhones(aiDisabledPhones);
          await sock.sendMessage(sendTo, { text: '✅ تم تفعيل الزكاء للرقم ' + num + '. هيرد عليه تاني.' });
        }
        lastReply = 'ENABLE: ' + num;
        continue;
      }
      if (aiMode === 'manual') {
        console.log('Manual mode, skipping reply from: ' + sender);
        continue;
      }

      const greetings = ['هلا', 'هلاو', 'السلام عليكم', 'السلام عليكو', 'سلام عليكم', 'سلام', 'مرحبا', 'اهلا', 'أهلا', 'هاي', 'هاي'];
      if (greetings.includes(tlow) || tlow.startsWith('السلام عليكم') || tlow.startsWith('سلام عليكم')) {
        const family = familyContacts.find(f => f.phone && (from.includes(f.phone) || senderPhone.includes(f.phone)));
        if (family) {
          const rel = family.relationship;
          const greet = rel.includes('زوج') ? 'هلا يا مزتي' : rel.includes('أخت') ? 'هلا أختي' : rel.includes('أخ') ? 'هلا أخوي' : rel.includes('بنت') ? 'هلا بنتي' : 'هلا';
          replyText = greet + '، عامل إيه؟';
        } else {
          replyText = 'وعليكم السلام ورحمة الله وبركاته. مرحبًا بكم في شركة ماهر البدري لمعدات السلامة من الحريق. أنا تحت أمرك، أيه اللي تطلبه؟';
        }
        lastReply = replyText.substring(0, 100);
        await sock.sendMessage(sendTo, { text: replyText });
        history.push({ role: 'assistant', content: replyText });
        if (history.length > MAX_HISTORY) history.shift();
        try { saveHistory(); } catch(e) {}
        continue;
      }

      const family = familyContacts.find(f => f.phone && (from.includes(f.phone) || senderPhone.includes(f.phone)));
      let familyContext = '';
      if (family) {
        familyContext = ' [هذا من العائلة: ' + family.relationship + ' (' + family.name + '). رد طبيعي بدون تعريف بنفسك، ' + family.style + ']';
      }

      try {
        let replyText = await callAI(SYSTEM_PROMPT, history.slice(-10, -1), familyContext + '\n' + text);

        if (!replyText) replyText = 'آسف، حصل مشكلة فنية. كلم المهندس ماهر البدري على الخاص.';
        lastReply = replyText.substring(0, 100);
        await sock.sendMessage(sendTo, { text: replyText });
        lastError = '';
        history.push({ role: 'assistant', content: replyText });
        if (history.length > MAX_HISTORY) history.shift();
        try { saveHistory(); } catch(e) {}
        if (isVoice && !family) {
          try {
            const t = replyText.substring(0, 200);
            const url = 'https://translate.google.com/translate_tts?ie=UTF-8&q=' + encodeURIComponent(t) + '&tl=ar&client=tw-ob';
            const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (resp.ok) {
              const buf = Buffer.from(await resp.arrayBuffer());
              if (buf.length > 500) {
                await sock.sendMessage(sendTo, { audio: buf, mimetype: 'audio/mpeg' });
              }
            }
          } catch (e) { console.error('TTS error: ' + e.message); }
        }
        console.log('Replied: ' + replyText.substring(0, 50));
      } catch (err) {
        lastError = err.message;
        console.error('Error: ' + err.message);
        try {
          await sock.sendMessage(sendTo, { text: 'آسف، حصل مشكلة فنية. كلم المهندس ماهر البدري على الخاص.' });
        } catch(e2) {}
      }
    } } catch(e) { lastError = 'FATAL: ' + e.message; console.error('FATAL: ' + e.message); }
  });
}

app.listen(BRIDGE_PORT, () => {
  console.log('Bridge API on http://localhost:' + BRIDGE_PORT);
});
startKeepAlive();
startBridge().catch(console.error);