const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');

// 1. Render Server
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('✅ Bot Running (Menu Fixed)'));
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// 2. Settings
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN; 
const ADMIN_ID = process.env.ADMIN_ID; 
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI).then(() => console.log('✅ DB Connected')).catch(e => console.log(e));

const User = mongoose.model('User', new mongoose.Schema({ _id: String, expiry: Number }));
const Setting = mongoose.model('Setting', new mongoose.Schema({ key: String, value: String }));
const Reply = mongoose.model('Reply', new mongoose.Schema({ userId: String, keyword: String, response: String }));
const History = mongoose.model('History', new mongoose.Schema({ _id: String, date: Number }));

const sessions = {}; 
const userStates = {}; 
const msgRetryCounterCache = new Map();
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// استعادة الجلسات
async function restoreSessions() {
    const authPath = './auth_info';
    if (fs.existsSync(authPath)) {
        const folders = fs.readdirSync(authPath).filter(f => f.startsWith('session_'));
        for (const folder of folders) {
            const userId = folder.replace('session_', '');
            const user = await User.findById(userId);
            if (user && user.expiry > Date.now()) {
                startBaileysSession(userId, null);
            }
        }
    }
}
restoreSessions();

// 3. المحرك
async function startBaileysSession(userId, ctx, phoneNumber = null) {
    if (sessions[userId] && sessions[userId].status === 'READY' && !phoneNumber) return;

    const sessionDir = `./auth_info/session_${userId}`;
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
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        msgRetryCounterCache,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 2000,
        getMessage: async (key) => { return { conversation: 'hello' }; }
    });

    sessions[userId] = { sock, status: 'CONNECTING', selected: [], allGroups: [] };

    if (phoneNumber && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
                await delay(2000); 
                const code = await sock.requestPairingCode(cleanNumber);
                if (ctx) ctx.reply(`🔢 **الكود:** \`${code}\`\n\nضعه في واتساب بسرعة!`, { parse_mode: 'Markdown' });
            } catch (e) {
                if (ctx) ctx.reply('❌ فشل طلب الرمز.');
            }
        }, 3000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            if (statusCode === 401 || statusCode === 403) {
                 delete sessions[userId];
                 if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                 if (ctx) ctx.reply('⚠️ انتهت الجلسة.');
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
            
            // 🔥 هنا الحل: إرسال القائمة الجديدة فوراً عند نجاح الاتصال
            const successMsg = '✅ **تم الاتصال بنجاح!**\nيمكنك الآن استخدام الخدمات.';
            const kb = Markup.inlineKeyboard([
                [Markup.button.callback('📨 نشر للكل', 'broadcast'), Markup.button.callback('⚙️ الجروبات', 'fetch_groups')],
                [Markup.button.callback('🤖 الردود', 'my_replies'), Markup.button.callback('❌ خروج', 'logout')],
                [Markup.button.callback('🔙 القائمة الرئيسية', 'main_menu')]
            ]);
            
            if (ctx) {
                ctx.reply(successMsg, kb);
            } else {
                // إذا كان إعادة اتصال تلقائي، أرسل رسالة للمستخدم
                bot.telegram.sendMessage(userId, successMsg, kb).catch(()=>{});
            }
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

// 4. Middleware
bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const userId = ctx.from.id.toString();
    try { await History.create({ _id: userId, date: Date.now() }); } catch(e) {} 
    const isAdmin = (userId == ADMIN_ID);

    if (!isAdmin) {
        if (ctx.message && ['/start', '/reset'].includes(ctx.message.text)) return next();
        if (ctx.callbackQuery && ['login_check', 'logout'].includes(ctx.callbackQuery.data)) return next();
        const user = await User.findById(userId);
        if (!user || user.expiry < Date.now()) return ctx.reply('⛔ اشتراكك منتهي.');
    }
    return next();
});

// 5. القوائم (المعدلة لتظهر الخدمات عند الاتصال)
async function showMainMenu(ctx) {
    const userId = ctx.from.id.toString();
    const isAdmin = (userId == ADMIN_ID);
    const user = await User.findById(userId);
    const isPaid = (user && user.expiry > Date.now());
    const isConnected = sessions[userId] && sessions[userId].status === 'READY';

    let msg = `👋 **مرحباً بك**\n`;
    let buttons = [];

    if (isAdmin || isPaid) {
        msg += `حالة الاتصال: ${isConnected ? '✅ متصل' : '❌ غير متصل'}\n`;
        
        // 🔥 إذا كان متصلاً، نعرض زر الخدمات بشكل بارز
        if (isConnected) {
            buttons.push([Markup.button.callback('🚀 الدخول للخدمات (نشر/ردود)', 'services_menu')]);
            buttons.push([Markup.button.callback('❌ تسجيل خروج', 'logout')]);
        } else {
            buttons.push([Markup.button.callback('🔗 ربط واتساب الآن', 'login_check')]);
        }

        buttons.push([Markup.button.callback('⏳ اشتراكي', 'check_my_sub')]);
        if (isAdmin) buttons.push([Markup.button.callback('🛠️ المدير', 'admin_panel')]);
    } else {
        buttons.push([Markup.button.callback('🛒 طلب اشتراك', 'req_sub')]);
    }
    
    try { await ctx.editMessageText(msg, Markup.inlineKeyboard(buttons)); } catch { await ctx.reply(msg, Markup.inlineKeyboard(buttons)); }
}

