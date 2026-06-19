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

const DEFAULT_FALLBACK_TEXT = 'مرحبًا بك في ورشة ماهر البدري لمعدات السلامة من الحريق\n' +
  '📍 شارع الحج، مكة المكرمة، الصنايعية الجديدة، بجوار مركز تقدير للسيارات\n\n' +
  'قائمة الإيجار والأسعار (ريال/اليوم):\n' +
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
  'لأي استفسار أو صيانة وتصليح ماكينات، تشرفنا في الورشة أو كلم المهندس ماهر البدري.';

const SYSTEM_PROMPT = 'أنت ماهر البدري، صاحب ورشة معدات حريق.\n\n' +
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
'- لو حد سلم عليك (السلام عليكم، هلا، مرحبا): رد التحية بأحسن منها وقل "وعلي وعليكم السلام ورحمة الله وبركاته" وبعدين رحب بالعميل وقلبه تحت أمرك.\n' +
'- للعائلة: رد بنفس لهجة اللي كلمك\n' +
'- العربية الفصحى ممنوع. رد بالعامية فقط\n' +
'- **العملاء (غير العائلة): ناديهم باسمهم اللي جايزلك (مثلاً "مرحبا أحمد"). استخدم اسم العميل في أول رد.**\n' +
'- **العملاء (غير العائلة): رد باللهجة المصرية فقط - استخدم الكلمات المصرية دي**\n' +
'قاموس اللهجة المصرية (استخدمها بدل الفصحى):\n' +
'- "إيه" بدل "ماذا"\n' +
'- "عايز/عايزة" بدل "أريد"\n' +
'- "كده" بدل "هكذا"\n' +
'- "دلوقتي" بدل "الآن"\n' +
'- "هو إيه" بدل "ما هو"\n' +
'- "مش" بدل "ليس"\n' +
'- "عشان" بدل "لأن"\n' +
'- "بكره" بدل "غداً"\n' +
'- "النهارده" بدل "اليوم"\n' +
'- "أمبارح" بدل "أمس"\n' +
'- "كلمني" بدل "اتصل بي"\n' +
'- "خلاص" بدل "انتهى"\n' +
'- "طيب" بدل "حسناً"\n' +
'- "إزيك/إزيكو" بدل "كيف حالك"\n' +
'- "أهلاً" بدل "مرحباً"\n' +
'- "ينفع" بدل "يمكن"\n' +
'- "مينفعش" بدل "لا يمكن"\n' +
'- "كام" بدل "كم"\n' +
'- "ده/دي" بدل "هذا/هذه"\n' +
'- "أوامر" بدل "نعم"\n' +
'- "تمام" بدل "جيد"\n' +
'- "ماله/مالها" بدل "ما به"\n' +
'- "بس" بدل "فقط"\n' +
'- "كمان" بدل "أيضاً"\n' +
'- "برضه" بدل "أيضاً"\n' +
'- "أهو" بدل "هو"\n' +
'- "بقى" تستخدم للتوكيد زي "إيه ده بقى"\n' +
'- "أيوة" بدل "نعم"\n' +
'- "لأ" بدل "لا"\n' +
'- "يبقى" بدل "فإن"\n\n' +
'- إذا سأل عن منتج: قول اسمه وسعره من القائمة\n' +
'- إذا سأل عن الإيجار: قول سعر اليوم\n' +
'- تصليح أو قطع غيار: "موجود كل حاجة إن شاء الله، جيبها الورشة"\n' +
'- إذا طلب طلب: اسأله عن اسمه فقط وشو يبي بالضبط\n' +
'- لما ترد على العائلة: كلمهم كأهلك. لا تعرف بنفسك. استخدم أسلوبهم.\n' +
'- ردودك قصيرة قد السؤال. لا تقول اسمك ولا عنوانك إلا إذا سألوك.\n' +
'- عربي فقط. ممنوع أي إنجليزي.\n' +
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
'** قسم طقم الأسنان **\n' +
'إذا احتوت الرسالة على (أسنان، أسنان ماكينة، طقم أسنان): رد فوراً بدون مقدمات: "طقم الأسنان موجود ومتوفر للبيع ومتاح في الورشة علطول يا فندم، تنورنا في أي وقت!"\n\n' +
'** قسم الصيانة والقطع الكبيرة **\n' +
'إذا احتوت الرسالة على (موتور، طرمبة، طرمبة زيت، لقمة، لوقم، تصليح، اصلاح, اصلح، اصلحها، عطلانة، عطلان، عطل، صيانة، طريقة تصليح، مكنه، ماكنة، عندي مكنه): رد فوراً: "أه قطع الغيار موجودة والصيانة متوفرة إن شاء الله، جيبها هنا الورشة للمهندس ماهر عشان يعملها لك وينظر فيها بنفسه."\n\n' +
'** قسم تكلفة الصيانة **\n' +
'إذا سأل عن (التكلفة كام، تكلف صيانة كام، حسابها كام): رد فوراً: "يا فندم التكلفة دي بتكون حسب ما المهندس ماهر يشوف المكنة ويعاين العطل بنفسه، أو أنا بجيب لك الأسعار من المهندس علطول. تشرفنا في الورشة!"\n\n' +
'** انضمام الجروب **\n' +
'إذا طلب أحد الانضمام لجروب الواتساب الخاص بالمؤسسة:\n' +
'1. اسأله أولاً: "هل أنت سباك؟"\n' +
'2. إذا قال نعم أو أي تأكيد: أعطه رابط الجروب: https://chat.whatsapp.com/DL3qCnpSs6fHU5VYZgDgNL\n' +
'3. وحذره: لا تنشر أي صور لمواد السباكة أو الحريق (حديد أو بلاستيك) لأن هذا جروب خاص بالمؤسسة فقط';

