require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const QRCode = require('qrcode');
const https = require('https');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { exec } = require('child_process');

const RENDER_URL = 'https://whatsapp-bridge-8lq2.onrender.com';
const IGNORED_FILE = './ai-disabled.json';
const FAMILY_FILE = './family-contacts.json';

let ignoredNumbers = [];
try { if (fs.existsSync(IGNORED_FILE)) ignoredNumbers = JSON.parse(fs.readFileSync(IGNORED_FILE)); } catch(e) {}
function saveIgnored() { fs.writeFileSync(IGNORED_FILE, JSON.stringify(ignoredNumbers)); }

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
  const now = new Date();
  const time = now.toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString('ar-SA', { timeZone: 'Asia/Riyadh' });

  return 'أنت ماهر البدري، صاحب ورشة معدات حريق.\n' +
  'التاريخ والوقت الحالي في مكة المكرمة: ' + date + ' الساعة ' + time + '\n\n' +
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
  'تعليمات الرد: عامية مصرية، قصيرة، ومباشرة. رحب بالعميل باسمه.';
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
let aiMode = 'ai';

function transcribeAudio(audioBuffer) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', 'ar');
    const opts = { hostname: 'api.groq.com', path: '/openai/v1/audio/transcriptions', method: 'POST', timeout: 30000, headers: form.getHeaders({ 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY }) };
    const req = https.request(opts, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { const j = JSON.parse(b); resolve(j.text || ''); } catch (e) { reject(e); } }); });
    req.on('error', reject);
    form.pipe(req);
  });
}

function loadHistory() { try { const data = JSON.parse(fs.readFileSync(HISTORY_FILE)); return new Map(Object.entries(data)); } catch (e) { return new Map(); } }
function saveHistory() { const obj = {}; for (const [key, val] of conversationHistory) { obj[key] = val; } fs.writeFileSync(HISTORY_FILE, JSON.stringify(obj)); try { renderUpdateEnv('HISTORY_JSON', Buffer.from(JSON.stringify(obj)).toString('base64')); } catch (e) {} }

const app = express();
app.use(express.json());
let currentSock = null;
let wsConnected = false;
let restartTimer = null;

// مسارات التحكم
app.post('/set-mode', (req, res) => { aiMode = req.body.mode; res.json({ success: true, mode: aiMode }); });
app.post('/add-ignore', (req, res) => { const phone = req.body.phone; if(phone && !ignoredNumbers.includes(phone)){ ignoredNumbers.push(phone); saveIgnored(); } res.json({ success: true }); });
app.post('/remove-ignore', (req, res) => { ignoredNumbers = ignoredNumbers.filter(n => n !== req.body.phone); saveIgnored(); res.json({ success: true }); });
app.post('/add-family', (req, res) => { const { phone, name } = req.body; if(phone && name && !familyContacts.find(f=>f.phone===phone)){ familyContacts.push({phone, name, active: false}); saveFamily(); } res.json({ success: true }); }); // افتراضي موقوف
app.post('/toggle-family', (req, res) => { const phone = req.body.phone; const f = familyContacts.find(x=>x.phone===phone); if(f) f.active = !f.active; saveFamily(); res.json({ success: true }); });
app.post('/remove-family', (req, res) => { familyContacts = familyContacts.filter(x=>x.phone !== req.body.phone); saveFamily(); res.json({ success: true }); });

app.get('/status', (req, res) => { res.json({ connected: wsConnected, mode: aiMode }); });

