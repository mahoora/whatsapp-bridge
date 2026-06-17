import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers 
} from "@whiskeysockets/baileys";
import pino from "pino";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = pino({
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname"
    }
  }
});

const OLLAMA_API = process.env.OLLAMA_API || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "mistral";

logger.info(`🔧 Connecting to Ollama at ${OLLAMA_API} with model: ${OLLAMA_MODEL}`);

// دالة للحصول على رد ذكي من Ollama
async function getAIResponse(message) {
  try {
    logger.debug(`📤 Sending to Ollama: ${message.substring(0, 50)}...`);
    
    const response = await axios.post(
      `${OLLAMA_API}/api/generate`,
      {
        model: OLLAMA_MODEL,
        prompt: message,
        stream: false
      },
      { timeout: 60000 }
    );

    const reply = response.data.response.trim();
    logger.debug(`📥 Ollama response: ${reply.substring(0, 50)}...`);
    return reply;
  } catch (error) {
    logger.error(`❌ خطأ في الاتصال بـ Ollama: ${error.message}`);
    return "معذرة، الخدمة غير متاحة حالياً. حاول لاحقاً.";
  }
}

// بناء الـ prompt للـ AI
function buildPrompt(text, clientName) {
  return `أنت ماهر البدري، صاحب ورشة صيانة وإيجار معدات الحريق والسباكة في مكة.
تتحدث بالعامية المصرية فقط.

قائمة المنتجات للإيجار:
- ماكينة سن 2 بوصة: 100 ريال/اليوم
- ماكينة سن 3 بوصة: 120 ريال/اليوم
- مكنة جروف: 80 ريال/اليوم
- خواشة مواسير: 50 ريال/اليوم
- مكنة باركود HDP: 200 ريال/اليوم
- مكنة ضغط مياه (كهرباء): 50 ريال/اليوم
- مكنة ضغط مياه (ديزل): 70 ريال/اليوم
- مكنة HDP راس في راس: 200 ريال/اليوم
- مولد كهرباء 3 كيلو: 100 ريال/اليوم
- مقص 8 بوصة: 100 ريال/اليوم

التعليمات:
- ناد العميل باسمه (يا أستاذ ${clientName})
- إذا سأل عن منتج: قول اسمه وسعره من القائمة
- إذا طلب تصليح: قول "موجود كل حاجة إن شاء الله، جيبها الورشة"
- ردودك مختصرة ومفيدة
- ممنوع أي إنجليزي
- إذا بدأ بالسلام: رد التحية بأحسن منها

العميل ${clientName}: ${text}
ماهر البدري:`;
}

// إنشاء البوت
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.ubuntu("Chrome"),
    printQRInTerminal: true,
    syncFullHistory: false,
    maxMsgsInMemory: 100
  });

  // عند الاتصال
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      const shouldReconnect =
        (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;

      logger.info(
        shouldReconnect ? "⏱️ اتصال مقطوع، إعادة الاتصال..." : "🚪 تم تسجيل الخروج"
      );

      if (shouldReconnect) {
        setTimeout(() => startBot(), 3000);
      }
    } else if (connection === "open") {
      logger.info("✅ البوت متصل بـ WhatsApp!");
    }
  });

  // حفظ البيانات
  sock.ev.on("creds.update", saveCreds);

  // استقبال الرسائل
  sock.ev.on("messages.upsert", async (m) => {
    const message = m.messages[0];

    if (!message.message) return;
    if (message.key.fromMe) return;

    const sender = message.key.remoteJid;
    const text = message.message.conversation || 
                 message.message.extendedTextMessage?.text || "";

    if (!text.trim()) return;

    const senderName = message.pushName || "الزميل";

    logger.info(`📨 رسالة من ${senderName} (${sender}): ${text.substring(0, 50)}`);

    try {
      // بناء الـ prompt
      const prompt = buildPrompt(text, senderName);
      
      // الحصول على رد ذكي
      logger.info("🤔 البوت يفكر...");
      const aiResponse = await getAIResponse(prompt);

      // إرسال الرد
      await sock.sendMessage(sender, { text: aiResponse });
      logger.info(`✅ تم الرد: ${aiResponse.substring(0, 50)}...`);
    } catch (error) {
      logger.error(`❌ خطأ في الرد: ${error.message}`);
      try {
        await sock.sendMessage(sender, { 
          text: "معذرة، حدثت مشكلة. حاول لاحقاً." 
        });
      } catch {}
    }
  });

  await sock.initialize();
}

// بدء البوت
startBot().catch((err) => {
  logger.error(`❌ خطأ في بدء البوت: ${err.message}`);
  process.exit(1);
});
