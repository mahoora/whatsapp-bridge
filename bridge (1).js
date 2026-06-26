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

function startKeepAlive() {
  setInterval(() => {
    https.get(RENDER_URL + '/status', res => { res.resume(); }).on('error', () => {});
    saveHistory();
  }, 240000);
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

const SYSTEM_PROMPT = 'أنت ماهر البدري، صاحب ورشة معدات حريق.\n\n' +
'العنوان: شارع الحج، مكة المكرمة، الصنايعية الجديدة، بجوار مركز تقدير للسيارات\n\n' +
'قائمة المنتجات للإيجار (ريال/اليوم):\n' +
'1. ماكينة سن 2 بوصة ← 100 ريال\n' +
'2. ماكينة سن 3 بوصة ← 120 ريال\n' +
'3. مكنة جروف ← 80 ريال\n' +
'4. خواشة مواسير ← 50 ريال\n' +
'5. مكنة باركود HDP ← 200 ريال\n' +
'6. مكنة ضغط مياه (كهرباء) ← 50 ريال\n' +
'7. مكنة ضغط مياه (ديزل) ← 70 ريال\n' +
'8. مكنة HDP راس في راس ← 200 ريال\n' +
'9. مولد كهرباء 3 كيلو ← 100 ريال\n' +
'10. مقص 8 بوصة لقص المواسير الحديد ← 100 ريال\n\n' +
'العامية المصرية فقط. ممنوع الفصحى.\n' +
'للعملاء: ناديهم باسمهم.\n' +
'للعائلة: رد بطريقة أسرية حنونة.\n' +
'ردود قصيرة ومختصرة.';

async function callAI(systemPrompt, history, userMsg, retries = 2) {
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const msg of history) messages.push({ role: msg.role, content: msg.content });
  messages.push({ role: 'user', content: userMsg });
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('No GROQ_API_KEY');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, temperature: 0.7, max_tokens: 1024 }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (res.status === 429 && retries > 0) {
      await new Promise(r => setTimeout(r, 30000));
      return callAI(systemPrompt, history, userMsg, retries - 1);
    }
    if (res.status !== 200) throw new Error('AI HTTP ' + res.status);
    const j = await res.json();
    return j.choices?.[0]?.message?.content || '';
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

const HISTORY_FILE = './conversation-history.json';
const MAX_HISTORY = 30;
let conversationHistory = loadHistory();
let familyContacts = loadFamilyContacts();
let aiDisabledPhones = loadAiDisabledPhones();
let aiMode = 'ai';

function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE));
    return new Map(Object.entries(data));
  } catch (e) {
    return new Map();
  }
}

function saveHistory() {
  const obj = {};
  for (const [key, val] of conversationHistory) {
    obj[key] = val;
  }
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(obj));
}

const app = express();
app.use(express.json());
let currentSock = null;
let wsConnected = false;
let msgCount = 0;

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
  if (!latestQr) return res.status(404).send('No QR available yet');
  res.setHeader('Content-Type', 'image/png');
  res.send(await QRCode.toBuffer(latestQr, { type: 'png', width: 400 }));
});

app.get('/family', (req, res) => {
  res.json(familyContacts);
});

app.post('/family', (req, res) => {
  const { phone, name, relationship } = req.body;
  if (!phone || !name || !relationship) return res.status(400).json({ error: 'Missing fields' });
  familyContacts = familyContacts.filter(f => f.phone !== phone);
  familyContacts.push({ phone, name, relationship });
  saveFamilyContacts(familyContacts);
  res.redirect('/admin');
});

app.delete('/family/:phone', (req, res) => {
  const phone = req.params.phone;
  familyContacts = familyContacts.filter(f => f.phone !== phone);
  saveFamilyContacts(familyContacts);
  res.redirect('/admin');
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
  res.redirect('/admin');
});