bot.start((ctx) => showMainMenu(ctx));
bot.action('main_menu', (ctx) => showMainMenu(ctx));

bot.action('login_check', (ctx) => {
    const userId = ctx.from.id.toString();
    if (sessions[userId] && sessions[userId].status === 'READY') {
        ctx.reply('✅ أنت متصل بالفعل.');
        showMainMenu(ctx);
    } else {
        ctx.reply('📞 أرسل رقمك (مثال: 9665xxxxxxxx):');
        sessions[userId] = { step: 'WAIT_PHONE' };
    }
});

bot.action('logout', (ctx) => {
    const userId = ctx.from.id.toString();
    const sessionDir = `./auth_info/session_${userId}`;
    if (sessions[userId]?.sock) { try{sessions[userId].sock.end()}catch(e){} }
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    delete sessions[userId];
    ctx.editMessageText('✅ تم الخروج.');
});

// الخدمات
bot.action('services_menu', (ctx) => {
    // فحص مزدوج للتأكد
    const userId = ctx.from.id.toString();
    if (!sessions[userId] || sessions[userId].status !== 'READY') {
        return ctx.reply('⚠️ لست متصلاً! اذهب للقائمة الرئيسية واربط واتساب.', Markup.inlineKeyboard([[Markup.button.callback('🔙 القائمة', 'main_menu')]]));
    }

    ctx.editMessageText('📂 **قائمة الخدمات:**', Markup.inlineKeyboard([
        [Markup.button.callback('📨 نشر للكل', 'broadcast'), Markup.button.callback('⚙️ الجروبات', 'fetch_groups')],
        [Markup.button.callback('🤖 الردود التلقائية', 'my_replies'), Markup.button.callback('🔙 القائمة', 'main_menu')]
    ]));
});

bot.action('fetch_groups', async (ctx) => {
    const s = sessions[ctx.from.id.toString()];
    if(!s || s.status !== 'READY') return ctx.reply('⚠️ غير متصل.');
    await ctx.answerCbQuery('جاري التحميل...');
    try {
        const groups = await s.sock.groupFetchAllParticipating();
        s.allGroups = Object.values(groups).map(g => ({ id: g.id, name: g.subject }));
        sendGroupMenu(ctx, ctx.from.id.toString());
    } catch { ctx.reply('❌ خطأ في الجروبات'); }
});

async function sendGroupMenu(ctx, userId) {
    const s = sessions[userId];
    const btns = s.allGroups.slice(0, 20).map(g => [Markup.button.callback(`${s.selected.includes(g.id)?'✅':'⬜'} ${g.name.substring(0,10)}`, `sel_${g.id}`)]);
    btns.push([Markup.button.callback('✅ الكل', 'sel_all'), Markup.button.callback('❌ إلغاء', 'desel_all')]);
    btns.push([Markup.button.callback(`نشر (${s.selected.length})`, 'broadcast')]);
    try { await ctx.editMessageText('اختر الجروبات:', Markup.inlineKeyboard(btns)); } catch { ctx.reply('اختر الجروبات:', Markup.inlineKeyboard(btns)); }
}

bot.action(/sel_(.+)/, (ctx) => {
    const s = sessions[ctx.from.id.toString()];
    const id = ctx.match[1];
    s.selected.includes(id) ? s.selected = s.selected.filter(i=>i!==id) : s.selected.push(id);
    sendGroupMenu(ctx, ctx.from.id.toString());
});
bot.action('sel_all', (ctx) => { sessions[ctx.from.id.toString()].selected = sessions[ctx.from.id.toString()].allGroups.map(g => g.id); sendGroupMenu(ctx, ctx.from.id.toString()); });
bot.action('desel_all', (ctx) => { sessions[ctx.from.id.toString()].selected = []; sendGroupMenu(ctx, ctx.from.id.toString()); });

bot.action('broadcast', (ctx) => {
    if(!sessions[ctx.from.id.toString()]?.selected.length) return ctx.reply('⚠️ اختر جروبات.');
    userStates[ctx.from.id.toString()] = { step: 'CAST' };
    ctx.reply('📝 أرسل الرسالة:');
});

