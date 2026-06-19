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

function startKeepAlive() {
  setInterval(() => {
    https.get(RENDER_URL + '/status', res => { res.resume(); }).on('error', () => {});
  }, 240000);
}

// قراءة الجلسة المحفوظة من اللوحة لو موجودة عشان ما يطلبش باركود تاني
if (process.env.CREDS_JSON && !fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  try {
    fs.writeFileSync(path.join(AUTH_DIR, 'creds.json'), Buffer.from(process.env.CREDS_JSON, 'base64'));
    console.log('✅ تم استعادة الجلسة بنجاح من اللوحة!');
  } catch (e) { console.error('خطأ في قراءة كاش اللوحة:', e); }
}

function getLocalAIResponse(userMsg) {
  // تحويل النص لسمول وتنظيف المسافات والرموز عشان يلقط أي كلمة
  const msg = userMsg.toLowerCase().trim().replace(/[؟\?\.،,]/g, '');
  
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

  // فحص مرن جداً للكلمات المفتاحية
  if (/سعر|كام|بكام|قائمه|قائمة|ايجار|إيجار|تأجير|تاخير|فلوس|ريال|بكم/.test(msg)) {
    return `يا غالي منورني! معاك المهندس ماهر البدري. اتفضل دي قائمة الأسعار المظبوطة للإيجار اليومي:\n\n${prices}\n\nحابب تحجز أو تستفسر عن ماكينة معينة؟`;
  }
  
  if (/عنوان|فين|مكان|موقع|لوكيشن|وين|الورشة|الورشه|طريق|وصف/.test(msg)) {
    return `تشرفنا وتنورنا في أي وقت يا هندسة، عنوان ورشتنا:\n\n${location}\n\nمفتوحين وجاهزين لصيانة وتصليح جميع المعدات.`;
  }

  if (/سلام|مرحب|اهلان|اهلا|الو|يا ماهر|صباح|مساء|خير|هلا/.test(msg)) {
    return `وعليكم السلام ورحمة الله وبركاته! مرحب بيك في ورشة ماهر البدري لمعدات السلامة من الحريق بمكة. أمرني يا غالي، محتاج صيانة ماكينات ولا إيجار ومعدات؟`;
  }

  if (/شكرا|تسلم|مشكور|يعطيك|جزاك/.test(msg)) {
    return `العفو يا غالي في الخدمة دايماً! تشرفنا وتنورنا في ورشة ماهر البدري بشارع الحج في أي وقت.`;
  }

  // الرد الترحيبي الذكي (لو كتب أي كلام تاني بره التصنيفات)
  return `يا مرحب بيك يا غالي مع ورشة ماهر البدري لمعدات الحريق بمكة. أنا سامعك كويس، اتفضل قولي إيه طلبك بالظبط بخصوص الصيانة أو الإيجار عشان أخدمك فوراً؟\n\n📍 للعنوان اكتب "المكان" أو "العنوان"\n💰 للأسعار اكتب "الأسعار" أو "الإيجار"`;
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
      console.log('✅ Connected Easily!');
      
      // حفظ الجلسة بصيغة Base64 تلقائياً في السيرفر عشان ما تروحش تاني
      try {
        const credsRaw = fs.readFileSync(path.join(AUTH_DIR, 'creds.json'));
        console.log('--- انسخ النص اللي تحت ده وحطه في متغير CREDS_JSON باللوحة لو عاوز تثبته تماماً ---');
        console.log(credsRaw.toString('base64'));
      } catch(e){}
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
