app.get('/admin', (req, res) => {
  const mode = aiMode === 'ai' ? '🤖' : '🖐';
  const modeText = aiMode === 'ai' ? 'رد الذكاء' : 'رد يدوي';
  
  // إضافة الوقت والتاريخ الحالي
  const currentDateTime = new Date().toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' });

  // الباركود إذا لم يكن متصلاً
  const qrHtml = (!wsConnected && latestQr) ? 
    `<div style="text-align:center; margin: 15px 0;">
      <img src="/qr" style="border: 3px solid #e94560; border-radius: 10px; max-width: 100%;" alt="QR Code">
      <p style="color:#e94560; font-weight:bold;">امسح الكود لربط الواتساب</p>
    </div>` : '';

  res.send(`
    <!DOCTYPE html>
    <html dir="rtl">
    <head>
      <meta charset="utf-8">
      <title>تحكم الويب</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        body { font-family: sans-serif; background: #1a1a2e; color: #eee; padding: 20px; max-width: 500px; margin: auto; }
        .card { background: #0f3460; padding: 15px; border-radius: 10px; margin: 15px 0; text-align: center; }
        .btn { padding: 10px 20px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 5px; display: inline-block; }
        .btn-green { background: #4caf50; color: #fff; }
        .btn-red { background: #e94560; color: #fff; }
      </style>
    </head>
    <body>
      <h2 style="text-align:center; color:#e94560;">تحكم الويب</h2>
      
      <div class="card">
        <p>${wsConnected ? '✅ البوت متصل' : '❌ غير متصل'}</p>
        <p>وضع الرد: <b>${mode} ${modeText}</b></p>
        <p style="color:#4caf50; font-size:14px;">📅 الوقت: ${currentDateTime}</p>
      </div>
      
      ${qrHtml}
      
      <div class="card" style="display:flex; justify-content:center; gap:10px;">
        <a href="/mode/ai" class="btn btn-green">🤖 تشغيل الذكاء</a>
        <a href="/mode/manual" class="btn btn-red">🖐 إيقاف (يدوي)</a>
      </div>
    </body>
    </html>
  `);
});
