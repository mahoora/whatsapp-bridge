require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const QRCode = require('qrcode');
const https = require('https');
const fs = require('fs');
const path = require('path');

const RENDER_URL = 'https://whatsapp-bridge-8lq2.onrender.com';
const BRIDGE_PORT = process.env.PORT || process.env.BRIDGE_PORT || 10000;
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
let latestQr = null;

function startKeepAlive() {
  setInterval(() => {
    https.get(RENDER_URL + '/status', res => { res.resume(); }).on('error', () => {});
  }, 240000);
}

// تنظيف الكاش القديم المسبب للتعذر فوراً عند إعادة التشغيل
if (fs.existsSync(AUTH_DIR)) {
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    console.log('Cleaned old auth cache');
  } catch(e){}
}

const DEFAULT_FALLBACK_TEXT = 'مرحبًا بك في ورشة ماهر البدري لمعدات السلامة من الحريق\n' +
  '📍 شارع الحج، مكة المكرمة، الصنايعية الجديدة، بجوار مركز تقدير للسيارات\n\n' +
  'قائمة الإيجار والأسعار (ريال/اليوم):\n' +
  '1. ماكينة سن 2 بوصة : 100 ريال\n' +
  '2. ماكينة سن 3 بوصة : 120 ريال\n' +
  '3. مكنة جروف : 80 ريال\n' +
  '4. خواشة مواسير : 50 ريال\n' +
  '5. مكنة باركود HDP : 200 ريال\n' +
  '6. مكنة ضغط مياه (كهرباء) : 50 ريال\n' +
  '7. مكنة ضغط مياه (ديزل) : 70 ريال\n' +
  '8. مكنة HDP راس في راس : 200 ريال\n' +
  '9. مولد كهرباء 3 كيلو : 100 ريال\n' +
  '10. مقص 8 بوصة لقص المواسير الحديد : 100 ريال\n\n' +
  'لأي استفسار أو صيانة وتصليح ماكينات، تشرفنا في الورشة أو كلم المهندس ماهر البدري.';

const SYSTEM_PROMPT = 'أنت ماهر البدري، صاحب ورشة معدات حريق في مكة. رد بالعامية المصرية وبشكل مختصر ومفيد جداً. نادِ العميل باسمه أول الرد.';

const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
let keyIndex = 0;

async function callAIGemini(history, userMsg) {
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
        body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }, generationConfig: { temperature: 0.7, maxOutputTokens: 512 } }),
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

const app = express();
app.use(express.json());
let wsConnected = false;

app.get('/status', (req, res) => res.json({ connected: wsConnected }));
app.get('/qr', async (req, res) => {
  if (!latestQr) return res.send('<h1>الباركود الجديد بيفتح.. انتظر ثواني وحدث الصفحة</h1>');
  res.setHeader('Content-Type', 'image/png');
  res.send(await QRCode.toBuffer(latestQr, { type: 'png', width: 400 }));
});
app.get('/', (req, res) => {
  if (wsConnected) return res.send(`<h1>✅ البوت يعمل بنجاح ومربوط بالواتساب</h1>`);
  res.send(`<h1>🔧 البوت واقف مستني الباركود</h1>`);
});

async function startBridge() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '110.0.0.0'], // تعريف رسمي نظيف ومقبول فوراً
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 10000
  });

  sock.ev.on('creds.update', saveCreds);
  
  sock.ev.on('connection.update', ({ connection, qr }) => {
    if (qr) latestQr = qr;
    if (connection === 'open') {
      wsConnected = true;
      latestQr = null;
      console.log('✅ تم الاتصال!');
    }
    if (connection === 'close') {
      wsConnected = false;
      setTimeout(startBridge, 10000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try { 
      for (const msg of messages) {
        if (!msg.key || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

        let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (!text) continue;

        let replyText = await callAIGemini([], text);
        if (!replyText) replyText = DEFAULT_FALLBACK_TEXT;

        await sock.sendPresenceUpdate('composing', jid);
        await new Promise(r => setTimeout(r, 1000));
        await sock.sendMessage(jid, { text: replyText }).catch(() => {});
      } 
    } catch(e) {}
  });
}

app.listen(BRIDGE_PORT, () => { console.log('Server running on port ' + BRIDGE_PORT); });
startKeepAlive();
startBridge().catch(console.error);
