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
const FAMILY_FILE = './family-contacts.json';

let familyContacts = [];
try { if (fs.existsSync(FAMILY_FILE)) familyContacts = JSON.parse(fs.readFileSync(FAMILY_FILE)); } catch(e) {}
function saveFamily() { fs.writeFileSync(FAMILY_FILE, JSON.stringify(familyContacts)); }

function startKeepAlive() {
  setInterval(() => {
    https.get(RENDER_URL + '/status', res => { res.resume(); }).on('error', () => {});
    saveHistory();
  }, 240000);
}
const BRIDGE_PORT = process.env.PORT || process.env.BRIDGE_PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
let latestQr = null;
let wsConnected = false;
let aiMode = 'ai';

// دالة لتنظيف الرقم للمطابقة (بتاخد آخر 9 أرقام عشان نتفادى الـ 966 و الـ 0)
function cleanPhone(phone) {
    let p = phone.replace(/[^0-9]/g, '');
    return p.slice(-9); 
}

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

function getSystemPrompt() {
  return 'أنت ماهر البدري، صاحب ورشة معدات حريق. عامية مصرية، قصيرة، ومباشرة. رحب بالعميل باسمه.';
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
    const r = await fetch('https://api.cloudflare.com/client/v4/accounts/' + CF_ACCOUNT_ID + '/ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + CF_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', messages: msgs, temperature: 0.7, max_tokens: 1024 })
    });
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
    try {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + apiKey, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: systemPrompt }] }, generationConfig: { temperature: 0.7, maxOutputTokens: 1024 } })
      });
      if (res.status === 200) { keyIndex = (idx + 1) % GEMINI_KEYS.length; const j = await res.json(); return j.candidates?.[0]?.content?.parts?.[0]?.text || ''; }
    } catch (e) {}
  }
  return null;
}

const HISTORY_FILE = './conversation-history.json';
const MAX_HISTORY = 30;
let conversationHistory = loadHistory();

function loadHistory() { try { const data = JSON.parse(fs.readFileSync(HISTORY_FILE)); return new Map(Object.entries(data)); } catch (e) { return new Map(); } }
function saveHistory() { const obj = {}; for (const [key, val] of conversationHistory) { obj[key] = val; } fs.writeFileSync(HISTORY_FILE, JSON.stringify(obj)); try { renderUpdateEnv('HISTORY_JSON', Buffer.from(JSON.stringify(obj)).toString('base64')); } catch (e) {} }

const app = express();
app.use(express.json());

app.post('/set-mode', (req, res) => { aiMode = req.body.mode; res.json({ success: true, mode: aiMode }); });
app.post('/add-family', (req, res) => { const { phone, name } = req.body; if(phone && name && !familyContacts.find(f=>cleanPhone(f.phone)===cleanPhone(phone))){ familyContacts.push({phone, name, active: true}); saveFamily(); } res.json({ success: true }); });
app.post('/toggle-family', (req, res) => { 
    const phone = req.body.phone; 
    const f = familyContacts.find(x => cleanPhone(x.phone) === cleanPhone(phone)); 
    if(f) { 
        f.active = !f.active; 
        saveFamily(); 
        console.log(`[Status] ${f.name} (Phone: ${f.phone}) is now ${f.active ? 'Active' : 'Inactive'}`);
    } 
    res.json({ success: true }); 
});
app.post('/remove-family', (req, res) => { familyContacts = familyContacts.filter(x=>cleanPhone(x.phone) !== cleanPhone(req.body.phone)); saveFamily(); res.json({ success: true }); });

app.get('/status', (req, res) => { res.json({ connected: wsConnected, mode: aiMode }); });

