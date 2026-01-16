const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const { Telegraf, Markup } = require('telegraf');
const qrcode = require('qrcode');
const mongoose = require('mongoose');
const express = require('express');
const axios = require('axios');

// ============================================================
// 1. سيرفر Render
// ============================================================
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('✅ Bot is Ready (Baileys + Full UI)'));
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

// متغيرات الذاكرة
const sessions = {}; 
const userStates = {}; 
let ADMIN_USERNAME_CACHE = '';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
bot.catch((err) => console.log('Telegraf Error:', err));

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
// 3. محرك Baileys (الاتصال الناجح)
// ============================================================
async function startBaileysSession(userId, ctx) {
    if (sessions[userId] && sessions[userId].status === 'CONNECTING') return;

    if (ctx) ctx.editMessageText('🚀 **جاري الاتصال بالسيرفر...**').catch(()=>{});

    const sessionDir = `./auth_info/session_${userId}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    // جلب أحدث إصدار لتجنب الحظر
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.macOS('Desktop'), 
        syncFullHistory: false, // ⛔ منع المزامنة لتوفير الرام
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 2000
    });

    sessions[userId] = { sock, status: 'CONNECTING', selected: [], groups: [] };

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && ctx) {
            try {
                const buffer = await qrcode.toBuffer(qr);
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
            
            // التعامل مع الأخطاء وإعادة المحاولة
            if (statusCode === 405 || statusCode === 403 || statusCode === 401) {
                delete sessions[userId];
                if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                if (ctx) ctx.reply('⚠️ انتهت الجلسة أو حدث خطأ. يرجى إعادة الربط.');
            } else if (statusCode !== DisconnectReason.loggedOut) {
                // إعادة اتصال تلقائية (للأخطاء مثل 515)
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
            if (ctx) ctx.reply('✅ **تم الاتصال بنجاح!**', Markup.inlineKeyboard([[Markup.button.callback('📂 فتح القائمة', 'main_menu')]]));
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // الرد التلقائي
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
// 4. Middleware (الحماية والاشتراكات)
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
// 5. واجهة المستخدم (القوائم والأزرار)
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
        buttons.push([Markup.button.callback('🔗 ربط واتساب / الحالة', 'open_dashboard')]);
        buttons.push([Markup.button.callback('📂 الخدمات', 'services_menu')]);
        buttons.push([Markup.button.callback('⏳ مدة اشتراكي', 'check_my_sub')]);
        if (isAdmin) buttons.push([Markup.button.callback('🛠️ لوحة المدير', 'admin_panel')]);
    } else {
        const adminSet = await Setting.findOne({ key: 'admin_user' });
        msg += `⛔ **غير مفعل**\nللاشتراك تواصل مع: @${adminSet ? adminSet.value : 'Admin'}`;
        buttons.push([Markup.button.callback('🛒 طلب اشتراك', 'req_sub')]);
    }
    try { await ctx.editMessageText(msg, Markup.inlineKeyboard(buttons)); } catch { await ctx.reply(msg, Markup.inlineKeyboard(buttons)); }
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

bot.action('check_my_sub', async (ctx) => {
    const userId = ctx.from.id.toString();
    if (userId == ADMIN_ID) return ctx.reply('👑 أنت المدير.');
    const user = await User.findById(userId);
    if (user && user.expiry > Date.now()) {
        const days = Math.floor((user.expiry - Date.now()) / 86400000);
        ctx.reply(`✅ متبقي لك: ${days} يوم.`);
    } else { ctx.reply('⛔ اشتراكك منتهي.'); }
});

// ============================================================
// 6. نظام الاشتراكات
// ============================================================
bot.action('req_sub', async (ctx) => {
    const adminSet = await Setting.findOne({ key: 'admin_user' });
    ctx.editMessageText(`✅ تم إرسال طلبك للإدارة.`, Markup.inlineKeyboard([[Markup.button.url('تواصل مع الدعم', `https://t.me/${adminSet ? adminSet.value : 'Admin'}`)]]));
    bot.telegram.sendMessage(ADMIN_ID, `🔔 طلب اشتراك جديد من: \`${ctx.from.id}\``, 
        Markup.inlineKeyboard([[Markup.button.callback('تفعيل 30 يوم', `act_${ctx.from.id}_30`), Markup.button.callback('تحديد مدة', `manual_days_${ctx.from.id}`)], [Markup.button.callback('رفض', `reject_${ctx.from.id}`)]]));
});

