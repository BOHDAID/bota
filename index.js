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
app.get('/', (req, res) => res.send('✅ Bot Running (Pairing Code Mode)'));
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

// ============================================================
// 3. محرك Baileys (نظام رمز الربط)
// ============================================================
async function startBaileysSession(userId, ctx, phoneNumber = null) {
    // إزالة الجلسة القديمة لضمان بداية نظيفة
    const sessionDir = `./auth_info/session_${userId}`;
    if (!sessions[userId] && fs.existsSync(sessionDir) && phoneNumber) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.ubuntu('Chrome'), // متصفح مستقر
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0, // انتظار لانهائي لمنع التعليق
        keepAliveIntervalMs: 10000
    });

    sessions[userId] = { sock };

    // 🔥 إذا طلب المستخدم رمز ربط (Pairing Code)
    if (phoneNumber && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                // تنسيق الرقم (حذف + والفراغات)
                let cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
                const code = await sock.requestPairingCode(cleanNumber);
                if (ctx) ctx.reply(`🔢 **رمز الربط الخاص بك:**\n\`${code}\`\n\n1. اذهب لواتساب > الأجهزة المرتبطة.\n2. اختر "الربط برقم الهاتف".\n3. ادخل هذا الرمز.`, { parse_mode: 'Markdown' });
            } catch (e) {
                if (ctx) ctx.reply('❌ حدث خطأ في طلب الرمز. تأكد أن الرقم صحيح مع المفتاح الدولي (مثال: 966500000000).');
            }
        }, 3000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            
            // تجاهل وإعادة محاولة للأخطاء الشائعة
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
            if (ctx) ctx.reply('✅ **تم الاتصال بنجاح!**\nالبوت جاهز الآن.', Markup.inlineKeyboard([[Markup.button.callback('🛠️ لوحة التحكم', 'main_menu')]]));
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

// ============================================================
// 4. واجهة المستخدم
// ============================================================
bot.start((ctx) => {
    ctx.reply('👋 **مرحباً بك**\n\nبسبب مشاكل الكيو آر، يرجى استخدام **رمز الربط**.', 
    Markup.inlineKeyboard([
        [Markup.button.callback('📱 ربط برقم الهاتف (مضمون)', 'login_phone')],
        [Markup.button.callback('❌ حذف الجلسة (Reset)', 'logout')]
    ]));
});

// طلب الرقم
bot.action('login_phone', (ctx) => {
    ctx.reply('📞 **أرسل رقم هاتفك الآن مع مفتاح الدولة.**\nمثال: `966512345678`\n(بدون علامة +)');
    // نحفظ حالة المستخدم أنه ينتظر إدخال رقم
    sessions[ctx.from.id] = { step: 'WAIT_PHONE' };
});

bot.action('logout', (ctx) => {
    const userId = ctx.from.id.toString();
    const sessionDir = `./auth_info/session_${userId}`;
    if (sessions[userId]?.sock) { try{sessions[userId].sock.end()}catch(e){} }
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    delete sessions[userId];
    ctx.reply('✅ تم تنظيف الجلسة.');
});

// القائمة الرئيسية (بعد الاتصال)
bot.action('main_menu', (ctx) => {
    ctx.editMessageText('📂 **الخدمات:**', Markup.inlineKeyboard([
        [Markup.button.callback('🤖 إضافة رد تلقائي', 'add_rep_btn')],
        [Markup.button.callback('📨 نشر رسالة', 'cast_btn')]
    ]));
});

// معالجة النصوص (إدخال الرقم أو الأوامر)
bot.on('text', async (ctx) => {
    const userId = ctx.from.id.toString();
    const text = ctx.message.text;

    // 1. إذا كان المستخدم يرسل رقمه للربط
    if (sessions[userId]?.step === 'WAIT_PHONE') {
        const phone = text.replace(/[^0-9]/g, ''); // تنظيف الرقم
        if (phone.length < 10) return ctx.reply('⚠️ رقم خاطئ، حاول مرة أخرى.');
        
        ctx.reply('⏳ جاري طلب الرمز من واتساب...');
        delete sessions[userId].step; // إنهاء الانتظار
        startBaileysSession(userId, ctx, phone);
        return;
    }

    // 2. الردود التلقائية (إضافة)
    if (text.startsWith('/add')) {
        const args = text.split('|');
        if(args.length < 2) return ctx.reply('استخدم: /add كلمة | رد');
        await Reply.create({ userId, keyword: args[0].replace('/add','').trim(), response: args[1].trim() });
        return ctx.reply('✅ تم الحفظ.');
    }

    // 3. النشر
    if (text.startsWith('/cast')) {
        const s = sessions[userId];
        if(!s?.sock) return ctx.reply('⚠️ غير متصل.');
        const msg = text.replace('/cast','').trim();
        const groups = await s.sock.groupFetchAllParticipating();
        for(let id of Object.keys(groups)) {
            await s.sock.sendMessage(id, { text: msg });
        }
        return ctx.reply('✅ تم النشر.');
    }
});

bot.launch();
process.once('SIGINT', () => bot.stop());
