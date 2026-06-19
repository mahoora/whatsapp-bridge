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
  try { 
    if (fs.existsSync('./family-contacts.json')) {
      return JSON.parse(fs.readFileSync('./family-contacts.json')); 
    }
  } catch(e) {}
  return [];
}
function saveFamilyContacts(data) {
  try { fs.writeFileSync('./family-contacts.json', JSON.stringify(data, null, 2)); } catch(e){}
}
function loadAiDisabledPhones() {
  try { 
    if (fs.existsSync('./ai-disabled.json')) {
      return JSON.parse(fs.readFileSync('./ai-disabled.json')); 
    }
  } catch(e) {}
  return [];
}
function saveAiDisabledPhones(data) {
  try { fs.writeFileSync('./ai-disabled.json', JSON.stringify(data, null, 2)); } catch(e){}
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
'- عندك معرفة عامة في كل المجالات وتجيب على أي سؤال.\n' +
'- رد التحية بأحسن منها بالعامية.\n' +
'- العربية الفصحى ممنوع. رد بالعامية المصرية والمحلية فقط.\n' +
'- نادِ العميل باسمه في أول الرد.\n' +
'- ردودك قصيرة ومباشرة ومفيدة.\n' +
'- صيانة وقطع غيار: "موجود كل حاجة إن شاء الله، جيبها الورشة".';

async function callAI(systemPrompt, history, userMsg) {
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const msg of history) messages.push({ role: msg.role, content: msg.content });
  messages.push({ role: 'user', content: userMsg });
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('No GROQ_API_KEY');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
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

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '825fa7e8d2e30bba9b5e52da5c3bb95a';
const CF_API_TOKEN = process.env.CF_API_TOKEN || 'v76lEul9q6T64_K0_PkaGkZ33gM8L6_iM6f89z5t';

async function callCloudflare(systemPrompt, history, userMsg) {
  const msgs = [{ role: 'system', content: systemPrompt }];
  for (const m of history) msgs.push({ role: m.role, content: m.content || '' });
  msgs.push({ role: 'user', content: userMsg });
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
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

const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
let keyIndex = 0;

async function callAIGemini(systemPrompt, history, userMsg) {
  if (GEMINI_KEYS.length === 0) return null;
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    const idx = (keyIndex + i) % GEMINI_KEYS.length;
    const apiKey = GEMINI_KEYS[idx];
    const contents = [];
    for (const msg of history) contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] });
    contents.push({ role: 'user', parts: [{ text: userMsg }] });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
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
    } catch (e) {
      clearTimeout(timer);
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

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE));
      return new Map(Object.entries(data));
    }
  } catch (e) {}
  return new Map();
}
function saveHistory() {
  try {
    const obj = {};
    for (const [key, val] of conversationHistory) { obj[key] = val; }
    const str = JSON.stringify(obj);
    fs.writeFileSync(HISTORY_FILE, str);
  } catch (e) {}
}

const app = express();
app.use(express.json());
let currentSock = null;
let wsConnected = false;
let restartTimer = null;

app.get('/status', (req, res) => res.json({ connected: wsConnected }));
app.get('/qr', async (req, res) => {
  if (!latestQr) return res.status(404).send('No QR');
  res.setHeader('Content-Type', 'image/png');
  res.send(await QRCode.toBuffer(latestQr, { type: 'png', width: 400 }));
});
app.get('/', (req, res) => res.send(`<h1>🔧 البوت جاهز ويعمل</h1>`));

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
      if (!restartTimer) restartTimer = setTimeout(() => { restartTimer = null; startBridge(); }, 10000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try { 
      for (const msg of messages) {
        if (!msg.key || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

        let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
        if (!text) continue;

        const from = jid;
        if (!conversationHistory.has(from)) conversationHistory.set(from, []);
        const history = conversationHistory.get(from);
        history.push({ role: 'user', content: text });
        if (history.length > MAX_HISTORY) history.shift();

        if (aiMode === 'manual') continue;

        let replyText = '';
        const h = history.slice(-10, -1);

        // 1. محاولة جلب الرد من Groq أولاً
        try {
          replyText = await callAI(SYSTEM_PROMPT, h, text);
        } catch (err) {
          console.error('Groq Failed, switching...');
        }

        // 2. بديل فوري Cloudflare شغال ومجاني 100%
        if (!replyText) {
          try {
            replyText = await callCloudflare(SYSTEM_PROMPT, h, text);
          } catch (err) {
            console.error('Cloudflare Failed...');
          }
        }

        // 3. بديل ثالث Gemini
        if (!replyText) {
          try {
            replyText = await callAIGemini(SYSTEM_PROMPT, h, text);
          } catch (err) {}
        }

        // 4. الفولباك الأخير لو السيرفرات كلها فصلت
        if (!replyText) {
          replyText = DEFAULT_FALLBACK_TEXT;
        }

        await sock.sendPresenceUpdate('composing', from);
        await new Promise(r => setTimeout(r, 1500));
        await sock.sendMessage(from, { text: replyText }).catch(() => {});

        history.push({ role: 'assistant', content: replyText });
        if (history.length > MAX_HISTORY) history.shift();
        saveHistory();
      } 
    } catch(e) {}
  });
}

app.listen(BRIDGE_PORT, () => { console.log('Port ' + BRIDGE_PORT); });
startKeepAlive();
startBridge().catch(console.error);
