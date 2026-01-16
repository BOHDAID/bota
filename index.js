const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const { Telegraf, Markup } = require('telegraf');
const qrcode = require('qrcode');
const mongoose = require('mongoose');
const express = require('express');

// ============================================================
// 1. سيرفر Render (Keep-Alive)
// ============================================================
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('✅ Baileys Bot is Running (Lightweight)!'));
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// ============================================================
// 2. إعدادات قاعدة البيانات
// ============================================================
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN; 
const ADMIN_ID = process.env.ADMIN_ID; 
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
    .then(() => {
        console.log('✅ MongoDB Connected!');
        restoreSessions(); 
    })
    .catch(err => console.error('❌ MongoDB Error:', err));

const userSchema = new mongoose.Schema({ _id: String, expiry: Number });
const replySchema = new mongoose.Schema({ userId: String, keyword: String, response: String });
const historySchema = new mongoose.Schema({ _id: String, date: Number });

const User = mongoose.model('User', userSchema);
const Reply = mongoose.model('Reply', replySchema);
const History = mongoose.model('History', historySchema);

// متغيرات الذاكرة
const sessions = {}; 
const userStates = {}; 

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
bot.catch((err) => console.log('Telegraf Error:', err));

// استعادة الجلسات
async function restoreSessions() {
    const authPath = './auth_info';
    if (fs.existsSync(authPath)) {
        const folders = fs.readdirSync(authPath).filter(f => f.startsWith('session_'));
        for (const folder of folders) {
            const userId = folder.replace('session_', '');
            try {
                const user = await User.findById(userId);
                if (user && user.expiry > Date.now()) {
                    startBaileysSession(userId, null);
                }
            } catch (e) {}
        }
    }
}

// ============================================================
// 3. محرك Baileys (بديل المتصفح)
// ============================================================
async function startBaileysSession(userId, ctx) {
    if (sessions[userId]) return;

    if (ctx) ctx.reply('🚀 **جاري إنشاء الاتصال المباشر...**');

    // إعداد مجلد المصادقة
    const { state, saveCreds } = await useMultiFileAuthState(`./auth_info/session_${userId}`);

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.macOS('Desktop'), // الظهور كمتصفح عادي
        syncFullHistory: false // ⛔ منع تحميل الرسائل القديمة (توفير الرام)
    });

    sessions[userId] = { sock, status: 'CONNECTING' };

    // إدارة أحداث الاتصال
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && ctx) {
            // إرسال كيو آر للتليجرام
            try {
                const buffer = await qrcode.toBuffer(qr);
                await ctx.deleteMessage().catch(()=>{});
                await ctx.replyWithPhoto({ source: buffer }, { caption: '📱 **امسح الرمز (Baileys)**\nسريع وخفيف جداً.' });
            } catch (e) {}
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed due to ${lastDisconnect.error}, reconnecting: ${shouldReconnect}`);
            
            delete sessions[userId];
            
            if (shouldReconnect) {
                startBaileysSession(userId, null); // إعادة اتصال تلقائي
            } else {
                if (ctx) ctx.reply('❌ تم تسجيل الخروج.');
                // حذف ملفات الجلسة
                fs.rmSync(`./auth_info/session_${userId}`, { recursive: true, force: true });
            }
        } else if (connection === 'open') {
            console.log('✅ Opened connection');
            sessions[userId].status = 'READY';
            if (ctx) ctx.reply('✅ **تم الاتصال بنجاح!**');
        }
    });

    // حفظ الاعتمادات
    sock.ev.on('creds.update', saveCreds);

    // استقبال الرسائل (للرد التلقائي)
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (!textMessage) return;

        try {
            // البحث عن رد في القاعدة
            const reply = await Reply.findOne({ userId: userId, keyword: textMessage });
            if (reply) {
                await sock.sendMessage(remoteJid, { text: reply.response });
            }
        } catch (e) {
            console.log('Reply error', e);
        }
    });
}

// ============================================================
// 4. أزرار وأوامر التيليجرام
// ============================================================

bot.start((ctx) => {
    ctx.reply('👋 مرحباً بك في بوت واتساب الخفيف (Baileys).\nاضغط أدناه للبدء.', 
        Markup.inlineKeyboard([[Markup.button.callback('🔗 ربط واتساب', 'connect_wa')]]));
});

bot.action('connect_wa', (ctx) => {
    const userId = ctx.from.id.toString();
    startBaileysSession(userId, ctx);
});

// خدمة جلب الجروبات
bot.command('groups', async (ctx) => {
    const userId = ctx.from.id.toString();
    const s = sessions[userId];
    if (!s || s.status !== 'READY') return ctx.reply('⚠️ غير متصل.');

    try {
        const groups = await s.sock.groupFetchAllParticipating();
        const groupList = Object.values(groups).map(g => `▫️ ${g.subject}`).join('\n');
        ctx.reply(`📂 **الجروبات:**\n\n${groupList.substring(0, 4000)}`);
    } catch (e) {
        ctx.reply('خطأ في جلب الجروبات.');
    }
});

// خدمة النشر (Broadcast)
bot.command('cast', async (ctx) => {
    const userId = ctx.from.id.toString();
    const s = sessions[userId];
    if (!s || s.status !== 'READY') return ctx.reply('⚠️ غير متصل.');

    // مثال بسيط للنشر: يطلب النص ثم يرسل لكل الجروبات
    // (يمكن تطويره ليكون بأزرار مثل الكود السابق)
    const text = ctx.message.text.replace('/cast ', '');
    if (!text || text === '/cast') return ctx.reply('أكتب الرسالة بعد الأمر.\nمثال: /cast مرحبا');

    ctx.reply('⏳ جاري النشر...');
    const groups = await s.sock.groupFetchAllParticipating();
    const groupIds = Object.keys(groups);

    let count = 0;
    for (const id of groupIds) {
        try {
            await s.sock.sendMessage(id, { text: text });
            count++;
            await new Promise(r => setTimeout(r, 1000)); // انتظار ثانية
        } catch (e) {}
    }
    ctx.reply(`✅ تم النشر في ${count} جروب.`);
});

// إضافة رد تلقائي
bot.command('addreply', async (ctx) => {
    // تنسيق: /addreply كلمة | رد
    const args = ctx.message.text.split('|');
    if (args.length < 2) return ctx.reply('خطأ. التنسيق:\n/addreply كلمة | الرد');
    
    const keyword = args[0].replace('/addreply ', '').trim();
    const response = args[1].trim();
    const userId = ctx.from.id.toString();

    await Reply.create({ userId, keyword, response });
    ctx.reply('✅ تم حفظ الرد.');
});

bot.launch();
process.once('SIGINT', () => bot.stop());
