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

// --- التعديل السحري: مسح الجلسة القديمة لمنع خطأ "تعذر" ---
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
if (fs.existsSync(AUTH_DIR)) {
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
}
// --------------------------------------------------------

const RENDER_URL = 'https://whatsapp-bridge-8lq2.onrender.com';
const BRIDGE_PORT = process.env.PORT || 3000;
const ADMIN_JID = process.env.ADMIN_JID || '966595510125@s.whatsapp.net';
let latestQr = null;
let wsConnected = false;
let aiMode = 'ai';

const SYSTEM_PROMPT = `أنت ماهر البدري، صاحب ورشة معدات حريق. 
التاريخ اليوم: ${new Date().toLocaleDateString('ar-SA')} | الوقت: ${new Date().toLocaleTimeString('ar-SA')}.
العنوان: شارع الحج، مكة المكرمة، الصنايعية الجديدة، بجوار مركز تقدير للسيارات.
قائمة الأسعار (ريال/اليوم): مكنة سن 2 بوصة 100، 3 بوصة 120، مكنة جروف 80، خواشة 50، باركود HDP 200، ضغط مياه كهرباء 50، ضغط مياه ديزل 70، HDP راس في راس 200، مولد 3 كيلو 100، مقص 8 بوصة 100.
رد بالعامية المصرية فقط وبشكل مختصر.`;

function startKeepAlive() {
  setInterval(() => {
    https.get(RENDER_URL + '/status', res => { res.resume(); }).on('error', () => {});
  }, 240000);
}

const app = express();
app.use(express.json());

// الروابط الأساسية
app.get('/status', (req, res) => res.json({ connected: wsConnected }));
app.get('/admin', (req, res) => {
  res.send(`<html><body style="background:#1a1a2e; color:white; text-align:center;">
    <h1>ماهر البدري - معدات حريق</h1>
    <h2>${wsConnected ? '✅ متصل' : '❌ غير متصل'}</h2>
    ${(!wsConnected && latestQr) ? `<img src="/qr" width="300">` : ''}
    <br><a href="/admin">تحديث الصفحة</a>
  </body></html>`);
});

app.get('/qr', async (req, res) => {
  if (!latestQr) return res.status(404).send('Wait...');
  res.setHeader('Content-Type', 'image/png');
  res.send(await QRCode.toBuffer(latestQr, { type: 'png', width: 400 }));
});

async function startBridge() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Maher-Bot', 'Chrome', '120.0'],
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, qr }) => {
    if (qr) latestQr = qr;
    if (connection === 'open') {
        wsConnected = true;
        console.log('WhatsApp Connected');
    }
    if (connection === 'close') {
        wsConnected = false;
        setTimeout(startBridge, 5000);
    }
  });
}

app.listen(BRIDGE_PORT, () => console.log('Server running...'));
startKeepAlive();
startBridge();