bot.action('my_replies', async (ctx) => {
    const c = await Reply.countDocuments({ userId: ctx.from.id.toString() });
    ctx.editMessageText(`🤖 الردود: ${c}`, Markup.inlineKeyboard([[Markup.button.callback('➕ إضافة', 'add_rep'), Markup.button.callback('❌ حذف', 'del_rep')], [Markup.button.callback('🔙 رجوع', 'services_menu')]]));
});
bot.action('add_rep', (ctx) => { userStates[ctx.from.id] = { step: 'WAIT_KEYWORD' }; ctx.reply('الكلمة المفتاحية:'); });
bot.action('del_rep', (ctx) => { userStates[ctx.from.id] = { step: 'WAIT_DEL_KEY' }; ctx.reply('الكلمة للحذف:'); });

// طلبات الاشتراك والمدير
bot.action('req_sub', async (ctx) => {
    const adminSet = await Setting.findOne({ key: 'admin_user' });
    ctx.editMessageText(`✅ تم الطلب.`, Markup.inlineKeyboard([[Markup.button.url('الدعم', `https://t.me/${adminSet ? adminSet.value : 'Admin'}`)]]));
    bot.telegram.sendMessage(ADMIN_ID, `🔔 طلب: \`${ctx.from.id}\``, Markup.inlineKeyboard([[Markup.button.callback('تفعيل 30 يوم', `act_${ctx.from.id}_30`)]]));
});
bot.action(/act_(.+)_(.+)/, async (ctx) => { 
    await User.findByIdAndUpdate(ctx.match[1], { expiry: Date.now() + (parseInt(ctx.match[2]) * 86400000) }, { upsert: true });
    ctx.editMessageText('✅ تم التفعيل.');
});
bot.action('admin_panel', (ctx) => ctx.editMessageText('🛠️ المدير:', Markup.inlineKeyboard([
    [Markup.button.callback('➕ تفعيل', 'adm_add'), Markup.button.callback('📢 نشر', 'adm_cast')],
    [Markup.button.callback('🔒 قناة', 'adm_force'), Markup.button.callback('🔙 رجوع', 'main_menu')]
])));
bot.action('adm_add', (ctx) => { userStates[ADMIN_ID] = { step: 'ADM_SUB_ID' }; ctx.reply('الآيدي (ID):'); });
bot.action('adm_cast', (ctx) => { userStates[ADMIN_ID] = { step: 'ADM_CAST' }; ctx.reply('الرسالة:'); });
bot.action('adm_force', (ctx) => { userStates[ADMIN_ID] = { step: 'ADM_CHAN' }; ctx.reply('يوزر القناة (أو off):'); });

// معالجة النصوص
bot.on('text', async (ctx) => {
    const userId = ctx.from.id.toString();
    const text = ctx.message.text;
    const state = userStates[userId];

    if (sessions[userId]?.step === 'WAIT_PHONE') {
        const phone = text.replace(/[^0-9]/g, '');
        ctx.reply('⏳ جاري الطلب...');
        delete sessions[userId].step;
        startBaileysSession(userId, ctx, phone);
        return;
    }

    if (userId == ADMIN_ID && state) {
        if (state.step === 'ADM_SUB_ID') { await User.findByIdAndUpdate(text, { expiry: Date.now() + 30*86400000 }, { upsert: true }); ctx.reply('✅ تم'); userStates[userId]=null; return; }
        if (state.step === 'ADM_CAST') { const h = await History.find({}); h.forEach(u => ctx.copyMessage(u._id).catch(()=>{})); ctx.reply('✅ تم'); userStates[userId]=null; return; }
        if (state.step === 'ADM_CHAN') { await Setting.findOneAndUpdate({key:'force_channel'}, {value:text}, {upsert:true}); ctx.reply('✅ تم'); userStates[userId]=null; return; }
    }

    const s = sessions[userId];
    if (state?.step === 'CAST' && s) {
        ctx.reply('⏳ جاري النشر...');
        for (const id of s.selected) { await s.sock.sendMessage(id, { text: text }); await delay(1000); }
        userStates[userId] = null;
        ctx.reply('✅ تم النشر.');
        return;
    }
    if (state?.step === 'WAIT_KEYWORD') { state.tempKey = text; state.step = 'WAIT_REPLY'; return ctx.reply('الرد؟'); }
    if (state?.step === 'WAIT_REPLY') { await Reply.create({ userId, keyword: state.tempKey, response: text }); userStates[userId]=null; return ctx.reply('✅ تم.'); }
    if (state?.step === 'WAIT_DEL_KEY') { await Reply.deleteMany({ userId, keyword: text }); userStates[userId]=null; return ctx.reply('✅ تم.'); }
});

bot.action('check_my_sub', async (ctx) => {
    const user = await User.findById(ctx.from.id.toString());
    const days = user ? Math.floor((user.expiry - Date.now()) / 86400000) : 0;
    ctx.reply(`الأيام: ${days}`);
});

bot.launch();
process.once('SIGINT', () => bot.stop());
