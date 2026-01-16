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
app.get('/', (req, res) => res.send('✅ Bot Running (Bug Fixes Applied)'));
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// ============================================================
// 2. قاعدة البيانات
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
const settingSchema = new mongoose.Schema({ key: String, value: String });
const replySchema = new mongoose.Schema({ userId: String, keyword: String, response: String });
const historySchema = new mongoose.Schema({ _id: String, date: Number });

const User = mongoose.model('User', userSchema);
const Setting = mongoose.model('Setting', settingSchema);
const Reply = mongoose.model('Reply', replySchema);
const History = mongoose.model('History', historySchema);

const sessions = {}; 
const userStates = {}; 
let ADMIN_USERNAME_CACHE = '';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// 🛑 منع الانهيار عند حدوث خطأ في تيليجرام
bot.catch((err, ctx) => {
    console.log(`⚠️ Telegraf Error for ${ctx.updateType}:`, err.message);
});

async function fetchAdmin() {
    if (!ADMIN_ID) return;
    try {
        const chat = await bot.telegram.getChat(ADMIN_ID);
        if(chat.username) {
            ADMIN_USERNAME_CACHE = chat.username;
            await Setting.findOneAndUpdate({ key: 'admin_user' }, { value: chat.username }, { upsert: true });
        }
    } catch (e) {}
}
fetchAdmin();

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
// 3. محرك Baileys
// ============================================================
async function startBaileysSession(userId, ctx) {
    if (sessions[userId] && sessions[userId].status === 'CONNECTING') return;

    // إشعار المستخدم (مع معالجة الخطأ إذا كانت الرسالة لا تقبل التعديل)
    if (ctx) {
        try {
            await ctx.editMessageText('🚀 **جاري الاتصال بالسيرفر...**');
        } catch (e) {
            // إذا فشل التعديل (مثلاً لأن الرسالة السابقة كانت صورة)، نرسل رسالة جديدة
            await ctx.reply('🚀 **جاري الاتصال بالسيرفر...**');
        }
    }

    const sessionDir = `./auth_info/session_${userId}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    // جلب الإصدار لتجنب حظر 405
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.macOS('Desktop'), 
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 2000
    });

    sessions[userId] = { sock, status: 'CONNECTING', selected: [], allGroups: [] };

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && ctx) {
            try {
                const buffer = await qrcode.toBuffer(qr);
                // نحاول حذف الرسالة القديمة أولاً
                await ctx.deleteMessage().catch(()=>{}); 
                await ctx.replyWithPhoto({ source: buffer }, { 
                    caption: '📱 **امسح الرمز (Baileys)**\nنظام سريع وخفيف.',
                    ...Markup.inlineKeyboard([[Markup.button.callback('🔄 تحديث الرمز', 'retry_login')]])
                });
            } catch (e) {}
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            console.log(`❌ Closed: ${statusCode}`);
            
            // تجاهل خطأ 515 (Stream Restart) وإعادة المحاولة تلقائياً
            if (statusCode === 515) {
                console.log('🔄 Restarting stream (515)...');
                startBaileysSession(userId, null);
                return;
            }

            if (statusCode === 405 || statusCode === 403 || statusCode === 401) {
                delete sessions[userId];
                if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                if (ctx) ctx.reply('⚠️ انتهت الجلسة. يرجى إعادة الربط.');
            } else if (statusCode !== DisconnectReason.loggedOut) {
                startBaileysSession(userId, null);
            } else {
                delete sessions[userId];
                if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                if (ctx) ctx.reply('❌ تم تسجيل الخروج.');
            }
        } 
        else if (connection === 'open') {
            console.log(`✅ ${userId} Connected!`);
            sessions[userId].status = 'READY';
            if (ctx) {
                // حذف رسالة "جاري الاتصال" القديمة
                try { await ctx.deleteMessage(); } catch(e){}
                ctx.reply('✅ **تم الاتصال بنجاح!**', Markup.inlineKeyboard([[Markup.button.callback('📂 فتح القائمة', 'main_menu')]]));
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!textMessage) return;

        try {
            const reply = await Reply.findOne({ 
                userId: userId, 
                keyword: { $regex: new RegExp(`^${textMessage.trim()}$`, 'i') } 
            });
            if (reply) {
                await sock.sendMessage(msg.key.remoteJid, { text: reply.response }, { quoted: msg });
            }
        } catch (e) {}
    });
}

// ============================================================
// 4. Middleware
// ============================================================
bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const userId = ctx.from.id.toString();
    try { await History.create({ _id: userId, date: Date.now() }); } catch(e) {} 
    const isAdmin = (userId == ADMIN_ID);

    if (!isAdmin) {
        try {
            const setting = await Setting.findOne({ key: 'force_channel' });
            if (setting && setting.value) {
                const member = await ctx.telegram.getChatMember(setting.value, userId);
                if (!['creator', 'administrator', 'member'].includes(member.status)) throw new Error();
            }
        } catch (e) {
            const setting = await Setting.findOne({ key: 'force_channel' });
            if (setting) return ctx.reply(`⛔ **اشترك أولاً:** ${setting.value}`, Markup.inlineKeyboard([[Markup.button.callback('✅ تم', 'check_sub')]]));
        }
    }
    if (ctx.callbackQuery && ctx.callbackQuery.data === 'check_sub') return ctx.answerCbQuery('✅');

    if (!isAdmin) {
        if (ctx.message && ctx.message.text === '/start') return next();
        if (ctx.callbackQuery && ctx.callbackQuery.data.startsWith('req_')) return next();
        const user = await User.findById(userId);
        if (!user || user.expiry < Date.now()) return ctx.reply('⛔ **اشتراكك منتهي.**');
    }
    return next();
});

// ============================================================
// 5. القوائم
// ============================================================
async function showMainMenu(ctx) {
    const userId = ctx.from.id.toString();
    const isAdmin = (userId == ADMIN_ID);
    const user = await User.findById(userId);
    const isPaid = (user && user.expiry > Date.now());

    let msg = `👋 **مرحباً بك في لوحة التحكم**\n\n`;
    let buttons = [];

    if (isAdmin || isPaid) {
        msg += isAdmin ? "👑 **المدير**\n" : `✅ **الاشتراك فعال**\n`;
        buttons.push([Markup.button.callback('🔗 واتساب / الحالة', 'open_dashboard')]);
        buttons.push([Markup.button.callback('📂 الخدمات', 'services_menu')]);
        buttons.push([Markup.button.callback('⏳ مدة اشتراكي', 'check_my_sub')]);
        if (isAdmin) buttons.push([Markup.button.callback('🛠️ لوحة المدير', 'admin_panel')]);
    } else {
        const adminSet = await Setting.findOne({ key: 'admin_user' });
        msg += `⛔ **غير مفعل**\nللاشتراك تواصل مع: @${adminSet ? adminSet.value : 'Admin'}`;
        buttons.push([Markup.button.callback('🛒 طلب اشتراك', 'req_sub')]);
    }
    
    // إصلاح الخطأ: نستخدم try-catch لتحديد هل نعدل أم نرسل جديد
    try { 
        await ctx.editMessageText(msg, Markup.inlineKeyboard(buttons)); 
    } catch (e) { 
        // إذا فشل التعديل (مثل حذف صورة)، نرسل رسالة جديدة
        await ctx.reply(msg, Markup.inlineKeyboard(buttons)); 
    }
}

async function showServicesMenu(ctx) {
    const kb = Markup.inlineKeyboard([
        [Markup.button.callback('📨 نشر للكل', 'broadcast'), Markup.button.callback('⚙️ اختيار الجروبات', 'fetch_groups')],
        [Markup.button.callback('🤖 الردود التلقائية', 'my_replies'), Markup.button.callback('🔙 القائمة', 'main_menu')]
    ]);
    try { await ctx.editMessageText('📂 **قائمة الخدمات:**', kb); } catch { await ctx.reply('📂 **قائمة الخدمات:**', kb); }
}

bot.start((ctx) => showMainMenu(ctx));
bot.action('main_menu', (ctx) => showMainMenu(ctx));
bot.action('services_menu', (ctx) => showServicesMenu(ctx));

bot.action('open_dashboard', (ctx) => {
    const userId = ctx.from.id.toString();
    const s = sessions[userId];
    if (s && s.status === 'READY') {
        ctx.reply('✅ **أنت متصل بالفعل.**', Markup.inlineKeyboard([[Markup.button.callback('❌ تسجيل خروج', 'logout')]]));
    } else {
        startBaileysSession(userId, ctx);
    }
});

// ============================================================
// 6. إصلاح أزرار التحديث والخروج (أصل المشكلة)
// ============================================================
bot.action('retry_login', async (ctx) => {
    const userId = ctx.from.id.toString();
    const sessionDir = `./auth_info/session_${userId}`;
    
    // حذف الجلسة
    if (sessions[userId]) delete sessions[userId];
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    
    // 🔥 الإصلاح: حذف الصورة القديمة بدلاً من محاولة تعديل نصها
    try { await ctx.deleteMessage(); } catch(e) {}
    
    await ctx.reply('🔄 **جاري إعادة تعيين الاتصال...**');
    setTimeout(() => startBaileysSession(userId, ctx), 2000);
});

bot.action('logout', async (ctx) => {
    const userId = ctx.from.id.toString();
    const sessionDir = `./auth_info/session_${userId}`;
    
    if (sessions[userId]) {
        try { sessions[userId].sock.end(); } catch(e){}
        delete sessions[userId];
    }
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    
    // 🔥 الإصلاح
    try { await ctx.deleteMessage(); } catch(e) {}
    
    await ctx.reply('✅ **تم تسجيل الخروج بنجاح.**', Markup.inlineKeyboard([[Markup.button.callback('🔙 القائمة الرئيسية', 'main_menu')]]));
});

// ============================================================
// 7. الجروبات، النشر، والردود
// ============================================================
bot.action('fetch_groups', async (ctx) => {
    const userId = ctx.from.id.toString();
    const s = sessions[userId];
    if(!s || s.status !== 'READY') return ctx.reply('⚠️ يجب ربط الواتساب أولاً.');

    await ctx.answerCbQuery('⏳ جاري جلب الجروبات...');
    try {
        const groupsObj = await s.sock.groupFetchAllParticipating();
        const groups = Object.values(groupsObj);
        s.allGroups = groups.map(g => ({ id: g.id, name: g.subject }));
        sendGroupMenu(ctx, userId);
    } catch (e) {
        ctx.reply('❌ فشل جلب الجروبات.');
    }
});

async function sendGroupMenu(ctx, userId) {
    const s = sessions[userId];
    // إذا كانت القائمة فارغة
    if (!s.allGroups || s.allGroups.length === 0) {
        return ctx.reply('⚠️ لا يوجد جروبات في هذا الحساب.');
    }

    const btns = s.allGroups.slice(0, 20).map(g => [Markup.button.callback(`${s.selected.includes(g.id)?'✅':'⬜'} ${g.name.substring(0,15)}`, `sel_${g.id}`)]);
    btns.push([Markup.button.callback('✅ تحديد الكل', 'sel_all'), Markup.button.callback('❌ إلغاء', 'desel_all')]);
    btns.push([Markup.button.callback(`💾 حفظ (${s.selected.length})`, 'done_sel')]);
    
    try { await ctx.editMessageText('📂 **اختر الجروبات:**', Markup.inlineKeyboard(btns)); } 
    catch { await ctx.reply('📂 **اختر الجروبات:**', Markup.inlineKeyboard(btns)); }
}

bot.action(/sel_(.+)/, (ctx) => {
    const userId = ctx.from.id.toString();
    const s = sessions[userId];
    const id = ctx.match[1];
    s.selected.includes(id) ? s.selected = s.selected.filter(i=>i!==id) : s.selected.push(id);
    sendGroupMenu(ctx, userId);
});
bot.action('sel_all', (ctx) => { 
    const userId = ctx.from.id.toString();
    if(sessions[userId].allGroups) sessions[userId].selected = sessions[userId].allGroups.map(g => g.id); 
    sendGroupMenu(ctx, userId); 
});
bot.action('desel_all', (ctx) => { 
    sessions[ctx.from.id.toString()].selected = []; 
    sendGroupMenu(ctx, ctx.from.id.toString()); 
});
bot.action('done_sel', (ctx) => { ctx.answerCbQuery('تم الحفظ'); showServicesMenu(ctx); });

bot.action('broadcast', (ctx) => {
    const userId = ctx.from.id.toString();
    if (!sessions[userId]?.selected.length) return ctx.reply('⚠️ اختر الجروبات أولاً.');
    userStates[userId] = { step: 'WAIT_CONTENT' };
    ctx.reply('📝 أرسل الرسالة التي تريد نشرها (نص فقط حالياً):');
});

bot.action('my_replies', async (ctx) => {
    const count = await Reply.countDocuments({ userId: ctx.from.id.toString() });
    ctx.editMessageText(`🤖 الردود المسجلة: ${count}`, Markup.inlineKeyboard([[Markup.button.callback('➕ إضافة رد', 'add_rep'), Markup.button.callback('❌ حذف رد', 'del_rep')], [Markup.button.callback('🔙 رجوع', 'services_menu')]]));
});
bot.action('add_rep', (ctx) => { userStates[ctx.from.id] = { step: 'WAIT_KEYWORD' }; ctx.reply('أرسل الكلمة المفتاحية:'); });
bot.action('del_rep', (ctx) => { userStates[ctx.from.id] = { step: 'WAIT_DEL_KEY' }; ctx.reply('أرسل الكلمة لحذفها:'); });

// معالجة النصوص
bot.on('text', async (ctx) => {
    const userId = ctx.from.id.toString();
    const text = ctx.message.text;
    const s = sessions[userId];
    const state = userStates[userId];

    // اشتراكات المدير
    if (userId == ADMIN_ID && state?.step === 'TYPE_DAYS_FOR_REQ') { 
        await activateUser(ctx, state.targetId, parseInt(text)); 
        userStates[userId] = null; 
        return; 
    }

    // المستخدم
    if (state?.step === 'WAIT_KEYWORD') { state.tempKey = text; state.step = 'WAIT_REPLY'; return ctx.reply('الآن أرسل الرد:'); }
    if (state?.step === 'WAIT_REPLY') { await Reply.create({ userId, keyword: state.tempKey, response: text }); userStates[userId] = null; return ctx.reply('✅ تم حفظ الرد.'); }
    if (state?.step === 'WAIT_DEL_KEY') { await Reply.deleteMany({ userId, keyword: text }); userStates[userId] = null; return ctx.reply('✅ تم الحذف.'); }

    // النشر
    if (state?.step === 'WAIT_CONTENT' && s) {
        ctx.reply('🚀 جاري النشر...');
        let count = 0;
        for (const id of s.selected) {
            try {
                await s.sock.sendMessage(id, { text: text });
                count++;
                await sleep(1000); 
            } catch (e) {}
        }
        userStates[userId] = null;
        ctx.reply(`✅ تم النشر في ${count} جروب.`);
    }
});

// اشتراكات (نسخ من الكود السابق)
bot.action('check_my_sub', async (ctx) => {
    const userId = ctx.from.id.toString();
    if (userId == ADMIN_ID) return ctx.reply('👑 أنت المدير.');
    const user = await User.findById(userId);
    if (user && user.expiry > Date.now()) {
        const days = Math.floor((user.expiry - Date.now()) / 86400000);
        ctx.reply(`✅ متبقي لك: ${days} يوم.`);
    } else { ctx.reply('⛔ اشتراكك منتهي.'); }
});

// تشغيل البوت
bot.launch();
process.once('SIGINT', () => bot.stop());