async function callAI(systemPrompt, history, userMsg) {
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const msg of history) messages.push({ role: msg.role, content: msg.content });
  messages.push({ role: 'user', content: userMsg });
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('No GROQ_API_KEY');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, temperature: 0.7, max_tokens: 1024 }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (res.status !== 200) throw new Error('Groq HTTP ' + res.status);
    const j = await res.json();
    return j.choices?.[0]?.message?.content || '';
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
let keyIndex = 0;

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '825fa7e8d2e30bba9b5e52da5c3bb95a';
const CF_API_TOKEN = process.env.CF_API_TOKEN || 'v76lEul9q6T64_K0_PkaGkZ33gM8L6_iM6f89z5t';

async function callCloudflare(systemPrompt, history, userMsg) {
  const msgs = [{ role: 'system', content: systemPrompt }];
  for (const m of history) msgs.push({ role: m.role, content: m.content || '' });
  msgs.push({ role: 'user', content: userMsg });
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    const r = await fetch('https://api.cloudflare.com/client/v4/accounts/' + CF_ACCOUNT_ID + '/ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + CF_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', messages: msgs, temperature: 0.7, max_tokens: 1024 }),
      signal: c.signal
    });
    clearTimeout(t);
    if (r.status === 200) {
      const j = await r.json();
      return j.choices?.[0]?.message?.content || '';
    }
    return null;
  } catch (e) {
    return null;
  }
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
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + apiKey, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: systemPrompt }] }, generationConfig: { temperature: 0.7, maxOutputTokens: 1024 } }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status === 200) {
        keyIndex = (idx + 1) % GEMINI_KEYS.length;
        const j = await res.json();
        return j.candidates?.[0]?.content?.parts?.[0]?.text || '';
      }
      continue;
    } catch (e) {
      clearTimeout(timer);
      continue;
    }
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
    const opts = {
      hostname: 'api.groq.com', path: '/openai/v1/audio/transcriptions',
      method: 'POST', timeout: 30000,
      headers: form.getHeaders({ 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY })
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
let lastBranch = '';
let pushNameVal = '';
let restartTimer = null;

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
  if (!latestQr) return res.status(404).send('No QR available yet.');
  res.setHeader('Content-Type', 'image/png');
  res.send(await QRCode.toBuffer(latestQr, { type: 'png', width: 400 }));
});

app.get('/diag', (req, res) => {
  res.json({ msgCount, lastError, lastFrom, lastReply, lastBranch, pushNameVal, wsConnected, aiMode });
});