bot.action(/act_(.+)_(.+)/, async (ctx) => { await activateUser(ctx, ctx.match[1], parseInt(ctx.match[2])); });
bot.action(/manual_days_(.+)/, (ctx) => { userStates[ADMIN_ID] = { step: 'TYPE_DAYS_FOR_REQ', targetId: ctx.match[1] }; ctx.reply('🔢 أرسل عدد الأيام:'); });
async function activateUser(ctx, targetId, days) {
    await User.findByIdAndUpdate(targetId, { expiry: Date.now() + (days * 86400000) }, { upsert: true });
    await bot.telegram.sendMessage(targetId, `🎉 تم تفعيل اشتراكك لمدة ${days} يوم.`).catch(()=>{});
    ctx.editMessageText('✅ تم التفعيل.');
}
bot.action(/reject_(.+)/, async (ctx) => { 
    try { await bot.telegram.sendMessage(ctx.match[1], '❌ تم رفض طلب الاشتراك.').catch(()=>{}); } catch(e){}
    ctx.editMessageText('❌ تم الرفض.'); 
});

// ============================================================
// 7. الجروبات والنشر
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
    const btns = s.allGroups.slice(0, 20).map(g => [Markup.button.callback(`${s.selected.includes(g.id)?'✅':'⬜'} ${g.name.substring(0,15)}`, `sel_${g.id}`)]);
    btns.push([Markup.button.callback('✅ تحديد الكل', 'sel_all'), Markup.button.callback('❌ إلغاء', 'desel_all')]);
    btns.push([Markup.button.callback(`💾 حفظ (${s.selected.length})`, 'done_sel')]);
    try { await ctx.editMessageText('📂 **اختر الجروبات:**', Markup.inlineKeyboard(btns)); } catch { ctx.reply('📂 **اختر الجروبات:**', Markup.inlineKeyboard(btns)); }
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
    sessions[userId].selected = sessions[userId].allGroups.map(g => g.id); 
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

// ============================================================
// 8. الردود التلقائية
// ============================================================
bot.action('my_replies', async (ctx) => {
    const count = await Reply.countDocuments({ userId: ctx.from.id.toString() });
    ctx.editMessageText(`🤖 الردود المسجلة: ${count}`, Markup.inlineKeyboard([[Markup.button.callback('➕ إضافة رد', 'add_rep'), Markup.button.callback('❌ حذف رد', 'del_rep')], [Markup.button.callback('🔙 رجوع', 'services_menu')]]));
});
bot.action('add_rep', (ctx) => { userStates[ctx.from.id] = { step: 'WAIT_KEYWORD' }; ctx.reply('أرسل الكلمة المفتاحية:'); });
bot.action('del_rep', (ctx) => { userStates[ctx.from.id] = { step: 'WAIT_DEL_KEY' }; ctx.reply('أرسل الكلمة لحذفها:'); });

// ============================================================
// 9. لوحة المدير
// ============================================================
bot.action('admin_panel', async (ctx) => {
    const total = await User.countDocuments();
    ctx.editMessageText(`🛠️ المشتركين: ${total}`, Markup.inlineKeyboard([[Markup.button.callback('➕ تفعيل يدوي', 'adm_add'), Markup.button.callback('❌ حذف عضو', 'adm_del')], [Markup.button.callback('📢 رسالة للكل', 'adm_cast'), Markup.button.callback('🔒 قناة إجبارية', 'adm_force')], [Markup.button.callback('🔙 رجوع', 'main_menu')]]));
});
// (يمكنك نسخ بقية أزرار المدير من الكود القديم إذا كنت تحتاجها، نفس المنطق)

// ============================================================
// 10. معالج الرسائل
// ============================================================
bot.on('text', async (ctx) => {
    const userId = ctx.from.id.toString();
    const text = ctx.message.text;
    const s = sessions[userId];
    const state = userStates[userId];

    // المدير
    if (userId == ADMIN_ID && state) {
        if (state.step === 'TYPE_DAYS_FOR_REQ') { await activateUser(ctx, state.targetId, parseInt(text)); userStates[userId] = null; return; }
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
                await sleep(1000); // تأخير بسيط
            } catch (e) {}
        }
        userStates[userId] = null;
        ctx.reply(`✅ تم النشر في ${count} جروب.`);
    }
});

bot.action('retry_login', async (ctx) => {
    const userId = ctx.from.id.toString();
    const sessionDir = `./auth_info/session_${userId}`;
    if (sessions[userId]) delete sessions[userId];
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    ctx.editMessageText('🔄 إعادة تعيين...');
    setTimeout(() => startBaileysSession(userId, ctx), 2000);
});

bot.action('logout', (ctx) => {
    const userId = ctx.from.id.toString();
    const sessionDir = `./auth_info/session_${userId}`;
    if (sessions[userId]) delete sessions[userId];
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    ctx.editMessageText('✅ تم تسجيل الخروج.');
});

bot.launch();
process.once('SIGINT', () => bot.stop());
