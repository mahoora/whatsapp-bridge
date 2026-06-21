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
const { exec } = require('child_process');

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
  try { return JSON.parse(fs.readFileSync('./family-contacts.json')); }
  catch(e) { return []; }
}
function saveFamilyContacts(data) {
  fs.writeFileSync('./family-contacts.json', JSON.stringify(data, null, 2));
}
function loadAiDisabledPhones() {
  try { return JSON.parse(fs.readFileSync('./ai-disabled.json')); }
  catch(e) { return []; }
}
function saveAiDisabledPhones(data) {
  fs.writeFileSync('./ai-disabled.json', JSON.stringify(data, null, 2));
}

const SYSTEM_PROMPT = 'أنت ماهر البدري، صاحب ورشة معدات حريق.\n\nالعنوان: شارع الحج، مكة المكرمة، الصنايعية الجديدة، بجوار مركز تقدير للسيارات\n\n** مهم جدا: استخدم قائمة المنتجات التالية عند الرد **\n\nقائمة المنتجات للإيجار مع الأسعار (ريال/اليوم):\n1. ماكينة سن 2 بوصة ← 100 ريال/اليوم\n2. ماكينة سن 3 بوصة ← 120 ريال/اليوم\n3. مكنة جروف ← 80 ريال/اليوم\n4. خواشة مواسير ← 50 ريال/اليوم\n5. مكنة باركود HDP ← 200 ريال/اليوم\n6. مكنة ضغط مياه (كهرباء) ← 50 ريال/اليوم\n7. مكنة ضغط مياه (ديزل) ← 70 ريال/اليوم\n8. مكنة HDP راس في راس ← 200 ريال/اليوم\n9. مولد كهرباء 3 كيلو ← 100 ريال/اليوم\n10. مقص 8 بوصة لقص المواسير الحديد ← 100 ريال/اليوم\n\n** تعليمات الرد **\n- عندك معرفة عامة وشاملة في كل المجالات.\n- لو حد سلم عليك: رد التحية بأحسن منها ورحب بالعميل.\n- للعائلة: رد بنفس لهجة اللي كلمك.\n- العربية الفصحى ممنوع. رد بالعامية فقط.\n- العملاء (غير العائلة): ناديهم باسمهم.\n- استخدم اللهجة المصرية مع العملاء.\n- ردودك قصيرة قد السؤال.\n- عربي فقط. ممنوع أي إنجليزي.';

async function callAIGemini(systemPrompt, history, userMsg) {
  const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
  if (GEMINI_KEYS.length === 0) return null;
  const apiKey = GEMINI_KEYS[0];
  const contents = [];
  for (const msg of history) contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] });
  contents.push({ role: 'user', parts: [{ text: userMsg }] });
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + apiKey, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: systemPrompt }] } })
    });
    if (res.status === 200) {
      const j = await res.json();
      return j.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }
    return null;
  } catch (e) { return null; }
}

const HISTORY_FILE = './conversation-history.json';
const MAX_HISTORY = 30;
let conversationHistory = loadHistory();
let familyContacts = loadFamilyContacts();
let aiDisabledPhones = loadAiDisabledPhones();
let aiMode = 'ai';

function loadHistory() {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(HISTORY_FILE)))); }
  catch (e) { return new Map(); }
}
function saveHistory() {
  const obj = {};
  for (const [key, val] of conversationHistory) obj[key] = val;
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(obj));
}

const app = express();
app.use(express.json());
let currentSock = null;
let wsConnected = false;
let msgCount = 0;

app.get('/status', (req, res) => {
  res.json({ connected: wsConnected, user: currentSock?.user?.id || null });
});

app.get('/qr', async (req, res) => {
  if (!latestQr) return res.status(404).send('No QR available yet.');
  res.setHeader('Content-Type', 'image/png');
  res.send(await QRCode.toBuffer(latestQr, { type: 'png', width: 400 }));
});

