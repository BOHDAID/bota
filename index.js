const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');

// ============================================================
// 1. سيرفر Render
// ============================================================
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('✅ Bot Running (Ghost Mode - No Sync)'));
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// ============================================================
// 2. إعدادات
// ============================================================
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN; 
const ADMIN_ID = process.env.ADMIN_ID; 
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI).then(() => console.log('✅ DB Connected')).catch(e => console.log(e));

const User = mongoose.model('User', new mongoose.Schema({ _id: String, expiry: Number }));
const Reply = mongoose.model('Reply', new mongoose.Schema({ userId: String, keyword: String, response: String }));

const sessions = {}; 
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// ذاكرة مؤقتة لمنع إعادة طلب الرسائل (يحل مشكلة التعليق)
const msgRetryCounterCache = new Map();

// ============================================================
// 3. محرك Baileys (نظام الشبح)
// ============================================================
async function startBaileysSession(userId, ctx, phoneNumber = null) {
    const sessionDir = `./auth_info/session_${userId}`;
    
    // تنظيف إذا كان طلب ربط جديد
    if (phoneNumber && fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }), // تقليل الضغط على المعالج
        printQRInTerminal: false,
        auth: state,
        // 🔥 استخدام توقيع متصفح خفيف جداً
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        msgRetryCounterCache, // 🛑 ضروري جداً لمنع التكرار
        syncFullHistory: false, // ⛔ لا تحمل التاريخ
        markOnlineOnConnect: false, // لا تظهر متصل
        generateHighQualityLinkPreview: false, // لا تحمل صور الروابط
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 2000,
        // دالة ضرورية لمنع الانهيار عند فقدان رسالة
        getMessage: async (key) => {
            return { conversation: 'hello' };
        }
    });

    sessions[userId] = { sock };

    // 🔥 طلب رمز الربط
    if (phoneNumber && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
                await delay(2000); 
                const code = await sock.requestPairingCode(cleanNumber);
                if (ctx) ctx.reply(`🔢 **رمزك هو:**\n\`${code}\`\n\n⚠️ انسخه وضعه فوراً!`, { parse_mode: 'Markdown' });
            } catch (e) {
                if (ctx) ctx.reply('❌ فشل الطلب. انتظر دقيقة وحاول مجدداً.');
            }
        }, 3000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            // 401 = تم تسجيل الخروج أو الرمز خطأ
            if (statusCode === 401 || statusCode === 403) {
                 delete sessions[userId];
                 if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                 if (ctx) ctx.reply('⚠️ الرمز انتهى أو كان خاطئاً. حاول مجدداً.');
            }
            // 515 = إعادة تشغيل عادية (لا نرسل رسالة)
            else if (statusCode === 515) {
                startBaileysSession(userId, null);
            }
            else if (statusCode !== DisconnectReason.loggedOut) {
                startBaileysSession(userId, null);
            } else {
                delete sessions[userId];
                if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                if (ctx) ctx.reply('❌ تم تسجيل الخروج.');
            }
        } 
        else if (connection === 'open') {
            console.log(`✅ ${userId} Connected!`);
            if (ctx) ctx.reply('✅ **تم الربط بنجاح!** 🥳\nمبروك عليك.', Markup.inlineKeyboard([[Markup.button.callback('القائمة', 'main_menu')]]));
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // استقبال الرسائل
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;
        try {
            const reply = await Reply.findOne({ userId, keyword: { $regex: new RegExp(`^${text.trim()}$`, 'i') } });
            if (reply) await sock.sendMessage(msg.key.remoteJid, { text: reply.response }, { quoted: msg });
        } catch (e) {}
    });
}

// 4. UI
bot.start((ctx) => {
    ctx.reply('👋 أهلاً بك. \n⚠️ هام: استخدم بيانات الهاتف (4G) وليس الواي فاي للربط.', Markup.inlineKeyboard([
        [Markup.button.callback('📱 ربط برقم الهاتف', 'login_phone')],
        [Markup.button.callback('🗑️ تصفير', 'logout')]
    ]));
});

bot.action('login_phone', (ctx) => {
    ctx.reply('📞 هات الرقم:');
    sessions[ctx.from.id] = { step: 'WAIT_PHONE' };
});

bot.action('logout', (ctx) => {
    const userId = ctx.from.id.toString();
    const sessionDir = `./auth_info/session_${userId}`;
    if (sessions[userId]?.sock) { try{sessions[userId].sock.end()}catch(e){} }
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    delete sessions[userId];
    ctx.reply('✅ تم التصفير.');
});

bot.action('main_menu', (ctx) => {
    ctx.editMessageText('الخدمات:', Markup.inlineKeyboard([[Markup.button.callback('نشر', 'cast_btn')]]));
});

bot.on('text', async (ctx) => {
    const userId = ctx.from.id.toString();
    const text = ctx.message.text;

    if (sessions[userId]?.step === 'WAIT_PHONE') {
        const phone = text.replace(/[^0-9]/g, '');
        ctx.reply('⏳ جاري الاتصال...');
        delete sessions[userId].step;
        startBaileysSession(userId, ctx, phone);
        return;
    }

    if (text.startsWith('/add')) {
        const args = text.split('|');
        if(args.length < 2) return ctx.reply('خطأ');
        await Reply.create({ userId, keyword: args[0].replace('/add','').trim(), response: args[1].trim() });
        return ctx.reply('✅ تم.');
    }
});

bot.launch();
process.once('SIGINT', () => bot.stop());
