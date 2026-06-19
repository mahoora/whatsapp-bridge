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

const RENDER_URL = 'https://whatsapp-bridge-8lq2.onrender.com';

function startKeepAlive() {
  setInterval(() => {
    https.get(RENDER_URL + '/status', res => { res.resume(); }).on('error', () => {});
    saveHistory();
  }, 240000);
}

const BRIDGE_PORT = process.env.PORT || 3000;
const AUTH_DIR = './auth_info';
const ADMIN_JID = process.env.ADMIN_JID || '966595510125@s.whatsapp.net';
let latestQr = null;

function loadCreds() {
  const v = process.env.CREDS_JSON;
  if (!v) return;
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(path.join(AUTH_DIR, 'creds.json'), Buffer.from(v, 'base64'));
}
loadCreds();

const SYSTEM_PROMPT = 'أنت ماهر البدري، صاحب ورشة معدات حريق. العنوان: شارع الحج، مكة المكرمة، الصنايعية الجديدة. استخدم قائمة المنتجات والأسعار المعتمدة. رد بالعامية المصرية فقط. للعملاء استخدم الاسم. للعائلة رد بأسلوبهم. ممنوع الإنجليزية.';

async function callAI(systemPrompt, history, userMsg) {
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const msg of history) messages.push({ role: msg.role, content: msg.content });
  messages.push({ role: 'user', content: userMsg });
  
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, temperature: 0.7, max_tokens: 1024 }),
      signal: controller.signal
    });
    clearTimeout(timer);
    const j = await res.json();
    return j.choices?.[0]?.message?.content || 'أهلاً يا فندم، أنا تحت أمرك، اتفضل اسأل اللي أنت عايزه.';
  } catch (e) {
    clearTimeout(timer);
    return 'يا فندم، الورشة مشغولة حالياً، كلمني على الخاص.';
  }
}

const app = express();
app.use(express.json());
let currentSock = null;
let wsConnected = false;
let aiDisabledPhones = [];

app.get('/qr', async (req, res) => {
  if (!latestQr) return res.status(404).send('Wait...');
  res.setHeader('Content-Type', 'image/png');
  res.send(await QRCode.toBuffer(latestQr, { type: 'png', width: 400 }));
});

app.listen(BRIDGE_PORT);
startKeepAlive();

async function startBridge() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Chrome', 'Chrome', '120.0'],
  });
  currentSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, qr }) => {
    if (qr) latestQr = qr;
    if (connection === 'open') wsConnected = true;
    if (connection === 'close') wsConnected = false;
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (!text) continue;

      const replyText = await callAI(SYSTEM_PROMPT, [], text);
      await sock.sendMessage(jid, { text: replyText });
    }
  });
}

startBridge();
