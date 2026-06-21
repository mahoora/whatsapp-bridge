require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const QRCode = require('qrcode');
const https = require('https');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const RENDER_URL = 'https://whatsapp-bridge-8lq2.onrender.com';
const IGNORED_FILE = './ai-disabled.json';
const FAMILY_FILE = './family-contacts.json';

let ignoredNumbers = [];
try { if (fs.existsSync(IGNORED_FILE)) ignoredNumbers = JSON.parse(fs.readFileSync(IGNORED_FILE)); } catch(e) {}
function saveIgnored() { fs.writeFileSync(IGNORED_FILE, JSON.stringify(ignoredNumbers)); }

let familyContacts = [];
try { if (fs.existsSync(FAMILY_FILE)) familyContacts = JSON.parse(fs.readFileSync(FAMILY_FILE)); } catch(e) {}
function saveFamily() { fs.writeFileSync(FAMILY_FILE, JSON.stringify(familyContacts)); }

const BRIDGE_PORT = process.env.PORT || process.env.BRIDGE_PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
let latestQr = null;
let wsConnected = false;
let aiMode = 'ai';

// وظيفة حفظ الكود
function saveCredsToEnv() {
  const p = path.join(AUTH_DIR, 'creds.json');
  if (!fs.existsSync(p)) return;
  const val = fs.readFileSync(p).toString('base64');
  const apiKey = process.env.RENDER_API_KEY;
  const sid = process.env.RENDER_SERVICE_ID;
  if (!apiKey || !sid) return;
  const opts = {
    hostname: 'api.render.com', path: '/v1/services/' + sid + '/env-vars/CREDS_JSON',
    method: 'PUT', timeout: 10000,
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' }
  };
  const req = https.request(opts, (res) => { res.resume(); });
  req.write(JSON.stringify({ value: val }));
  req.end();
}

function getSystemPrompt() {
  return 'أنت ماهر البدري، صاحب ورشة معدات حريق في مكة المكرمة.\nتعليمات الرد: عامية مصرية، قصيرة، ومباشرة.';
}

const HISTORY_FILE = './conversation-history.json';
let conversationHistory = new Map();
try { conversationHistory = new Map(Object.entries(JSON.parse(fs.readFileSync(HISTORY_FILE)))); } catch(e) {}
function saveHistory() { fs.writeFileSync(HISTORY_FILE, JSON.stringify(Object.fromEntries(conversationHistory))); }

const app = express();
app.use(express.json());

// Routes
app.post('/set-mode', (req, res) => { aiMode = req.body.mode; res.json({ success: true }); });
app.post('/add-family', (req, res) => { 
    const { phone, name } = req.body; 
    if(phone && name && !familyContacts.find(f=>f.phone===phone)){ 
        familyContacts.push({phone, name, active: true}); 
        saveFamily(); 
    } 
    res.json({ success: true }); 
});
app.post('/toggle-family', (req, res) => { 
    const phone = req.body.phone; 
    const f = familyContacts.find(x=>x.phone===phone); 
    if(f) f.active = !f.active; 
    saveFamily(); 
    res.json({ success: true }); 
});
app.post('/remove-family', (req, res) => { 
    familyContacts = familyContacts.filter(x=>x.phone !== req.body.phone); 
    saveFamily(); 
    res.json({ success: true }); 
});

app.get('/', (req, res) => {
  const activeFam = familyContacts.filter(f => f.active);
  const stoppedFam = familyContacts.filter(f => !f.active);

  const card = (f, isActive) => `<div style="background:${isActive ? '#1b5e20' : '#b71c1c'}; padding:8px; margin:5px; border-radius:8px; border:1px solid ${isActive ? '#4CAF50' : '#d32f2f'}; width:200px;">
    <div style="font-weight:bold; margin-bottom:5px;">${f.name}</div>
    <div style="font-size:12px; margin-bottom:5px;">${f.phone}</div>
    <button onclick="fetch('/toggle-family', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone:'${f.phone}'})}).then(()=>location.reload())" style="cursor:pointer; background:#fff; color:#000; border:none; padding:3px 10px; border-radius:4px; font-size:12px;">${isActive ? 'إيقاف' : 'تشغيل'}</button>
    ${!isActive ? `<button onclick="fetch('/remove-family', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone:'${f.phone}'})}).then(()=>location.reload())" style="cursor:pointer; background:#000; color:#fff; border:none; padding:3px 10px; border-radius:4px; font-size:12px; margin-right:5px;">حذف</button>` : ''}
  </div>`;

  res.send(`<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>تحكم ماهر البدري</title></head>
  <body style="background:#0f0f1a; color:#eee; text-align:center; font-family:sans-serif;">
  <h1>بوت ماهر البدري</h1>
  <h2>الحالة: ${wsConnected ? '✅ متصل' : '❌ غير متصل'}</h2>
  ${!wsConnected && latestQr ? `<img src="/qr" style="width:250px; border:3px solid #fff; border-radius:10px;">` : ''}
  
  <div style="margin:20px; padding:15px; background:#1c1c2e; border-radius:10px; display:inline-block;">
    <input id="fName" placeholder="الاسم" style="padding:8px; width:100px;">
    <input id="fPhone" placeholder="الرقم" style="padding:8px; width:120px;">
    <button onclick="fetch('/add-family', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:document.getElementById('fName').value, phone:document.getElementById('fPhone').value})}).then(()=>location.reload())" style="padding:8px 15px; background:#007bff; color:#fff; border:none; cursor:pointer;">إضافة للعائلة</button>
  </div>

  <div style="display:flex; justify-content:center; gap:20px; padding:20px;">
    <div style="text-align:center;"><h3>✅ شغال (يمين)</h3>${activeFam.map(f => card(f, true)).join('')}</div>
    <div style="text-align:center;"><h3>🛑 موقوف (شمال)</h3>${stoppedFam.map(f => card(f, false)).join('')}</div>
  </div>
  </body></html>`);
});

app.get('/qr', async (req, res) => { if (!latestQr) return res.status(404).send('...'); res.setHeader('Content-Type', 'image/png'); res.send(await QRCode.toBuffer(latestQr, { type: 'png' })); });

async function startBridge() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), browser: ['Chrome', 'Desktop', '1.0'] });
  sock.ev.on('creds.update', () => { saveCreds(); saveCredsToEnv(); });
  sock.ev.on('connection.update', ({ connection, qr }) => { if (qr) latestQr = qr; if (connection === 'open') wsConnected = true; if (connection === 'close') { wsConnected = false; setTimeout(startBridge, 5000); } });
  
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      const senderPhone = jid.split('@')[0].replace(/[^0-9]/g, '');
      const family = familyContacts.find(f => f.phone === senderPhone);
      
      // المنطق الصارم: إذا كان الرقم في قائمة العائلة وحالته active = false، نتجاهله تماماً
      if (family && family.active === false) continue;
      
      // ... باقي كود الرد والذكاء الاصطناعي
      let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (!text) continue;
      
      // الرد (مثال بسيط)
      await sock.sendMessage(jid, { text: 'أهلاً بك، تم استلام رسالتك.' });
    }
  });
}

app.listen(BRIDGE_PORT, () => { startBridge(); });