app.get('/', (req, res) => {
  const activeFam = familyContacts.filter(f => f.active);
  const inactiveFam = familyContacts.filter(f => !f.active);

  let ignHtml = ignoredNumbers.map(n => `<li style="margin:3px; font-size:12px;">${n} <button onclick="fetch('/remove-ignore', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone:'${n}'})}).then(()=>location.reload())" style="color:red; cursor:pointer;">حذف</button></li>`).join('');
  
  let actHtml = activeFam.map(f => `<div style="background:#1b5e20; padding:5px; margin:5px; border-radius:5px; font-size:13px;"><b>${f.name}</b> (${f.phone}) <button onclick="fetch('/toggle-family', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone:'${f.phone}'})}).then(()=>location.reload())">إيقاف</button></div>`).join('');
  let inactHtml = inactiveFam.map(f => `<div style="background:#b71c1c; padding:5px; margin:5px; border-radius:5px; font-size:13px;"><b>${f.name}</b> (${f.phone}) <button onclick="fetch('/toggle-family', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone:'${f.phone}'})}).then(()=>location.reload())">تشغيل</button> <button onclick="fetch('/remove-family', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone:'${f.phone}'})}).then(()=>location.reload())">حذف</button></div>`).join('');

  res.send(`<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>تحكم البوت</title></head>
  <body style="background:#1a1a2e;color:#eee;text-align:center;font-family:sans-serif;">
  <h1>بوت ماهر البدري</h1>
  <button onclick="fetch('/set-mode', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mode: '${aiMode === 'ai' ? 'manual' : 'ai'}'})}).then(()=>location.reload())" style="padding:15px; background:${aiMode === 'ai' ? 'green' : 'red'}; color:white; border:none; border-radius:10px; cursor:pointer;">الوضع: ${aiMode === 'ai' ? '🤖 تلقائي' : '✋ يدوي'}</button>
  
  <div style="margin-top:20px;">
    <h3>إضافة رقم للعائلة:</h3>
    <input id="fName" placeholder="الاسم" style="padding:5px;">
    <input id="fPhone" placeholder="الرقم" style="padding:5px;">
    <button onclick="fetch('/add-family', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:document.getElementById('fName').value, phone:document.getElementById('fPhone').value})}).then(()=>location.reload())" style="padding:5px; cursor:pointer;">إضافة</button>
  </div>

  <div style="display:flex; justify-content:center; gap:20px; margin-top:20px; flex-wrap:wrap;">
    <div style="width:45%; min-width:300px;"><h3>موقوف (شمال)</h3>${inactHtml}</div>
    <div style="width:45%; min-width:300px;"><h3>شغال (يمين)</h3>${actHtml}</div>
  </div>

  <div style="margin-top:40px; border-top:1px solid #444; padding-top:20px;">
    <h3>قائمة التجاهل:</h3>
    <input id="iPhone" placeholder="الرقم" style="padding:5px;"><button onclick="fetch('/add-ignore', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone:document.getElementById('iPhone').value})}).then(()=>location.reload())" style="padding:5px; cursor:pointer;">إضافة</button>
    <ul style="list-style:none; padding:0;">${ignHtml}</ul>
  </div>
  </body></html>`);
});

app.get('/qr', async (req, res) => { if (!latestQr) return res.status(404).send('Wait...'); res.setHeader('Content-Type', 'image/png'); res.send(await QRCode.toBuffer(latestQr, { type: 'png', width: 400 })); });

async function startBridge() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({ printQRInTerminal: true, auth: state, logger: pino({ level: 'silent' }), browser: ['Chrome', 'Desktop', '1.0'], markOnlineOnConnect: false });
  currentSock = sock;
  sock.ev.on('creds.update', () => { saveCreds(); saveCredsToEnv(); });
  sock.ev.on('connection.update', ({ connection, qr }) => { if (qr) latestQr = qr; if (connection === 'open') wsConnected = true; if (connection === 'close') { wsConnected = false; if (!restartTimer) restartTimer = setTimeout(() => { restartTimer = null; startBridge(); }, 5000); } });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      for (const msg of messages) {
        if (!msg.key || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

        let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
        const senderPhone = jid.split('@')[0].replace(/[^0-9]/g, '');
        
        if (ignoredNumbers.includes(senderPhone)) continue;
        const family = familyContacts.find(f => f.phone === senderPhone);
        if (family && !family.active) continue;

        if (msg.message?.audioMessage && !text) {
          try { const buffer = await downloadMediaMessage(msg, 'buffer', {}); text = await transcribeAudio(buffer); } catch (e) { continue; }
        }
        if (!text) continue;

        const tlow = text.trim();
        if (tlow === 'يدوي') { aiMode = 'manual'; await sock.sendMessage(jid, { text: '✅ تم التحويل للرد اليدوي.' }); continue; }
        if (tlow === 'تلقائي') { aiMode = 'ai'; await sock.sendMessage(jid, { text: '✅ تم التحويل للتلقائي.' }); continue; }
        if (aiMode === 'manual') continue;

        if (!conversationHistory.has(jid)) conversationHistory.set(jid, []);
        const history = conversationHistory.get(jid);
        history.push({ role: 'user', content: text });
        if (history.length > MAX_HISTORY) history.shift();
        
        let familyContext = family ? ` [هذا الرقم من العائلة: ${family.name}]` : '';
        let replyText = await callAIGemini(getSystemPrompt(), history.slice(-10), familyContext + '\n' + text);
        if (!replyText) replyText = await callCloudflare(getSystemPrompt(), history.slice(-10), familyContext + '\n' + text);

        if (!replyText) replyText = 'آسف، كلمني على الخاص.';
        await sock.sendMessage(jid, { text: replyText });
        history.push({ role: 'assistant', content: replyText });
        saveHistory();
      }
    } catch(e) { console.error(e); }
  });
}

app.listen(BRIDGE_PORT, () => { console.log('Server running'); startBridge(); });
startKeepAlive();
