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
app.get('/', (req, res) => res.send('✅ Bot Running (Anti-Timeout Mode)'));
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// ============================================================
// 2. إعدادات قاعدة البيانات
// ============================================================
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN; 
const ADMIN_ID = process.env.ADMIN_ID; 
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI).then(() => restoreSessions()).catch(e => console.log(e));

const User = mongoose.model('User', new mongoose.Schema({ _id: String, expiry: Number }));
const Setting = mongoose.model('Setting', new mongoose.Schema({ key: String, value: String }));
const Reply = mongoose.model('Reply', new mongoose.Schema({ userId: String, keyword: String, response: String }));
const History = mongoose.model('History', new mongoose.Schema({ _id: String, date: Number }));

const sessions = {}; 
const userStates = {}; 
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
bot.catch((err) => console.log(`⚠️ Telegraf Error: ${err.message}`));

async function restoreSessions() {
    const authPath = './auth_info';
    if (fs.existsSync(authPath)) {
        const folders = fs.readdirSync(authPath).filter(f => f.startsWith('session_'));
        for (const folder of folders) {
            const userId = folder.replace('session_', '');
            const user = await User.findById(userId);
            if (user && user.expiry > Date.now()) {
                await sleep(5000); // انتظار طويل عند البدء لتخفيف الحمل
                startBaileysSession(userId, null);
            }
        }
    }
}

