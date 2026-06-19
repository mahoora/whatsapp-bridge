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

// تنظيف الكاش إجباريًا عشان نلغي اللخفنة ويطلع باركود جديد حالا
if (fs.existsSync(AUTH_DIR)) {
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch(e){}
}

function getLocalAIResponse(userMsg) {
  const msg = userMsg.toLowerCase().trim().replace(/[؟\?\.،,]/g, '');
  const prices = '🔧 *أسعار الإيجار اليومي في ورشة ماهر البدري*:\n1. ماكينة سن 2 بوصة : 100 ريال\n2. ماكينة سن 3 بوصة : 120 ريال\n3. مكنة جروف : 80 ريال\n4. خواشة مواسير : 50 ريال\n5. مكنة باركود HDP : 200 ريال\n6. مكنة ضغط مياه (كهرباء) : 50 ريال\n7. مكنة ضغط مياه (ديزل) : 70 ريال\n8. مكنة HDP راس في راس : 200 ريال\n9. مولد كهرباء 3 كيلو : 100 ريال\n10. مقص 8 بوصة لقص المواسير الحديد : 100 ريال';
  const location = '📍 *مكان الورشة*:\nشارع الحج، مكة المكرمة، الصنايعية الجديدة، بجوار مركز تقدير للسيارات.';

  if (/سعر|كام|بكام|قائمه|قائمة|ايجار|إيجار|تأجير|تاخير|فلوس|ريال|بكم/.test(msg)) {
    return `يا غالي منورني! معاك المهندس ماهر البدري. اتفضل دي قائمة الأسعار المظبوطة للإيجار اليومي:\n\n${prices}`;
  }
  if (/عنوان|فين|مكان|موقع|لوكيشن|وين|الورشة|الورشه|طريق|وصف/.test(msg)) {
    return `تشرفنا وتنورنا في أي وقت يا هندسة، عنوان ورشتنا:\n\n${location}`;
  }
  if (/سلام|مرحب|اهلان|اهلا|الو|يا ماهر|صباح|مساء|خير|هلا/.test(msg)) {
    return `وعليكم السلام ورحمة الله وبركاته! مرحب بيك في ورشة ماهر البدري لمعدات السلامة من الحريق بمكة. أمرني يا غالي محتاج صيانة ولا إيجار؟`;
  }
  return `يا مرحب بيك يا غالي مع ورشة ماهر البدري لمعدات الحريق بمكة. اتفضل قولي إيه طلبك بالظبط بخصوص الصيانة أو الإيجار عشان أخدمك فوراً؟\n\n📍 للعنوان اكتب "المكان"\n💰 للأسعار اكتب "الأسعار"`;
}

const app = express();
app.use(express.json());

app.get('/status', (req, res) => res.json({ connected: wsConnected }));
app.get('/qr', async (req, res) => {
  if (wsConnected) return res.send('<h1>البوت متصل بالفعل شغال!</h1>');
  if (!latestQr) return res.send('<h1>الباركود الفريش بيحمل الحين.. انتظر 5 ثواني وسوي تحديث للصفحة</h1>');
  res.setHeader('Content-Type', 'image/png');
  res.send(await QRCode.toBuffer(latestQr, { type: 'png', width: 400 }));
});
app.get('/', (req, res) => {
  if (wsConnected) return res.send(`<h1>✅ البوت يعمل بنجاح ومربوط بالواتساب</h1>`);
  res.send(`<h1>🔧 البوت واقف مستني الباركود الفريش</h1>`);
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
    if (qr) {
      latestQr = qr;
      wsConnected = false;
    }
    if (connection === 'open') {
      wsConnected = true;
      latestQr = null;
      console.log('✅ Connected!');
    }
    if (connection === 'close') {
      wsConnected = false;
      setTimeout(startBridge, 5000);
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

        let replyText = getLocalAIResponse(text);
        await sock.sendPresenceUpdate('composing', jid);
        await new Promise(r => setTimeout(r, 600));
        await sock.sendMessage(jid, { text: replyText }).catch(() => {});
      } 
    } catch(e) {}
  });
}

app.listen(BRIDGE_PORT, () => { console.log('Server running on port ' + BRIDGE_PORT); });
startKeepAlive();
startBridge().catch(console.error);
