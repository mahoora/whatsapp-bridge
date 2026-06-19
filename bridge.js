require('dotenv').config();
const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
let currentSock = null;
let latestQr = null;
let isConnected = false;

app.get('/', (req, res) => {
    res.send(`<h1>حالة البوت: ${isConnected ? '✅ متصل' : '❌ غير متصل'}</h1>
              <a href="/status">حالة الاتصال</a> | <a href="/qr">عرض الباركود</a>`);
});

app.get('/status', (req, res) => {
    res.json({ connected: isConnected, user: currentSock?.user?.id || null });
});

app.get('/qr', async (req, res) => {
    if (!latestQr) return res.send('جاري التحضير.. انتظر لحظات');
    const qrBuffer = await qrcode.toBuffer(latestQr);
    res.type('png').send(qrBuffer);
});

app.listen(PORT, () => console.log('Server running on port ' + PORT));

async function startBridge() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const sock = makeWASocket({ auth: state });
    currentSock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection, qr }) => {
        if (qr) latestQr = qr;
        isConnected = (connection === 'open');
    });
}
startBridge();