// ============================================================
// 3. محرك Baileys (إعدادات التوافق القصوى)
// ============================================================
async function startBaileysSession(userId, ctx) {
    if (sessions[userId] && sessions[userId].status === 'CONNECTING') return;

    if (ctx) ctx.reply('🚀 **جاري تجهيز الاتصال...**').catch(()=>{});

    const sessionDir = `./auth_info/session_${userId}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        // 🔥 التعديل السحري: استخدام اسم متصفح مخصص لتجاوز التعليق
        browser: ['Bota-Connect', 'Chrome', '3.0.0'], 
        syncFullHistory: false, // لا تحمل التاريخ القديم
        markOnlineOnConnect: false, // لا تظهر متصل فوراً (يساعد في التسريع)
        connectTimeoutMs: 60000, // 60 ثانية مهلة
        defaultQueryTimeoutMs: 0, // انتظار لانهائي للاستعلامات
        keepAliveIntervalMs: 10000, 
        retryRequestDelayMs: 5000
    });

    sessions[userId] = { sock, status: 'CONNECTING', selected: [], allGroups: [] };

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && ctx) {
            try {
                const buffer = await qrcode.toBuffer(qr);
                await ctx.deleteMessage().catch(()=>{});
                await ctx.replyWithPhoto({ source: buffer }, { 
                    caption: '📱 **امسح الرمز الآن**\n⚡ نصيحة: إذا تأخر الربط، قم بأرشفة بعض المحادثات في هاتفك.',
                    ...Markup.inlineKeyboard([[Markup.button.callback('🔄 تحديث', 'retry_login')]])
                });
            } catch (e) {}
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            console.log(`❌ Status: ${statusCode}`);
            
            // التعامل مع الخطأ 515 والخطأ 428 (Precondition Required)
            if (statusCode === 515 || statusCode === 428) {
                console.log('⏳ Network busy. Retrying in 5s...');
                setTimeout(() => startBaileysSession(userId, null), 5000);
                return;
            }

            if (statusCode === 401 || statusCode === 403 || statusCode === 405) {
                delete sessions[userId];
                if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                if (ctx) ctx.reply('⚠️ الجلسة غير صالحة. امسح الرمز مجدداً.');
            } 
            else if (statusCode !== DisconnectReason.loggedOut) {
                startBaileysSession(userId, null);
            } 
            else {
                delete sessions[userId];
                if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
                if (ctx) ctx.reply('❌ تم الخروج.');
            }
        } 
        else if (connection === 'open') {
            console.log(`✅ ${userId} Connected!`);
            sessions[userId].status = 'READY';
            if (ctx) {
                try { await ctx.deleteMessage(); } catch(e){}
                ctx.reply('✅ **تم الربط بنجاح!**', Markup.inlineKeyboard([[Markup.button.callback('📂 القائمة', 'main_menu')]]));
            }
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
// 4. القوائم + زر التصفير (Reset)
// ============================================================
bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const isAdmin = (ctx.from.id.toString() == ADMIN_ID);
    if (!isAdmin) {
        if (ctx.message && ['/start', '/reset'].includes(ctx.message.text)) return next();
        const user = await User.findById(ctx.from.id.toString());
        if (!user || user.expiry < Date.now()) return ctx.reply('⛔ اشتراكك منتهي.');
    }
    return next();
});

// زر التصفير لحل المشاكل العالقة
bot.command('reset', async (ctx) => {
    const userId = ctx.from.id.toString();
    const sessionDir = `./auth_info/session_${userId}`;
    if (sessions[userId]) { try { sessions[userId].sock.end(); } catch(e){} delete sessions[userId]; }
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    ctx.reply('☢️ **تم تصفير جلستك.**\nالآن حاول الربط من جديد.');
});

async function showMainMenu(ctx) {
    const isAdmin = (ctx.from.id.toString() == ADMIN_ID);
    let buttons = [
        [Markup.button.callback('🔗 ربط واتساب', 'open_dashboard')],
        [Markup.button.callback('📂 الخدمات', 'services_menu')],
        [Markup.button.callback('⏳ اشتراكي', 'check_my_sub')]
    ];
    if(isAdmin) buttons.push([Markup.button.callback('🛠️ المدير', 'admin_panel')]);
    try { await ctx.editMessageText('👋 لوحة التحكم', Markup.inlineKeyboard(buttons)); } 
    catch { await ctx.reply('👋 لوحة التحكم', Markup.inlineKeyboard(buttons)); }
}

bot.start((ctx) => showMainMenu(ctx));
bot.action('main_menu', (ctx) => showMainMenu(ctx));
bot.action('services_menu', (ctx) => {
    ctx.editMessageText('📂 الخدمات:', Markup.inlineKeyboard([
        [Markup.button.callback('📨 نشر', 'broadcast'), Markup.button.callback('⚙️ جروبات', 'fetch_groups')],
        [Markup.button.callback('🤖 ردود', 'my_replies'), Markup.button.callback('🔙 رجوع', 'main_menu')]
    ]));
});

bot.action('open_dashboard', (ctx) => {
    const s = sessions[ctx.from.id.toString()];
    if (s && s.status === 'READY') ctx.reply('✅ متصل.', Markup.inlineKeyboard([[Markup.button.callback('❌ خروج', 'logout')]]));
    else startBaileysSession(ctx.from.id.toString(), ctx);
});

bot.action('retry_login', async (ctx) => {
    const userId = ctx.from.id.toString();
    const dir = `./auth_info/session_${userId}`;
    if (sessions[userId]) delete sessions[userId];
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    try { await ctx.deleteMessage(); } catch(e) {}
    ctx.reply('🔄 محاولة جديدة...');
    setTimeout(() => startBaileysSession(userId, ctx), 2000);
});

bot.action('logout', async (ctx) => {
    const userId = ctx.from.id.toString();
    const dir = `./auth_info/session_${userId}`;
    if (sessions[userId]) { try { sessions[userId].sock.end(); } catch(e){} delete sessions[userId]; }
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    try { await ctx.deleteMessage(); } catch(e) {}
    ctx.reply('✅ تم الخروج.');
});

bot.action('fetch_groups', async (ctx) => {
    const s = sessions[ctx.from.id.toString()];
    if(!s || s.status !== 'READY') return ctx.reply('⚠️ غير متصل.');
    await ctx.answerCbQuery('جاري التحميل...');
    try {
        const groups = await s.sock.groupFetchAllParticipating();
        s.allGroups = Object.values(groups).map(g => ({ id: g.id, name: g.subject }));
        const btns = s.allGroups.slice(0, 20).map(g => [Markup.button.callback(`${s.selected.includes(g.id)?'✅':'⬜'} ${g.name.substr(0,10)}`, `sel_${g.id}`)]);
        btns.push([Markup.button.callback('✅ الكل', 'sel_all'), Markup.button.callback('❌ إلغاء', 'desel_all')]);
        btns.push([Markup.button.callback('حفظ', 'done_sel')]);
        ctx.editMessageText('اختر:', Markup.inlineKeyboard(btns));
    } catch { ctx.reply('❌ فشل جلب الجروبات'); }
});

bot.action(/sel_(.+)/, (ctx) => {
    const s = sessions[ctx.from.id.toString()];
    const id = ctx.match[1];
    s.selected.includes(id) ? s.selected = s.selected.filter(i=>i!==id) : s.selected.push(id);
    bot.telegram.answerCbQuery(ctx.callbackQuery.id, 'تم').catch(()=>{});
});
bot.action('sel_all', (ctx) => { sessions[ctx.from.id.toString()].selected = sessions[ctx.from.id.toString()].allGroups.map(g => g.id); ctx.answerCbQuery('تم'); });
bot.action('done_sel', (ctx) => { ctx.answerCbQuery('تم الحفظ'); showMainMenu(ctx); });

bot.action('broadcast', (ctx) => {
    if(!sessions[ctx.from.id.toString()]?.selected.length) return ctx.reply('⚠️ اختر جروبات.');
    userStates[ctx.from.id.toString()] = { step: 'CAST' };
    ctx.reply('📝 أرسل الرسالة:');
});

bot.on('text', async (ctx) => {
    const userId = ctx.from.id.toString();
    const s = sessions[userId];
    const state = userStates[userId];

    if (state?.step === 'CAST' && s) {
        ctx.reply('⏳ جاري النشر...');
        for (const id of s.selected) { await s.sock.sendMessage(id, { text: ctx.message.text }); await sleep(1000); }
        userStates[userId] = null;
        ctx.reply('✅ تم النشر.');
    }
    
    if (state?.step === 'WAIT_KEYWORD') { state.tempKey = ctx.message.text; state.step = 'WAIT_REPLY'; return ctx.reply('الرد؟'); }
    if (state?.step === 'WAIT_REPLY') { await Reply.create({ userId, keyword: state.tempKey, response: ctx.message.text }); userStates[userId]=null; return ctx.reply('تم.'); }

    if (userId == ADMIN_ID && state?.step) {
        if (state.step === 'ADM_SUB_ID') { await User.findByIdAndUpdate(ctx.message.text, { expiry: Date.now() + 30*86400000 }, { upsert:true }); ctx.reply('تم 30 يوم'); userStates[userId]=null; }
    }
});

bot.action('my_replies', async (ctx) => {
    const c = await Reply.countDocuments({ userId: ctx.from.id.toString() });
    ctx.editMessageText(`الردود: ${c}`, Markup.inlineKeyboard([[Markup.button.callback('➕', 'add_rep'), Markup.button.callback('🔙', 'services_menu')]]));
});
bot.action('add_rep', (ctx) => { userStates[ctx.from.id] = { step: 'WAIT_KEYWORD' }; ctx.reply('الكلمة؟'); });
bot.action('check_my_sub', (ctx) => ctx.reply('مشترك.'));
bot.action('req_sub', (ctx) => ctx.reply('تم الطلب.'));
bot.action('admin_panel', (ctx) => ctx.editMessageText('المدير:', Markup.inlineKeyboard([[Markup.button.callback('تفعيل', 'adm_add'), Markup.button.callback('🔙', 'main_menu')]])));
bot.action('adm_add', (ctx) => { userStates[ADMIN_ID]={step:'ADM_SUB_ID'}; ctx.reply('الآيدي؟'); });

bot.launch();
process.once('SIGINT', () => bot.stop());
