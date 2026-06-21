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

// --- التعديل السحري: مسح الجلسة القديمة المعلقة عند بدء التشغيل ---
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
}
// -----------------------------------------------------------

const RENDER_URL = 'https://whatsapp-bridge-8lq2.onrender.com';

function startKeepAlive() {
  setInterval(() => {
    https.get(RENDER_URL + '/status', res => { res.resume(); }).on('error', () => {});
    saveHistory();
  }, 240000);
}
const BRIDGE_PORT = process.env.PORT || process.env.BRIDGE_PORT || 3000;
const ADMIN_JID = process.env.ADMIN_JID || '966595510125@s.whatsapp.net';
let latestQr = null;

// التعديل الثاني: دمج الوقت والتاريخ في النظام
const SYSTEM_PROMPT = `أنت ماهر البدري، صاحب ورشة معدات حريق.
تنبيه: التاريخ اليوم: ${new Date().toLocaleDateString('ar-SA')} | الوقت: ${new Date().toLocaleTimeString('ar-SA')}.
العنوان: شارع الحج، مكة المكرمة، الصنايعية الجديدة، بجوار مركز تقدير للسيارات.
قائمة المنتجات (ريال/اليوم): مكنة سن 2 بوصة 100، 3 بوصة 120، مكنة جروف 80، خواشة 50، باركود HDP 200، ضغط مياه كهرباء 50، ضغط مياه ديزل 70، HDP راس في راس 200، مولد 3 كيلو 100، مقص 8 بوصة 100.
رد بالعامية المصرية فقط وبشكل مختصر.`;

// (باقي الكود الخاص بك كما هو بالأسفل بدون تغيير)
async function callAI(systemPrompt, history, userMsg, retries = 2) {
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const msg of history) messages.push({ role: msg.role, content: msg.content });
  messages.push({ role: 'user', content: userMsg });
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('No GROQ_API_KEY');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, temperature: 0.7, max_tokens: 1024 }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (res.status === 429 && retries > 0) {
      await new Promise(r => setTimeout(r, 30000));
      return callAI(systemPrompt, history, userMsg, retries - 1);
    }
    const j = await res.json();
    return j.choices?.[0]?.message?.content || '';
  } catch (e) { clearTimeout(timer); throw e; }
}

// ... (تكملة الكود الخاص بك بالكامل كما أرسلته أنت في الرسالة السابقة) ...
// تأكد من لصق باقي الدالات (loadHistory, saveHistory, startBridge) هنا ليكون الملف مكتملاً
