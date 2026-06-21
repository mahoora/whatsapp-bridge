app.get('/admin', (req, res) => {
  const mode = aiMode === 'ai' ? '🤖' : '🖐';
  const modeText = aiMode === 'ai' ? 'رد الزكاء' : 'رد يدوي';
  const nextMode = aiMode === 'ai' ? 'manual' : 'ai';
  const disabledList = aiDisabledPhones.map(p => `<li>${p} <a href="/enable/${encodeURIComponent(p)}" style="color:#4caf50;text-decoration:none">【تفعيل】</a></li>`).join('');
  let convList = '';
  for (const [jid] of conversationHistory) {
    const phone = jid.split('@')[0].replace(/[^0-9]/g, '');
    const isOff = aiDisabledPhones.some(p => phone.includes(p) || jid.includes(p));
    convList += `<tr><td style="padding:6px 0">${phone}</td><td><a href="/disable/${encodeURIComponent(phone)}" class="btn btn-red" style="padding:4px 10px;font-size:12px">${isOff ? '🔇' : '🔊'}</a></td></tr>`;
  }

  // كود إضافة الباركود
  const qrHtml = (!wsConnected && latestQr) ? `<div style="text-align:center; margin: 15px 0;"><p style="color:#e94560; font-weight:bold;">امسح الكود لربط الواتساب:</p><img src="/qr" style="border: 4px solid #e94560; border-radius: 10px; max-width: 100%;" alt="QR Code"></div>` : '';

  res.send(`<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>تحكم البوت</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:sans-serif;background:#1a1a2e;color:#eee;padding:20px 20px 80px;max-width:500px;margin:auto}h2{color:#e94560;text-align:center}.card{background:#0f3460;padding:15px;border-radius:10px;margin:15px 0;text-align:center}.btn{display:inline-block;padding:12px 24px;margin:5px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:bold;border:none;cursor:pointer;text-align:center}.btn-green{background:#4caf50;color:#fff}.btn-red{background:#e94560;color:#fff}.btn-gray{background:#555;color:#fff;opacity:0.6}input{padding:10px;border-radius:6px;border:none;width:60%;font-size:14px}table{width:100%;font-size:14px}td{padding:4px}.fab{position:fixed;bottom:20px;left:0;right:0;z-index:999;display:flex;justify-content:center;gap:0;padding:0 10px}.fab-btn{flex:1;max-width:200px;display:flex;align-items:center;justify-content:center;gap:6px;padding:14px 0;color:#fff;font-size:15px;font-weight:bold;text-decoration:none;transition:0.2s;box-shadow:0 -2px 10px rgba(0,0,0,0.3)}.fab-btn:active{opacity:0.8}.fab-left{border-radius:30px 0 0 30px}.fab-right{border-radius:0 30px 30px 0}.fab-on{background:#4caf50}.fab-off{background:#e94560}.fab-inactive{background:#555;opacity:0.5}</style></head><body><h2>🔧 تحكم البوت</h2><div class="card">${wsConnected ? '✅ متصل' : '❌ غير متصل'} | <b>${mode} ${modeText}</b></div>${qrHtml}<div class="card"><form action="/disable" method="get" style="display:flex;gap:8px"><input name="num" placeholder="رقم (آخر 9 أرقام)" required><button type="submit" class="btn btn-red" style="padding:10px 16px">🔇 إيقاف</button></form></div><h3 style="margin-top:20px">💬 المحادثات</h3><table>${convList || '<tr><td style="color:#888">لا يوجد</td></tr>'}</table><div class="fab"><a href="/mode/ai" class="fab-btn fab-left ${aiMode === 'ai' ? 'fab-off' : 'fab-inactive'}">🤖 تشغيل</a><a href="/mode/manual" class="fab-btn fab-right ${aiMode === 'manual' ? 'fab-on' : 'fab-inactive'}">🖐 إيقاف</a></div><p style="text-align:center;margin-top:30px"><a href="/admin" style="color:#888;font-size:13px">تحديث الصفحة</a></p></body></html>`);
});
