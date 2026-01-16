const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const { Telegraf, Markup } = require('telegraf');
const qrcode = require('qrcode');
const mongoose = require('mongoose');
const express = require('express');

// ============================================================
// 1. سيرفر Render (لإبقاء البوت نشطاً)
// ============================================================
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('✅ Baileys Bot Running (Auto-Fix Mode)'));
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// ============================================================
// 2. إعدادات قاعدة البيانات والتلجرام
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

// استعادة الجلسات عند إعادة تشغيل السيرفر
async function restoreSessions() {
    const authPath = './auth_info';
    if (fs.existsSync(authPath)) {
        const folders = fs.readdirSync(authPath).filter(f => f.startsWith('session_'));
        for (const folder of folders) {
            const userId = folder.replace('session_', '');
            try {
                const user = await User.findById(userId);
                // فقط إذا كان المستخدم مشتركاً
                if (user && user.expiry > Date.now()) {
                    console.log(`🔄 Restoring session for ${userId}`);
                    startBaileysSession(userId, null);
                }
            } catch (e) {}
        }
    }
}

// ============================================================
// 3. محرك Baileys (النظام الذكي)
// ============================================================
async function startBaileysSession(userId, ctx) {
    // منع تكرار الجلسات النشطة
    if (sessions[userId] && sessions[userId].status === 'CONNECTING') return;

    if (ctx) ctx.reply('🚀 **جاري بدء الاتصال...**');

    const sessionDir = `./auth_info/session_${userId}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }), // كتم السجلات لتوفير الذاكرة
        printQRInTerminal: false,
        auth: state,
        // استخدام توقيع متصفح حقيقي لتجنب الحظر والمشاكل
        browser: Browsers.ubuntu('Chrome'), 
        syncFullHistory: false, // ⛔ هام: منع تحميل الرسائل القديمة لتوفير الرام
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: false,
        retryRequestDelayMs: 250
    });

    sessions[userId] = { sock, status: 'CONNECTING' };

    // --- إدارة أحداث الاتصال ---
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // إرسال كيو آر كود (QR)
        if (qr && ctx) {
            try {
                const buffer = await qrcode.toBuffer(qr);
                await ctx.deleteMessage().catch(()=>{});
                await ctx.replyWithPhoto({ source: buffer }, { 
                    caption: '📱 **امسح الرمز (Baileys)**\nنظام خفيف وسريع.',
                    ...Markup.inlineKeyboard([[Markup.button.callback('🔄 طلب رمز جديد', 'retry_login')]])
                });
            } catch (e) {}
        }

        // حالة الانفصال أو الإغلاق
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const errorMsg = lastDisconnect?.error?.message || 'Unknown';

            console.log(`❌ Connection closed for ${userId}: ${errorMsg} (Code: ${statusCode})`);
            
            delete sessions[userId];

            // 🛡️ المنطق الذكي للإصلاح التلقائي 🛡️
            const isCorrupt = 
                errorMsg.includes('Connection Failure') || 
                errorMsg.includes('Stream Errored') ||
                errorMsg.includes('Restart Required') ||
                statusCode === DisconnectReason.restartRequired;

            if (isCorrupt) {
                console.log(`⚠️ Session corrupt for ${userId}. Deleting and resetting...`);
                // حذف الملفات التالفة
                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
                if (ctx) ctx.reply('⚠️ تم اكتشاف ملف تالف. تمت إعادة الضبط، يرجى مسح الرمز مجدداً.');
                // إعادة المحاولة من الصفر
                setTimeout(() => startBaileysSession(userId, ctx), 2000);
            } 
            else if (statusCode !== DisconnectReason.loggedOut) {
                // إعادة اتصال عادية (مشكلة نت)
                console.log('🔄 Reconnecting...');
                startBaileysSession(userId, null);
            } 
            else {
                // تسجيل خروج نهائي
                console.log('⛔ Logged out.');
                if (ctx) ctx.reply('❌ تم تسجيل الخروج من الهاتف.');
                if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
            }
        } 
        else if (connection === 'open') {
            console.log(`✅ ${userId} Connected Successfully!`);
            sessions[userId].status = 'READY';
            if (ctx) ctx.reply('✅ **تم الاتصال بنجاح!**\nالبوت جاهز للعمل.');
        }
    });

    // حفظ بيانات الجلسة تلقائياً
    sock.ev.on('creds.update', saveCreds);

    // --- استقبال الرسائل والرد التلقائي ---
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        
        // استخراج النص من أي نوع رسالة (نص، صورة، فيديو)
        const textMessage = msg.message.conversation || 
                            msg.message.extendedTextMessage?.text || 
                            msg.message.imageMessage?.caption ||
                            msg.message.videoMessage?.caption;

        if (!textMessage) return;

        try {
            // البحث عن الرد في قاعدة البيانات
            // استخدمنا Regex لجعل البحث غير حساس لحالة الأحرف
            const reply = await Reply.findOne({ 
                userId: userId, 
                keyword: { $regex: new RegExp(`^${textMessage.trim()}$`, 'i') } 
            });

            if (reply) {
                await sock.sendMessage(remoteJid, { text: reply.response }, { quoted: msg });
            }
        } catch (e) {
            console.error('Auto-reply error:', e);
        }
    });
}

// ============================================================
// 4. واجهة تليجرام
// ============================================================

// القائمة الرئيسية
bot.start((ctx) => {
    ctx.reply('👋 **مرحباً بك في البوت المطور**\nيعمل بنظام Baileys الخفيف جداً.', 
        Markup.inlineKeyboard([
            [Markup.button.callback('🔗 ربط واتساب', 'connect_wa')],
            [Markup.button.callback('📂 الخدمات', 'services_menu')],
            [Markup.button.callback('❌ خروج نهائي', 'logout')]
        ]));
});

// الأزرار
bot.action('connect_wa', (ctx) => {
    const userId = ctx.from.id.toString();
    startBaileysSession(userId, ctx);
});

bot.action('retry_login', async (ctx) => {
    const userId = ctx.from.id.toString();
    ctx.editMessageText('🧹 **تنظيف وإعادة محاولة...**');
    
    // تنظيف يدوي
    const sessionDir = `./auth_info/session_${userId}`;
    if (sessions[userId]) {
        try { sessions[userId].sock.end(); } catch(e){}
        delete sessions[userId];
    }
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    
    await new Promise(r => setTimeout(r, 2000));
    startBaileysSession(userId, ctx);
});

bot.action('logout', (ctx) => {
    const userId = ctx.from.id.toString();
    const sessionDir = `./auth_info/session_${userId}`;
    
    if (sessions[userId]) {
        try { sessions[userId].sock.end(); } catch(e){}
        delete sessions[userId];
    }
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    ctx.editMessageText('✅ تم تسجيل الخروج وحذف البيانات.');
});

// قائمة الخدمات
bot.action('services_menu', (ctx) => {
    ctx.editMessageText('📂 **الخدمات المتاحة:**\nاستخدم الأوامر التالية:', Markup.inlineKeyboard([
        [Markup.button.callback('🔙 القائمة الرئيسية', 'main_menu')]
    ]));
    ctx.reply(
        `📌 **الأوامر:**\n\n` +
        `1️⃣ **إضافة رد تلقائي:**\n/addreply كلمة | الرد\n\n` +
        `2️⃣ **عرض الجروبات:**\n/groups\n\n` +
        `3️⃣ **نشر رسالة للكل:**\n/cast رسالتك هنا`
    );
});
bot.action('main_menu', (ctx) => ctx.reply('القائمة الرئيسية:', Markup.inlineKeyboard([[Markup.button.callback('🔗 ربط واتساب', 'connect_wa')]])));

// --- الأوامر النصية ---

// 1. إضافة رد
bot.command('addreply', async (ctx) => {
    const args = ctx.message.text.split('|');
    if (args.length < 2) return ctx.reply('⚠️ خطأ في التنسيق.\nاستخدم: `/addreply مرحبا | أهلاً بك`');
    
    const keyword = args[0].replace('/addreply', '').trim();
    const response = args[1].trim();
    const userId = ctx.from.id.toString();

    await Reply.create({ userId, keyword, response });
    ctx.reply(`✅ تم حفظ الرد على كلمة: "${keyword}"`);
});

// 2. عرض الجروبات
bot.command('groups', async (ctx) => {
    const userId = ctx.from.id.toString();
    const s = sessions[userId];
    
    if (!s || s.status !== 'READY') return ctx.reply('⚠️ يجب ربط الواتساب أولاً.');

    try {
        ctx.reply('⏳ جاري جلب القائمة...');
        const groups = await s.sock.groupFetchAllParticipating();
        const list = Object.values(groups).map((g, i) => `${i+1}. ${g.subject}`).join('\n');
        
        if (list.length > 4000) {
            ctx.reply(`📂 **أول 50 جروب:**\n\n${list.substring(0, 4000)}...`);
        } else {
            ctx.reply(`📂 **الجروبات (${Object.keys(groups).length}):**\n\n${list || 'لا يوجد جروبات'}`);
        }
    } catch (e) {
        ctx.reply('❌ حدث خطأ أثناء جلب الجروبات.');
    }
});

// 3. النشر (Broadcast)
bot.command('cast', async (ctx) => {
    const userId = ctx.from.id.toString();
    const s = sessions[userId];
    const text = ctx.message.text.replace('/cast', '').trim();

    if (!s || s.status !== 'READY') return ctx.reply('⚠️ غير متصل.');
    if (!text) return ctx.reply('⚠️ اكتب الرسالة بعد الأمر.\nمثال: `/cast السلام عليكم`');

    try {
        ctx.reply('⏳ جاري النشر...');
        const groups = await s.sock.groupFetchAllParticipating();
        const ids = Object.keys(groups);
        
        let sentCount = 0;
        for (const id of ids) {
            await s.sock.sendMessage(id, { text: text });
            sentCount++;
            await new Promise(r => setTimeout(r, 1000)); // انتظار ثانية بين كل رسالة
        }
        ctx.reply(`✅ تم النشر في ${sentCount} جروب.`);
    } catch (e) {
        ctx.reply('❌ حدث خطأ أثناء النشر.');
    }
});

// تشغيل البوت
bot.launch().then(() => console.log('🤖 Telegram Bot Started'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