app.get('/admin', (req, res) => {
  const mode = aiMode === 'ai' ? '🤖' : '🖐';
  const modeText = aiMode === 'ai' ? 'رد الزكاء' : 'رد يدوي';
  
  let familyList = '';
  for (const contact of familyContacts) {
    const isOff = aiDisabledPhones.includes(contact.phone);
    familyList += `<tr><td style="padding:10px">${contact.name}</td><td>${contact.phone}</td><td>${contact.relationship}</td><td><a href="/disable/${encodeURIComponent(contact.phone)}" class="btn-toggle" style="padding:6px 12px;font-size:12px;background:${isOff ? '#e94560' : '#4caf50'};color:#fff;text-decoration:none;border-radius:4px">${isOff ? '🔇' : '✓'}</a></td></tr>`;
  }

  let convList = '';
  for (const [jid] of conversationHistory) {
    const phone = jid.split('@')[0].replace(/[^0-9]/g, '');
    const isOff = aiDisabledPhones.some(p => phone.includes(p) || jid.includes(p));
    convList += `<tr><td style="padding:8px">${phone}</td><td><a href="/disable/${encodeURIComponent(phone)}" style="padding:6px 12px;font-size:12px;background:${isOff ? '#e94560' : '#4caf50'};color:#fff;text-decoration:none;border-radius:4px">${isOff ? '🔇' : '✓'}</a></td></tr>`;
  }

  res.send(`<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>لوحة التحكم - ماهر البدري</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',sans-serif;background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);color:#eee;padding:20px}h1{color:#e94560;text-align:center;margin-bottom:20px}h3{color:#4caf50;margin-top:25px;margin-bottom:15px}.container{max-width:900px;margin:0 auto}.status-card{background:#0f3460;padding:20px;border-radius:10px;text-align:center;margin-bottom:20px;border-left:4px solid #4caf50}.status-card h2{color:#4caf50;margin-bottom:10px}.card{background:#0f3460;padding:20px;border-radius:10px;margin:15px 0}.form-group{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}.btn{padding:10px 20px;border-radius:6px;border:none;font-size:14px;cursor:pointer;text-decoration:none;display:inline-block}.btn-add{background:#4caf50;color:#fff}.btn-toggle{transition:0.2s}.btn-remove{background:#e94560;color:#fff}.form-inputs{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}input,select{padding:10px;border-radius:6px;border:1px solid #333;background:#16213e;color:#eee;font-size:14px}table{width:100%;border-collapse:collapse;margin:15px 0;background:#0f3460;border-radius:8px;overflow:hidden}th{background:#16213e;padding:12px;text-align:right;font-weight:bold;color:#4caf50;border-bottom:2px solid #4caf50}td{padding:12px;border-bottom:1px solid #16213e}tr:hover{background:#1a2540}.fab-group{display:flex;gap:10px;justify-content:center;margin:30px 0;flex-wrap:wrap}.fab-btn{padding:12px 30px;font-size:16px;font-weight:bold;text-decoration:none;border-radius:8px;transition:0.3s}.fab-ai{background:#4caf50;color:#fff}.fab-manual{background:#e94560;color:#fff}.fab-btn:hover{transform:scale(1.05)}.btn-disable{background:#e94560;color:#fff}.btn-enable{background:#4caf50;color:#fff}</style></head><body><div class="container"><h1>🔧 لوحة التحكم - ماهر البدري</h1><div class="status-card"><h2>${wsConnected ? '✅ متصل بالواتساب' : '❌ غير متصل'}</h2><p>${mode} ${modeText}</p></div><div class="fab-group"><a href="/mode/ai" class="fab-btn fab-ai">🤖 تشغيل الذكاء</a><a href="/mode/manual" class="fab-btn fab-manual">🖐 وضع يدوي</a></div><h3>👨‍👩‍👧‍👦 إدارة العائلة</h3><div class="card"><div class="form-group"><form action="/family" method="post" style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;flex-direction:row"><input type="text" name="name" placeholder="الاسم" required style="width:150px"><input type="text" name="phone" placeholder="الرقم" required style="width:150px"><select name="relationship" required style="width:150px"><option>الزوجة</option><option>الابنة</option><option>الابن</option><option>الأخت</option><option>الأخ</option><option>الأم</option><option>الأب</option><option>أخرى</option></select><button type="submit" class="btn btn-add">➕ إضافة</button></form></div><table>${familyList ? '<thead><tr><th>الاسم</th><th>الرقم</th><th>الصلة</th><th>الحالة</th></tr></thead><tbody>' + familyList + '</tbody>' : '<tr><td colspan="4" style="text-align:center;color:#888">لا توجد أفراد عائلة مضافين</td></tr>'}</table></div><h3>📞 الأرقام النشطة</h3><div class="card"><div class="form-group"><input type="text" id="newPhone" placeholder="أضف رقم جديد" style="width:200px"><button onclick="addPhone()" class="btn btn-add">➕ إضافة</button></div><table>${convList ? '<thead><tr><th>الرقم</th><th>الحالة</th></tr></thead><tbody>' + convList + '</tbody>' : '<tr><td colspan="2" style="text-align:center;color:#888">لا توجد محادثات</td></tr>'}</table></div></div><script>function addPhone(){const num=document.getElementById('newPhone').value;if(!num)return;fetch('/ai-disabled',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:num})}).then(()=>location.reload());}</script></body></html>`);
});