app.get('/admin', (req, res) => {
  const mode = aiMode === 'ai' ? '🤖' : '🖐';
  const modeText = aiMode === 'ai' ? 'رد الذكاء' : 'رد يدوي';
  let convList = '';
  for (const [jid] of conversationHistory) {
    const phone = jid.split('@')[0].replace(/[^0-9]/g, '');
    const isOff = aiDisabledPhones.some(p => phone.includes(p) || jid.includes(p));
    convList += `<tr><td style="padding:6px 0">${phone}</td><td><a href="/disable/${encodeURIComponent(phone)}" class="btn btn-red" style="padding:4px 10px;font-size:12px">${isOff ? '🔇' : '🔊'}</a></td></tr>`;
  }
  res.send(`<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>تحكم البوت</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:sans-serif;background:#1a1a2e;color:#eee;padding:20px;max-width:500px;margin:auto}h2{color:#e94560;text-align:center}.card{background:#0f3460;padding:15px;border-radius:10px;margin:15px 0;text-align:center}.btn{display:inline-block;padding:12px 24px;margin:5px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:bold;border:none;cursor:pointer}.btn-red{background:#e94560;color:#fff}input{padding:10px;border-radius:6px;border:none;width:60%}table{width:100%}td{padding:4px}</style></head><body><h2>🔧 تحكم البوت</h2><div class="card">${wsConnected ? '✅ متصل' : '❌ غير متصل'} | <b>${mode} ${modeText}</b></div><div class="card"><form action="/disable" method="get" style="display:flex;gap:8px"><input name="num" placeholder="رقم الرأس" required><button type="submit" class="btn btn-red" style="padding:10px 16px">🔇 إيقاف</button></form></div><h3>💬 المحادثات</h3><table>${convList}</table></body></html>`);
});

app.get('/mode/:value', (req, res) => {
  if (req.params.value === 'ai') aiMode = 'ai';
  else aiMode = 'manual';
  res.redirect('/admin');
});

app.get('/', (req, res) => {
  res.send(`<h1>🔧 ماهر البدري - معدات حريق</h1><h2>${wsConnected ? '✅ متصل' : '❌ غير متصل'}</h2>`);
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
    if (qr) latestQr = qr;
    if (connection === 'open') wsConnected = true;
    if (connection === 'close') {
      wsConnected = false;
      if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut && !restartTimer) {
        restartTimer = setTimeout(() => { restartTimer = null; startBridge(); }, 10000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try { 
      for (const msg of messages) {
      if (!msg.key || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

      let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
      const from = jid;
      const senderPhone = from.split('@')[0].replace(/[^0-9]/g, '');
      if (aiDisabledPhones.some(p => senderPhone.includes(p) || from.includes(p))) continue;

      if (msg.message?.audioMessage && !text) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          text = await transcribeAudio(buffer);
        } catch (e) { continue; }
      }
      if (!text) continue;

      msgCount++;
      if (!conversationHistory.has(from)) conversationHistory.set(from, []);
      const history = conversationHistory.get(from);
      history.push({ role: 'user', content: text });
      if (history.length > MAX_HISTORY) history.shift();

      if (aiMode === 'manual') continue;

      const family = familyContacts.find(f => from.includes(f.phone) || senderPhone.includes(f.phone));
      let familyContext = family ? ` [هذا من العائلة: ${family.relationship} (${family.name}). رد بدون تعريف وبأسلوبه]` : ` [اسم العميل: ${msg.pushName || 'عميل'}. ناديه باسمه]`;

      let replyText = '';
      const h = history.slice(-10, -1);

      // 1. جرب Groq الأول لأنه الأفضل واللوج عندك شغال عليه
      try {
        replyText = await callAI(SYSTEM_PROMPT, h, text + familyContext);
        if (replyText) lastBranch = 'GROQ_OK';
      } catch (err) {
        console.error('Groq Error: ' + err.message);
      }

      // 2. البديل الفوري: Cloudflare مجاناً وبدون بلوك
      if (!replyText) {
        try {
          replyText = await callCloudflare(SYSTEM_PROMPT, h, text + familyContext);
          if (replyText) lastBranch = 'CLOUDFLARE_OK';
        } catch (err) {
          console.error('CF Error: ' + err.message);
        }
      }

      // 3. البديل الثالث: Gemini
      if (!replyText) {
        try {
          replyText = await callAIGemini(SYSTEM_PROMPT, h, text + familyContext);
          if (replyText) lastBranch = 'GEMINI_OK';
        } catch (err) {
          console.error('Gemini Error: ' + err.message);
        }
      }

      // 4. الفولباك النهائي لو كله قطع
      if (!replyText) {
        replyText = DEFAULT_FALLBACK_TEXT;
        lastBranch = 'FALLBACK_TRIGGERED';
      }

      await sock.sendPresenceUpdate('composing', from);
      await new Promise(r => setTimeout(r, 1500));
      await sock.sendMessage(from, { text: replyText }).catch(() => {});

      history.push({ role: 'assistant', content: replyText });
      if (history.length > MAX_HISTORY) history.shift();
      saveHistory();
    } } catch(e) {}
  });
}

app.listen(BRIDGE_PORT, () => { console.log('Port ' + BRIDGE_PORT); });
startKeepAlive();
startBridge().catch(console.error);