app.get('/admin', (req, res) => {
  const mode = aiMode === 'ai' ? '🤖' : '🖐';
  const modeText = aiMode === 'ai' ? 'رد الذكاء' : 'رد يدوي';
  const currentDateTime = new Date().toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' });

  let convList = '';
  for (const [jid] of conversationHistory) {
    const phone = jid.split('@')[0].replace(/[^0-9]/g, '');
    const isOff = aiDisabledPhones.some(p => phone.includes(p) || jid.includes(p));
    convList += `<tr><td style="padding:6px 0">${phone}</td><td><a href="/disable/${encodeURIComponent(phone)}" class="btn btn-red" style="padding:4px 10px;font-size:12px">${isOff ? '🔇' : '🔊'}</a></td></tr>`;
  }

  const qrHtml = (!wsConnected && latestQr) ? `<div style="text-align:center; margin: 15px 0;"><p style="color:#e94560; font-weight:bold;">امسح الكود لربط الواتساب:</p><img src="/qr" style="border: 4px solid #e94560; border-radius: 10px; max-width: 100%;" alt="QR Code"></div>` : '';

  res.send(`<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>تحكم البوت</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:sans-serif;background:#1a1a2e;color:#eee;padding:20px 20px 80px;max-width:500px;margin:auto}h2{color:#e94560;text-align:center}.card{background:#0f3460;padding:15px;border-radius:10px;margin:15px 0;text-align:center}.btn{display:inline-block;padding:12px 24px;margin:5px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:bold;border:none;cursor:pointer;text-align:center}.btn-green{background:#4caf50;color:#fff}.btn-red{background:#e94560;color:#fff}.btn-gray{background:#555;color:#fff;opacity:0.6}input{padding:10px;border-radius:6px;border:none;width:60%;font-size:14px}table{width:100%;font-size:14px}td{padding:4px}.fab{position:fixed;bottom:20px;left:0;right:0;z-index:999;display:flex;justify-content:center;gap:0;padding:0 10px}.fab-btn{flex:1;max-width:200px;display:flex;align-items:center;justify-content:center;gap:6px;padding:14px 0;color:#fff;font-size:15px;font-weight:bold;text-decoration:none;transition:0.2s;box-shadow:0 -2px 10px rgba(0,0,0,0.3)}.fab-btn:active{opacity:0.8}.fab-left{border-radius:30px 0 0 30px}.fab-right{border-radius:0 30px 30px 0}.fab-on{background:#4caf50}.fab-off{background:#e94560}.fab-inactive{background:#555;opacity:0.5}</style></head><body><h2>🔧 تحكم البوت</h2><div class="card">${wsConnected ? '✅ متصل' : '❌ غير متصل'} | <b>${mode} ${modeText}</b><br><span style="color:#4caf50;font-size:13px">📅 ${currentDateTime}</span></div>${qrHtml}<div class="card"><form action="/disable" method="get" style="display:flex;gap:8px"><input name="num" placeholder="رقم (آخر 9 أرقام)" required><button type="submit" class="btn btn-red" style="padding:10px 16px">🔇 إيقاف</button></form></div><h3 style="margin-top:20px">💬 المحادثات</h3><table>${convList || '<tr><td style="color:#888">لا يوجد</td></tr>'}</table><div class="fab"><a href="/mode/ai" class="fab-btn fab-left ${aiMode === 'ai' ? 'fab-off' : 'fab-inactive'}">🤖 تشغيل</a><a href="/mode/manual" class="fab-btn fab-right ${aiMode === 'manual' ? 'fab-on' : 'fab-inactive'}">🖐 إيقاف</a></div><p style="text-align:center;margin-top:30px"><a href="/admin" style="color:#888;font-size:13px">تحديث الصفحة</a></p></body></html>`);
});

app.get('/mode/:value', (req, res) => {
  const v = req.params.value;
  if (v === 'ai') aiMode = 'ai';
  else if (v === 'manual') aiMode = 'manual';
  res.redirect('/admin');
});

app.get('/disable', (req, res) => {
  let num = (req.query.num || '').replace(/[^0-9]/g, '');
  if (num.length >= 5 && !aiDisabledPhones.includes(num)) { aiDisabledPhones.push(num); saveAiDisabledPhones(aiDisabledPhones); }
  res.redirect('/admin');
});

app.get('/enable/:num', (req, res) => {
  const num = decodeURIComponent(req.params.num);
  aiDisabledPhones = aiDisabledPhones.filter(p => p !== num);
  saveAiDisabledPhones(aiDisabledPhones);
  res.redirect('/admin');
});

async function startBridge() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({ printQRInTerminal: true, auth: state, logger: pino({ level: 'silent' }), browser: ['Chrome', 'Chrome', '120.0'] });
  currentSock = sock;

  sock.ev.on('creds.update', () => { saveCreds(); saveCredsToEnv(); });

  sock.ev.on('connection.update', ({ connection, qr }) => {
    if (qr) latestQr = qr;
    if (connection === 'open') wsConnected = true;
    if (connection === 'close') wsConnected = false;
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try { 
      for (const msg of messages) {
        if (!msg.key || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

        let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (!text || aiMode === 'manual') continue;

        if (!conversationHistory.has(jid)) conversationHistory.set(jid, []);
        const history = conversationHistory.get(jid);
        history.push({ role: 'user', content: text });
        
        const replyText = await callAIGemini(SYSTEM_PROMPT, history.slice(-10), text) || 'المهندس ماهر سيتواصل معك قريباً.';
        
        await sock.sendMessage(jid, { text: replyText });
        history.push({ role: 'assistant', content: replyText });
        saveHistory();
      } 
    } catch(e) { console.error(e.message); }
  });
}

app.listen(BRIDGE_PORT, () => {
  console.log('Bridge API on http://localhost:' + BRIDGE_PORT);
});
startKeepAlive();
startBridge().catch(console.error);
