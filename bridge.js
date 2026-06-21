require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const QRCode = require('qrcode');
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
function loadAiDisabledPhones() {
  try { return JSON.parse(fs.readFileSync('./ai-disabled.json')); }
  catch(e) { return []; }
}

function getSystemPrompt() {
  const now = new Date();
  const time = now.toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString('ar-SA', { timeZone: 'Asia/Riyadh' });

  return 'أنت ماهر البدري، صاحب ورشة معدات حريق.\n' +
  'التاريخ والوقت الحالي في مكة المكرمة: ' + date + ' الساعة ' + time + '\n\n' +
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
  '- عندك معرفة عامة وشاملة في كل المجالات: دين، تاريخ، سياسة، علوم، رياضة، ثقافة، تكنولوجيا، طبخ، صحة، أي حاجة. تقدر ترد على أي سؤال من أي مجال.\n' +
  '- لو حد سلم عليك (السلام عليكم، هلا، مرحبا): رد التحية بأحسن منها وقل "وعليكم السلام ورحمة الله وبركاته" وبعدين رحب بالعميل وقلبه تحت أمرك.\n' +
  '- للعائلة: رد بنفس لهجة اللي كلمك\n' +
  '- العربية الفصحى ممنوع. رد بالعامية فقط\n' +
  '- **العملاء (غير العائلة): ناديهم باسمهم اللي جايزلك (مثلاً "مرحبا أحمد"). استخدم اسم العميل في أول رد.**\n' +
  '- **العملاء (غير العائلة): رد باللهجة المصرية فقط**\n' +
  '- إذا سأل عن منتج: قول اسمه وسعره من القائمة\n' +
  '- إذا سأل عن الإيجار: قول سعر اليوم\n' +
  '- تصليح أو قطع غيار: "موجود كل حاجة إن شاء الله، جيبها الورشة للمهندس ماهر"\n' +
  '- إذا طلب طلب: اسأله عن اسمه فقط وشو يبي بالضبط\n' +
  '- ردودك قصيرة قد السؤال.\n' +
  '- عربي فقط.\n' +
  '** قسم الأسنان **: "طقم الأسنان موجود ومتوفر للبيع ومتاح في الورشة علطول يا فندم، تنورنا في أي وقت!"\n' +
  '** قسم بيع مواد السباكة: ** موجود متوفر عندنا مواد السباكة الحديد والبلاستيك يا فندم، ابعت لنا الكشف أو الطلبات اللي محتاجها بالكميات، وأنا هسعر هولك وأبعتهولك علطول! (كلم أحمد: +96659383768)\n' +
  '** قسم الصيانة: ** "أه قطع الغيار موجودة والصيانة متوفرة إن شاء الله، جيبها هنا الورشة للمهندس ماهر عشان يعملها لك وينظر فيها بنفسه."';
}

const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
let keyIndex = 0;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '';
const CF_API_TOKEN = process.env.CF_API_TOKEN || '';

async function callCloudflare(systemPrompt, history, userMsg) {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) return null;
  const msgs = [{ role: 'system', content: systemPrompt }];
  for (const m of history) msgs.push({ role: m.role, content: m.content || '' });
  msgs.push({ role: 'user', content: userMsg });
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 30000);
    const r = await fetch('https://api.cloudflare.com/client/v4/accounts/' + CF_ACCOUNT_ID + '/ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + CF_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', messages: msgs, temperature: 0.7, max_tokens: 1024 }),
      signal: c.signal
    });
    clearTimeout(t);
    if (r.status === 200) { const j = await r.json(); return j.choices?.[0]?.message?.content || ''; }
    return null;
  } catch (e) { return null; }
}

async function callAIGemini(systemPrompt, history, userMsg) {
  if (GEMINI_KEYS.length === 0) return null;
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    const idx = (keyIndex + i) % GEMINI_KEYS.length;
    const apiKey = GEMINI_KEYS[idx];
    const contents = [];
    for (const msg of history) contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] });
    contents.push({ role: 'user', parts: [{ text: userMsg }] });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + apiKey, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: systemPrompt }] }, generationConfig: { temperature: 0.7, maxOutputTokens: 1024 } }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status === 200) { keyIndex = (idx + 1) % GEMINI_KEYS.length; const j = await res.json(); return j.candidates?.[0]?.content?.parts?.[0]?.text || ''; }
    } catch (e) { clearTimeout(timer); }
  }
  return null;
}

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
    const opts = { hostname: 'api.groq.com', path: '/openai/v1/audio/transcriptions', method: 'POST', timeout: 30000, headers: form.getHeaders({ 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY }) };
    const req = https.request(opts, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { const j = JSON.parse(b); resolve(j.text || ''); } catch (e) { reject(e); } }); });
    req.on('error', reject);
    form.pipe(req);
  });
}

