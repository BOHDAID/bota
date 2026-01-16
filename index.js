const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const { Telegraf, Markup } = require('telegraf');
const qrcode = require('qrcode');
const mongoose = require('mongoose');
const express = require('express');

// ============================================================
// 1. سيرفر Render
// ============================================================
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('✅ Baileys Bot Running (Latest Version Mode)'));
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

const sessions = {}; 

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
bot.catch((err) => console.log('Telegraf Error:', err));

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
// 3. محرك Baileys (إصلاح خطأ 405)
// ============================================================
async function startBaileysSession(userId, ctx) {
    if (sessions[userId] && sessions[userId].status === 'CONNECTING') return;

    if (ctx) ctx.reply('🚀 **جاري جلب أحدث إصدار والاتصال...**');

    const sessionDir = `./auth_info/session_${userId}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    // 🔥 الحل السحري: جلب أحدث إصدار من واتساب لتجنب الحظر 405 🔥
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version, // استخدام الإصدار الحديث
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        // استخدام توقيع ماك لتجنب الشكوك
        browser: Browsers.macOS('Desktop'), 
        syncFullHistory: false, 
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 2000 // تأخير إعادة المحاولة لعدم إزعاج السيرفر
    });

    sessions[userId] = { sock, status: 'CONNECTING' };

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && ctx) {
            try {
                const buffer = await qrcode.toBuffer(qr);
                await ctx.deleteMessage().catch(()=>{});
                await ctx.replyWithPhoto({ source: buffer }, { 
                    caption: '📱 **امسح الرمز (Baileys Fixed)**\nتم تحديث الإصدار.',
                    ...Markup.inlineKeyboard([[Markup.button.callback('🔄 طلب رمز جديد', 'retry_login')]])
                });
            } catch (e) {}
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            console.log(`❌ Connection closed (Code: ${statusCode})`);
            
            delete sessions[userId];

            // إذا كان الخطأ 405 (Not Allowed) أو 403 (Forbidden)
            // فهذا يعني أن ملف الجلسة تالف ولا يمكن إصلاحه، يجب حذفه
            if (statusCode === 405 || statusCode === 403) {
                console.log(`⚠️ Fatal Error ${statusCode}. Deleting session...`);
                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
                if (ctx) ctx.reply('⚠️ تم تحديث بروتوكول واتساب. يرجى مسح الرمز الجديد.');
                // إعادة المحاولة بالنسخة الجديدة
                setTimeout(() => startBaileysSession(userId, ctx), 3000);
            } 
            else if (statusCode !== DisconnectReason.loggedOut) {
                startBaileysSession(userId, null);
            } 
            else {
                if (ctx) ctx.reply('❌ تم تسجيل الخروج.');
                if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
            }
        } 
        else if (connection === 'open') {
            console.log(`✅ ${userId} Connected!`);
            sessions[userId].status = 'READY';
            if (ctx) ctx.reply('✅ **تم الاتصال بنجاح!**');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (!textMessage) return;

        try {
            const reply = await Reply.findOne({ 
                userId: userId, 
                keyword: { $regex: new RegExp(`^${textMessage.trim()}$`, 'i') } 
            });

            if (reply) {
                await sock.sendMessage(remoteJid, { text: reply.response }, { quoted: msg });
            }
        } catch (e) {}
    });
}

// ============================================================
// 4. أوامر التيليجرام
// ============================================================
bot.start((ctx) => {
    ctx.reply('👋 **مرحباً بك**\n(إصلاح الخطأ 405 مفعل).', 
        Markup.inlineKeyboard([
            [Markup.button.callback('🔗 ربط واتساب', 'connect_wa')],
            [Markup.button.callback('📂 الخدمات', 'services_menu')],
            [Markup.button.callback('❌ خروج', 'logout')]
        ]));
});

bot.action('connect_wa', (ctx) => {
    const userId = ctx.from.id.toString();
    startBaileysSession(userId, ctx);
});

bot.action('retry_login', async (ctx) => {
    const userId = ctx.from.id.toString();
    ctx.editMessageText('🧹 **تنظيف...**');
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
    ctx.editMessageText('✅ تم الخروج.');
});

bot.action('services_menu', (ctx) => {
    ctx.editMessageText('📂 **الخدمات:**', Markup.inlineKeyboard([
        [Markup.button.callback('🔙 القائمة', 'main_menu')]
    ]));
    ctx.reply('1️⃣ /addreply كلمة | الرد\n2️⃣ /groups\n3️⃣ /cast رسالة');
});
bot.action('main_menu', (ctx) => ctx.reply('القائمة:', Markup.inlineKeyboard([[Markup.button.callback('🔗 ربط واتساب', 'connect_wa')]])));

bot.command('addreply', async (ctx) => {
    const args = ctx.message.text.split('|');
    if (args.length < 2) return ctx.reply('خطأ. استخدم: /addreply كلمة | رد');
    await Reply.create({ userId: ctx.from.id.toString(), keyword: args[0].replace('/addreply', '').trim(), response: args[1].trim() });
    ctx.reply('✅ تم الحفظ.');
});

bot.command('groups', async (ctx) => {
    const s = sessions[ctx.from.id.toString()];
    if (!s || s.status !== 'READY') return ctx.reply('⚠️ غير متصل.');
    const groups = await s.sock.groupFetchAllParticipating();
    const list = Object.values(groups).map((g, i) => `${i+1}. ${g.subject}`).join('\n');
    ctx.reply(`📂 الجروبات:\n${list.substring(0, 3000)}`);
});

bot.command('cast', async (ctx) => {
    const s = sessions[ctx.from.id.toString()];
    const text = ctx.message.text.replace('/cast', '').trim();
    if (!s || s.status !== 'READY') return ctx.reply('⚠️ غير متصل.');
    if (!text) return ctx.reply('⚠️ اكتب الرسالة.');
    ctx.reply('⏳ جاري النشر...');
    const groups = await s.sock.groupFetchAllParticipating();
    for (const id of Object.keys(groups)) {
        await s.sock.sendMessage(id, { text });
        await new Promise(r => setTimeout(r, 1000));
    }
    ctx.reply('✅ تم.');
});

bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
