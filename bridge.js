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

// البديل المستقر والمجاني والسريع تماماً لتفادي مشاكل جيميناي وقفل الحسابات
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '825fa7e8d2e30bba9b5e52da5c3bb95a';
const CF_API_TOKEN = process.env.CF_API_TOKEN || 'v76lEul9q6T64_K0_PkaGkZ33gM8L6_iM6f89z5t';

async function callCloudflare(userMsg) {
  const msgs = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMsg }
  ];
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    const r = await fetch('https://api.cloudflare.com/client/v4/accounts/' + CF_ACCOUNT_ID + '/ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + CF_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', messages: msgs, temperature: 0.7, max_tokens: 300 }),
      signal: c.signal
    });
    clearTimeout(t);
    if (r.status === 200) {
      const j = await r.json();
      return j.choices?.[0]?.message?.content || null;
    }
  } catch (e) {}
  return null;
}

const app = express();
app.use(express.json());
let wsConnected = false;

app.get('/status', (req, res) => res.json({ connected: wsConnected }));
app.get('/qr', async (req, res) => {
  if (!latestQr) return res.send('<h1>البوت متصل شغال أو الجلسة جاري تحميلها.. انتظر ثواني</h1>');
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
    browser: ['Ubuntu', 'Chrome', '110.0.0.0'] // متصفح ثابت ومستقر يمنع طلب الباركود المتكرر
  });

  sock.ev.on('creds.update', saveCreds);
  
  sock.ev.on('connection.update', ({ connection, qr }) => {
    if (qr) latestQr = qr;
    if (connection === 'open') {
      wsConnected = true;
      latestQr = null;
      console.log('✅ تم الاتصال والتشغيل الثابت!');
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

        // الرد الذكي الفوري من سيرفر كلوود فلير المضمون
        let replyText = await callCloudflare(text);
        
        // لو السيرفر الخارجي علق تماماً يرجع للموحدة كأمان
        if (!replyText) {
          replyText = DEFAULT_FALLBACK_TEXT;
        }

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