app.get('/mode/:value', (req, res) => {
  if (req.params.value === 'ai') aiMode = 'ai';
  else if (req.params.value === 'manual') aiMode = 'manual';
  res.redirect('/admin');
});

app.get('/disable/:num', (req, res) => {
  const num = decodeURIComponent(req.params.num);
  if (!aiDisabledPhones.includes(num)) {
    aiDisabledPhones.push(num);
    saveAiDisabledPhones(aiDisabledPhones);
  }
  res.redirect('/admin');
});

app.get('/enable/:num', (req, res) => {
  const num = decodeURIComponent(req.params.num);
  aiDisabledPhones = aiDisabledPhones.filter(p => p !== num);
  saveAiDisabledPhones(aiDisabledPhones);
  res.redirect('/admin');
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>ماهر البدري - معدات حريق</title><style>body{font-family:sans-serif;text-align:center;padding:40px;background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);color:#eee}h1{color:#e94560}h2{color:#4caf50}.status{padding:20px;border-radius:10px;margin:20px auto;max-width:400px;background:#0f3460}.connected{border-left:4px solid #4caf50}.disconnected{border-left:4px solid #e94560}img{margin:20px;border:4px solid #e94560;border-radius:10px;max-width:300px}.nav{margin-top:30px}<a style="color:#4caf50;text-decoration:none;margin:0 15px;font-size:16px">🔧 التحكم</a></style></head><body><h1>🔧 ماهر البدري - معدات حريق</h1><div class="status ${wsConnected ? 'connected' : 'disconnected'}"><h2>${wsConnected ? '✅ متصل' : '❌ غير متصل'}</h2><p>${wsConnected ? 'الرقم: ' + currentSock?.user?.id : 'الرجاء المسح'}</p></div>${!wsConnected && latestQr ? '<p>امسح هذا الكود من جوالك:</p><img src="/qr" alt="QR">' : ''}<div class="nav"><a href="/admin" style="color:#4caf50;text-decoration:none;margin:0 15px;font-size:16px">⚙️ لوحة التحكم</a></div></body></html>`);
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
      console.log('✅ متصل: ' + sock.user?.id);
    }
    if (connection === 'close') {
      wsConnected = false;
      if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
        setTimeout(() => startBridge(), 10000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.key || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

      let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (!text) continue;

      const senderPhone = jid.split('@')[0].replace(/[^0-9]/g, '');
      if (aiDisabledPhones.some(p => senderPhone.includes(p))) continue;

      if (aiMode === 'manual') continue;

      msgCount++;

      if (!conversationHistory.has(jid)) {
        conversationHistory.set(jid, []);
      }
      const history = conversationHistory.get(jid);
      history.push({ role: 'user', content: text });
      if (history.length > MAX_HISTORY) history.shift();

      const family = familyContacts.find(f => senderPhone.includes(f.phone));
      const context = family ? `[عائلة: ${family.name}]` : `[عميل]`;

      try {
        const h = history.slice(-5);
        let replyText = await callAI(SYSTEM_PROMPT, h, context + '\n' + text);
        if (!replyText) replyText = 'معذرة، حصلت مشكلة فنية.';

        await sock.sendPresenceUpdate('composing', jid);
        await new Promise(r => setTimeout(r, 2000));
        await sock.sendMessage(jid, { text: replyText });

        history.push({ role: 'assistant', content: replyText });
        if (history.length > MAX_HISTORY) history.shift();
      } catch (e) {
        console.error('خطأ: ' + e.message);
      }

      saveHistory();
    }
  });
}

app.listen(BRIDGE_PORT, () => {
  console.log('🚀 البوت يعمل على المنفذ ' + BRIDGE_PORT);
});

startKeepAlive();
startBridge().catch(console.error);
