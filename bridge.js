require('dotenv').config();
const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;
let latestQr = null;
let isConnected = false;

// الصفحة الرئيسية لمنع ظهور Cannot GET /
app.get('/', (req, res) => {
    res.send(`
        <h1>مرحباً يا ماهر البدري</h1>
        <p>حالة البوت: ${isConnected ? '✅ متصل' : '❌ غير متصل'}</p>
        <a href="/qr">اضغط هنا لعرض الباركود للربط</a>
    `);
});

// صفحة الباركود
app.get('/qr', async (req, res) => {
    if (!latestQr) return res.send('جاري تحضير الباركود.. انتظر لحظات وعيد تحميل الصفحة');
    res.type('png').send(await qrcode.toBuffer(latestQr));
});

// دالة الرد بالذكاء الاصطناعي
async function getAIReply(text) {
    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'system', content: 'أنت ماهر البدري، صاحب ورشة معدات حريق. رد بالعامية المصرية.' }, { role: 'user', content: text }],
                temperature: 0.7
            })
        });
        const data = await response.json();
        return data.choices[0].message.content;
    } catch (e) { return "الورشة مشغولة حالياً، سأرد عليك لاحقاً."; }
}

async function startBridge() {
    const authPath = process.env.AUTH_DIR || './auth_info';
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    
    // تعريف المتصفح لإصلاح خطأ 515
    const sock = makeWASocket({ 
        auth: state, 
        printQRInTerminal: true, 
        browser: ['Chrome', 'Windows', '10.0'] 
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection, qr }) => {
        if (qr) latestQr = qr;
        isConnected = (connection === 'open');
        if (isConnected) console.log('تم الاتصال بنجاح!');
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (text) {
            const reply = await getAIReply(text);
            await sock.sendMessage(msg.key.remoteJid, { text: reply });
        }
    });
}

app.listen(PORT, () => console.log('السيرفر يعمل على بورت ' + PORT));
startBridge();