app.get('/', (req, res) => {
  const activeFam = familyContacts.filter(f => f.active);
  const inactiveFam = familyContacts.filter(f => !f.active);

  let actHtml = activeFam.map(f => `<div style="background:#1b5e20; padding:3px; margin:2px; border-radius:4px; font-size:10px; border:1px solid #4CAF50; display:inline-block; width:150px; text-align:center;"><b>${f.name}</b><br>${f.phone}<br><button onclick="fetch('/toggle-family', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone:'${f.phone}'})}).then(()=>location.reload())" style="cursor:pointer; background:#e53935; color:white; border:none; padding:1px 5px; border-radius:3px; margin-top:2px; font-size:9px;">إيقاف</button></div>`).join('');
  let inactHtml = inactiveFam.map(f => `<div style="background:#b71c1c; padding:3px; margin:2px; border-radius:4px; font-size:10px; border:1px solid #d32f2f; display:inline-block; width:150px; text-align:center;"><b>${f.name}</b><br>${f.phone}<br><button onclick="fetch('/toggle-family', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone:'${f.phone}'})}).then(()=>location.reload())" style="cursor:pointer; background:#4CAF50; color:white; border:none; padding:1px 5px; border-radius:3px; margin-top:2px; font-size:9px;">تشغيل</button><button onclick="fetch('/remove-family', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone:'${f.phone}'})}).then(()=>location.reload())" style="cursor:pointer; background:none; border:1px solid white; color:white; padding:1px 5px; border-radius:3px; margin-top:2px; font-size:9px; margin-right:3px;">حذف</button></div>`).join('');

  res.send(`<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>تحكم البوت</title></head>
  <body style="background:#1a1a2e;color:#eee;text-align:center;font-family:sans-serif; padding:5px;">
  <h1 style="font-size:18px;">بوت ماهر البدري</h1>
  <div style="margin:10px; font-size:16px;">الحالة: ${wsConnected ? '<span style="color:#00e676; font-weight:bold;">✅ متصل</span>' : '<span style="color:#ff5252; font-weight:bold;">❌ غير متصل</span>'}</div>
  ${!wsConnected ? '<img src="/qr" style="width:200px; border:3px solid #fff; border-radius:10px; margin-bottom:10px;">' : ''}
  <button onclick="fetch('/set-mode', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mode: '${aiMode === 'ai' ? 'manual' : 'ai'}'})}).then(()=>location.reload())" style="padding:5px; background:${aiMode === 'ai' ? 'green' : 'red'}; color:white; border:none; border-radius:4px; cursor:pointer; font-size:12px;">الوضع: ${aiMode === 'ai' ? '🤖 تلقائي' : '✋ يدوي'}</button>
  <div style="margin:10px; padding:5px; background:#252545; border-radius:5px;">
    <input id="fName" placeholder="الاسم" style="padding:2px; width:70px; font-size:12px;">
    <input id="fPhone" placeholder="الرقم" style="padding:2px; width:100px; font-size:12px;">
    <button onclick="fetch('/add-family', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:document.getElementById('fName').value, phone:document.getElementById('fPhone').value})}).then(()=>location.reload())" style="padding:2px 10px; cursor:pointer; background:#007bff; color:white; border:none; border-radius:3px; font-size:12px;">إضافة</button>
  </div>
  <div style="display:flex; justify-content:center; gap:20px; flex-wrap:wrap;">
    <div style="width:45%; background:#161625; padding:5px; border-radius:5px;"><h3 style="font-size:14px; margin:5px;">✅ شغال</h3>${actHtml}</div>
    <div style="width:45%; background:#161625; padding:5px; border-radius:5px;"><h3 style="font-size:14px; margin:5px;">🛑 موقوف</h3>${inactHtml}</div>
  </div>
  </body></html>`);
});

app.get('/qr', async (req, res) => { if (!latestQr) return res.status(404).send('Wait...'); res.setHeader('Content-Type', 'image/png'); res.send(await QRCode.toBuffer(latestQr, { type: 'png', width: 400 })); });

async function startBridge() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({ printQRInTerminal: true, auth: state, logger: pino({ level: 'silent' }), browser: ['Chrome', 'Desktop', '1.0'], markOnlineOnConnect: false });
  sock.ev.on('creds.update', () => { saveCreds(); saveCredsToEnv(); });
  sock.ev.on('connection.update', ({ connection, qr }) => { 
      if (qr) latestQr = qr; 
      if (connection === 'open') wsConnected = true; 
      if (connection === 'close') { wsConnected = false; setTimeout(startBridge, 5000); } 
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      for (const msg of messages) {
        if (!msg.key || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        const senderPhoneRaw = jid.split('@')[0];
        const cleanSender = cleanPhone(senderPhoneRaw);
        
        // --- لوج عشان تتابع في السيرفر هو بيقرأ إيه ---
        console.log(`[Incoming] Sender: ${senderPhoneRaw} (Clean: ${cleanSender})`);

        // التحقق من قائمة العائلة باستخدام المطابقة المرنة
        const family = familyContacts.find(f => cleanPhone(f.phone) === cleanSender);
        if (family && family.active === false) {
             console.log(`[Blocked] ${family.name} is inactive.`);
             continue;
        }

        let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
        if (text) {
             let replyText = await callAIGemini(getSystemPrompt(), [], text);
             await sock.sendMessage(jid, { text: replyText });
        }
      }
    } catch(e) { console.error(e); }
  });
}

app.listen(BRIDGE_PORT, () => { console.log('Server running'); startBridge(); });
startKeepAlive();
