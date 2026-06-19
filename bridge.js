require('dotenv').config();
const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const QRCode = require('qrcode');
const https = require('https');
const fs = require('fs');
const path = require('path');

const RENDER_URL = 'https://whatsapp-bridge-8lq2.onrender.com';
const BRIDGE_PORT = process.env.PORT || 10000;
const AUTH_DIR = './auth_info';
let latestQr = null;
let wsConnected = false;

function startKeepAlive() {
  setInterval(() => {
    https.get(RENDER_URL + '/status', res => { res.resume(); }).on('error', () => {});
  }, 240000);
}

// قائمة الأسعار والبيانات كمرجع أساسي ودعم للبوت
const PRICES_DATA = '🔧 أسعار الإيجار اليومي في ورشة ماهر البدري لمعدات الحريق بمكة:\n' +
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
  '📍 العنوان: شارع الحج، مكة المكرمة، الصنايعية الجديدة، بجوار مركز تقدير للسيارات.';

const SYSTEM_PROMPT = `أنت ماهر البدري، صاحب ورشة صيانة وإيجار معدات السلامة من الحريق في مكة. رد بالعامية المصرية وبشكل مختصر جداً ومفيد. نادِ العميل باسمه أول الرد إن أمكن. 
إليك بيانات ورشتك وأسعارك الرسمية للإجابة منها بدقة:
${PRICES_DATA}`;

// سحب مفاتيح جيميناي المسجلة عندك في اللوحة
const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
let keyIndex = 0;

// دالة الذكاء الاصطناعي الأساسية
async function callGeminiAI(userMsg) {
  if (GEMINI_KEYS.length === 0) return null;
  const fullPrompt = `${SYSTEM_PROMPT}\n\nرسالة العميل الحالية: ${userMsg}\n\nالرد المختصر بالعامية:`;
  
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    const idx = (keyIndex + i) % GEMINI_KEYS.length;
    const apiKey = GEMINI_KEYS[idx];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    
    try {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + apiKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: fullPrompt }] }],
          generationConfig: { temperature: 0.6, maxOutputTokens: 300 }
        }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.status === 200) {
        keyIndex = (idx + 1) % GEMINI_KEYS.length;
        const j = await res.json();
        return j.candidates?.[0]?.content?.parts?.[0]?.text || null;
      }
    } catch (e) { clearTimeout(timer); }
  }
  return null;
}

// دالة البديل الذكي المحلي (في حال فشل سيرفر جيميناي تماماً حتى لا يرسل رسالة موحدة غبية)
function getLocalFallback(userMsg) {
  const msg = userMsg.toLowerCase();
  if (/سعر|كام|بكام|ايجار|إيجار|تأجير|بكم|مكينة|مكنة|ماكينة/.test(msg)) {
    return `يا غالي منورني! معاك المهندس ماهر البدري. اتفضل دي قائمة الأسعار الرسمية للإيجار اليومي:\n\n${PRICES_DATA}`;
  }
  if (/عنوان|فين|مكان|موقع|لوكيشن|وين/.test(msg)) {
    return `يا مرحب بيك يا هندسة! عنوان الورشة: مكة المكرمة، شارع الحج، الصنايعية الجديدة، بجوار مركز تقدير للسيارات. تنورنا في أي وقت!`;
  }
  return `يا مرحب بيك مع ورشة ماهر البدري لمعدات الحريق بمكة. أمرني يا غالي، محتاج صيانة ماكينات ولا إيجار ومعدات عشان أخدمك فوراً؟`;
}

const app = express();
app.use(express.json());

app.get('/status', (req, res) => res.json({ connected: wsConnected }));
app.get('/qr', async (req, res) => {
  if (wsConnected) return res.send('<h1>✅ البوت متصل وشغال بالفعل!</h1>');
  if (!latestQr) return res.send('<h1>الباركود بيحمل.. انتظر ثواني وسوي تحديث للصفحة</h1>');
  res.setHeader('Content-Type', 'image/png');
  res.send(await QRCode.toBuffer(latestQr, { type: 'png', width: 400 }));
});

app.get('/', (req, res) => {
  if (wsConnected) return res.send(`<h1>✅ البوت يعمل بنجاح ومربوط بالواتساب</h1>`);
  res.redirect('/qr'); // تحويل تلقائي فوري للباركود لو مش متصل
});

async function startBridge() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Mac OS', 'Chrome', '120.0.0.0']
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, qr }) => {
    if (qr) { latestQr = qr; wsConnected = false; }
    if (connection === 'open') { wsConnected = true; latestQr = null; }
    if (connection === 'close') { wsConnected = false; setTimeout(startBridge, 5000); }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try { 
      for (const msg of messages) {
        if (!msg.key || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue;
        let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (!text) continue;

        // محاولة الرد بالذكاء الاصطناعي جيميناي أولاً
        let replyText = await callGeminiAI(text);
        
        // لو جيميناي معلق أو المفاتيح فيها مشكلة، يروح فوراً للرد الذكي المخصص للأسعار والعناوين
        if (!replyText) {
          replyText = getLocalFallback(text);
        }

        await sock.sendPresenceUpdate('composing', jid);
        await new Promise(r => setTimeout(r, 800));
        await sock.sendMessage(jid, { text: replyText }).catch(() => {});
      } 
    } catch(e) {}
  });
}

app.listen(BRIDGE_PORT, () => { console.log('Server running on port ' + BRIDGE_PORT); });
startKeepAlive();
startBridge().catch(console.error);
