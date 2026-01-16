const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');

// 1. Render Server
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('✅ Bot Ready (Firefox Mode)'));
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// 2. Settings
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN; 
const ADMIN_ID = process.env.ADMIN_ID; 
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI).then(() => console.log('✅ DB Connected')).catch(e => console.log(e));

const User = mongoose.model('User', new mongoose.Schema({ _id: String, expiry: Number }));
const Reply = mongoose.model('Reply', new mongoose.Schema({ userId: String, keyword: String, response: String }));

const sessions = {}; 
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// 3. Baileys Engine
async function startBaileysSession(userId, ctx, phoneNumber = null) {
    const sessionDir = `./auth_info/session_${userId}`;
    
    // تنظيف إذا كان طلب جديد
    if (phoneNumber && fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        // 🔥 التغيير هنا: استخدام فايرفوكس لأنه أبطأ وأكثر صبراً في الربط
        browser: ['Ubuntu', 'Firefox', '20.0.04'],
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 5000
    });

    sessions[userId] = { sock };

    // 🔥 طلب الكود مع تأخير بسيط لضمان استقرار الاتصال
    if (phoneNumber && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
                // ننتظر 3 ثواني إضافية للتأكد من أن السيرفر متصل تماماً
                await delay(3000); 
                const code = await sock.requestPairingCode(cleanNumber);
                if (ctx) ctx.reply(`🔢 **رمز الربط:**\n\`${code}\`\n\n⚠️ انسخ الرمز بسرعة وضعه في واتساب.`, { parse_mode: 'Markdown' });
            } catch (e) {
                if (ctx) ctx.reply('❌ فشل طلب الرمز. هل الرقم صحيح؟');
            }
        }, 5000); // تأخير 5 ثواني قبل الطلب
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                startBaileysSession(userId, null);
            } else {
                delete sessions[userId];
                if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                if (ctx) ctx.reply('❌ تم تسجيل الخروج.');
            }
        } 
        else if (connection === 'open') {
            console.log(`✅ ${userId} Connected!`);
            if (ctx) ctx.reply('✅ **تم الربط بنجاح!** 🥳', Markup.inlineKeyboard([[Markup.button.callback('القائمة', 'main_menu')]]));
        }
    });

    sock.ev.on('creds.update', saveCreds);

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
    ctx.reply('👋 أهلاً بك. اختر الطريقة:', Markup.inlineKeyboard([
        [Markup.button.callback('📱 ربط برقم الهاتف', 'login_phone')],
        [Markup.button.callback('🗑️ تصفير (Reset)', 'logout')]
    ]));
});

bot.action('login_phone', (ctx) => {
    ctx.reply('📞 أرسل رقمك الآن (مثال: 966500000000)');
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
        ctx.reply('⏳ لحظة...');
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
