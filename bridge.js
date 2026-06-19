require('dotenv').config();
const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const QRCode = require('qrcode');
const https = require('https');

const RENDER_URL = 'https://whatsapp-bridge-8lq2.onrender.com';
const BRIDGE_PORT = process.env.PORT || 10000;
const AUTH_DIR = './auth_info';
let latestQr = null;

function startKeepAlive() {
  setInterval(() => {
    https.get(RENDER_URL + '/status', res => { res.resume(); }).on('error', () => {});
  }, 240000);
}

// محرك الرد الذكي المحلي المباشر لتفادي أخطاء السيرفرات الخارجية
function getLocalAIResponse(userMsg) {
  const msg = userMsg.toLowerCase().trim();
  
  const prices = '🔧 *أسعار الإيجار اليومي في ورشة ماهر البدري*:\n' +
    '1. ماكينة سن 2 بوصة : 100 ريال\n' +
    '2. ماكينة سن 3 بوصة : 120 ريال\n' +
    '3. مكنة جروف : 80 ريال\n' +
    '4. خواشة مواسير : 50 ريال\n' +
    '5. مكنة باركود HDP : 200 ريال\n' +
    '6. مكنة ضغط مياه (كهرباء) : 50 ريال\n' +
    '7. مكنة ضغط مياه (ديزل) : 70 ريال\n' +
    '8. مكنة HDP راس في راس : 200 ريال\n' +
    '9. مولد كهرباء 3 كيلو : 100 ريال\n' +
    '10. مقص 8 بوصة لقص المواسير الحديد : 100 ريال';

  const location = '📍 *مكان الورشة*:\nشارع الحج، مكة المكرمة، الصنايعية الجديدة، بجوار مركز تقدير للسيارات.';

  if (msg.includes('سعر') || msg.includes('كام') || msg.includes('تأجير') || msg.includes('ايجار') || msg.includes('بكم')) {
    return `يا غالي منورني! معاك المهندس ماهر البدري. اتفضل دي قائمة الأسعار المظبوطة للإيجار اليومي:\n\n${prices}\n\nتبي تحجز أي ماكينة منهم؟`;
  }
  
  if (msg.includes('عنوان') || msg.includes('فين') || msg.includes('مكان') || msg.includes('موقع') || msg.includes('لوكيشن')) {
    return `تشرفنا وتطلبنا في أي وقت يا هندسة، عنوان ورشتنا:\n\n${location}\n\nتنورنا في الورشة بأي وقت لصيانة وتصليح المعدات.`;
  }

  if (msg.includes('سلام') || msg.includes('مرحب') || msg.includes('أهلاً') || msg.includes('الو') || msg.includes('يا ماهر')) {
    return `وعليكم السلام ورحمة الله وبركاته! مرحب بيك في ورشة ماهر البدري لمعدات السلامة من الحريق بمكة. أمرني يا غالي، محتاج صيانة ماكينات ولا إيجار؟`;
  }

  if (msg.includes('شكرا') || msg.includes('تسلم') || msg.includes('يعطيك')) {
    return `العفو يا غالي في الخدمة دايماً! تشرفنا في ورشة ماهر البدري بشارع الحج في أي وقت.`;
  }

  // الرد الذكي العام بالعامية
  return `يا مرحب بيك يا غالي مع ورشة ماهر البدري لمعدات الحريق بمكة. سامعك كويس، اتفضل قولي إيه طلبك بالظبط بخصوص الصيانة أو الإيجار عشان أخدمك فوراً؟\n\n📍 للعنوان اسأل عن "المكان"\n💰 للأسعار اسأل عن "الأسعار"`;
}

const app = express();
app.use(express.json());
let wsConnected = false;

app.get('/status', (req, res) => res.json({ connected: wsConnected }));
app.get('/qr', async (req, res) => {
  if (!latestQr) return res.send('<h1>البوت متصل شغال بالفعل وجاهز للرد!</h1>');
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
    browser: ['Ubuntu', 'Chrome', '110.0.0.0']
  });

  sock.ev.on('creds.update', saveCreds);
  
  sock.ev.on('connection.update', ({ connection, qr }) => {
    if (qr) latestQr = qr;
    if (connection === 'open') {
      wsConnected = true;
      latestQr = null;
      console.log('✅ Connected Locally!');
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

        // توليد الرد الذكي فوراً بدون انتظار سيرفر خارجي
        let replyText = getLocalAIResponse(text);

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