function loadHistory() { try { const data = JSON.parse(fs.readFileSync(HISTORY_FILE)); return new Map(Object.entries(data)); } catch (e) { return new Map(); } }
function saveHistory() { const obj = {}; for (const [key, val] of conversationHistory) { obj[key] = val; } fs.writeFileSync(HISTORY_FILE, JSON.stringify(obj)); try { renderUpdateEnv('HISTORY_JSON', Buffer.from(JSON.stringify(obj)).toString('base64')); } catch (e) {} }

const app = express();
app.use(express.json());
let currentSock = null;
let wsConnected = false;
let restartTimer = null;

app.post('/set-mode', (req, res) => { aiMode = req.body.mode; res.json({ success: true, mode: aiMode }); });

app.get('/status', (req, res) => { res.json({ connected: wsConnected, mode: aiMode }); });

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>تحكم البوت</title></head>
  <body style="background:#1a1a2e;color:#eee;text-align:center;font-family:sans-serif;">
  <h1>بوت ماهر البدري</h1>
  <h2>الحالة: ${wsConnected ? '✅ متصل' : '❌ غير متصل'}</h2>
  <h3>الوضع الحالي: ${aiMode === 'ai' ? '🤖 تلقائي' : '✋ يدوي'}</h3>
  <button onclick="fetch('/set-mode', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mode:'ai'})}).then(()=>location.reload())" style="padding:15px; margin:10px; font-size:20px; background:green; color:white; border:none; border-radius:10px;">تشغيل التلقائي</button>
  <button onclick="fetch('/set-mode', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mode:'manual'})}).then(()=>location.reload())" style="padding:15px; margin:10px; font-size:20px; background:red; color:white; border:none; border-radius:10px;">إيقاف البوت (يدوي)</button>
  ${!wsConnected && latestQr ? `<img src="/qr" style="border:4px solid #e94560;border-radius:10px;">` : ''}
  </body></html>`);
});

app.get('/qr', async (req, res) => { if (!latestQr) return res.status(404).send('Wait...'); res.setHeader('Content-Type', 'image/png'); res.send(await QRCode.toBuffer(latestQr, { type: 'png', width: 400 })); });

async function startBridge() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({ printQRInTerminal: true, auth: state, logger: pino({ level: 'silent' }), browser: ['Chrome', 'Desktop', '1.0'], markOnlineOnConnect: false });
  currentSock = sock;
  sock.ev.on('creds.update', () => { saveCreds(); saveCredsToEnv(); });
  sock.ev.on('connection.update', ({ connection, qr }) => { if (qr) latestQr = qr; if (connection === 'open') wsConnected = true; if (connection === 'close') { wsConnected = false; if (!restartTimer) restartTimer = setTimeout(() => { restartTimer = null; startBridge(); }, 5000); } });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      for (const msg of messages) {
        if (!msg.key || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

        let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
        const senderPhone = jid.split('@')[0].replace(/[^0-9]/g, '');
        if (aiDisabledPhones.some(p => senderPhone.includes(p) || jid.includes(p))) continue;

        if (msg.message?.audioMessage && !text) {
          try { const buffer = await downloadMediaMessage(msg, 'buffer', {}); text = await transcribeAudio(buffer); } catch (e) { continue; }
        }
        if (!text) continue;

        const tlow = text.trim();
        if (tlow === 'يدوي') { aiMode = 'manual'; await sock.sendMessage(jid, { text: '✅ تم التحويل للرد اليدوي.' }); continue; }
        if (tlow === 'تلقائي') { aiMode = 'ai'; await sock.sendMessage(jid, { text: '✅ تم التحويل للتلقائي.' }); continue; }
        if (aiMode === 'manual') continue;

        if (!conversationHistory.has(jid)) conversationHistory.set(jid, []);
        const history = conversationHistory.get(jid);
        history.push({ role: 'user', content: text });
        if (history.length > MAX_HISTORY) history.shift();
        
        const family = familyContacts.find(f => f.phone && (jid.includes(f.phone) || senderPhone.includes(f.phone)));
        let familyContext = family ? ` [هذا من العائلة: ${family.relationship}]` : '';

        let replyText = await callAIGemini(getSystemPrompt(), history.slice(-10), familyContext + '\n' + text);
        if (!replyText) replyText = await callCloudflare(getSystemPrompt(), history.slice(-10), familyContext + '\n' + text);

        if (!replyText) replyText = 'آسف، كلمني على الخاص.';
        await sock.sendMessage(jid, { text: replyText });
        history.push({ role: 'assistant', content: replyText });
        saveHistory();
      }
    } catch(e) { console.error(e); }
  });
}

app.listen(BRIDGE_PORT, () => { console.log('Server running'); startBridge(); });
startKeepAlive();
