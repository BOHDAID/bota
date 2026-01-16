const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const mongoose = require('mongoose');
const express = require('express');
const axios = require('axios');
const { execSync } = require('child_process');

// ============================================================
// 1. سيرفر Render
// ============================================================
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('✅ Bot Running (Memory Saver Mode)'));
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// ============================================================
// 2. الاتصال بالقاعدة
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
    console.log('🔄 Checking saved sessions...');
    const authPath = path.join(__dirname, '.wwebjs_auth');
    if (fs.existsSync(authPath)) {
        const folders = fs.readdirSync(authPath).filter(f => f.startsWith('session_user_'));
        for (const folder of folders) {
            const userId = folder.replace('session_user_', '');
            try {
                const user = await User.findById(userId);
                if (user && user.expiry > Date.now()) {
                    await startUserSession(userId, null); 
                    await sleep(10000); 
                }
            } catch (e) {}
        }
    }
}

function getChromeExecutablePath() {
    try {
        const cacheDir = path.join(__dirname, '.cache', 'chrome');
        if (fs.existsSync(cacheDir)) {
            const command = `find ${cacheDir} -name chrome -type f -executable | head -n 1`;
            const chromePath = execSync(command).toString().trim();
            if (chromePath) return chromePath;
        }
    } catch (error) {}
    return undefined;
}

// ============================================================
// 3. إدارة الجلسات (وضع توفير الذاكرة الأقصى)
// ============================================================
async function startUserSession(userId, ctx) {
    if (sessions[userId]) {
        if (sessions[userId].status === 'READY') {
            if (ctx) ctx.reply('✅ **متصل.**', Markup.inlineKeyboard([[Markup.button.callback('📂 الخدمات', 'services_menu')], [Markup.button.callback('❌ خروج', 'logout')]]));
            return;
        }
        if (sessions[userId].status === 'QR_SENT') return;
    }

    if (ctx) ctx.editMessageText('🚀 **جاري التشغيل (وضع خفيف)...**').catch(()=>{});

    const chromePath = getChromeExecutablePath();

    const client = new Client({
        authStrategy: new LocalAuth({ 
            clientId: `user_${userId}`,
            dataPath: path.join(__dirname, '.wwebjs_auth')
        }),
        puppeteer: { 
            headless: true,
            executablePath: chromePath,
            // 🛑 إعدادات منع امتلاء الذاكرة (Memory Leak Protection) 🛑
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--single-process', // تشغيل عملية واحدة فقط
                '--disable-gpu',
                '--disable-extensions',
                '--disable-software-rasterizer',
                '--mute-audio',
                '--disable-notifications',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync', // تعطيل المزامنة الخلفية
                '--renderer-process-limit=1', // إجبار كروم على استخدام تبويب واحد فقط
                '--disable-features=site-per-process' // توفير هائل للرام
            ] 
        },
        authTimeoutMs: 120000, 
        qrMaxRetries: 5,
    });

    sessions[userId] = { client: client, selected: [], publishing: false, groups: [], status: 'INITIALIZING' };

    client.on('qr', async (qr) => {
        if (sessions[userId].status === 'QR_SENT') return;
        sessions[userId].status = 'QR_SENT';

        if(ctx) {
            try {
                const buffer = await qrcode.toBuffer(qr);
                await ctx.deleteMessage().catch(()=>{});
                await ctx.replyWithPhoto({ source: buffer }, { 
                    caption: '📱 **امسح الرمز**\nتم تخفيف الإعدادات لضمان الاتصال.\nإذا تأخر قليلاً فهذا طبيعي.',
                    ...Markup.inlineKeyboard([[Markup.button.callback('🔄 تحديث الرمز', 'retry_login')]])
                });
            } catch (e) {}
        }
    });

    // عند نجاح المصادقة
    client.on('authenticated', () => {
        console.log(`✅ User ${userId} Authenticated!`);
        // لا نرسل رسالة هنا لتجنب تكرار التنبيهات، ننتظر الجاهزية
    });

    client.on('ready', () => {
        sessions[userId].status = 'READY';
        console.log(`✅ User ${userId} Ready!`);
        if(ctx) bot.telegram.sendMessage(userId, '🎉 **تم الاتصال بنجاح!**\nالبوت جاهز الآن.').catch(()=>{});
    });

    client.on('auth_failure', () => { 
        sessions[userId].status = 'FAILED'; 
        if(ctx) ctx.reply('❌ فشل.', Markup.inlineKeyboard([[Markup.button.callback('🔄 تحديث', 'retry_login')]]));
    });

    client.on('disconnected', (reason) => { 
        if (sessions[userId]) sessions[userId].status = 'DISCONNECTED'; 
        cleanupSession(userId);
    });

    client.on('message', async (msg) => {
        if (msg.fromMe || msg.isStatus) return;
        try {
            const replies = await Reply.find({ userId: userId });
            for (const rep of replies) {
                if (msg.body.toLowerCase().includes(rep.keyword.toLowerCase())) {
                    await msg.reply(rep.response); break;
                }
            }
        } catch (e) {}
    });

    try { 
        await client.initialize(); 
    } catch (error) { 
        console.error(`❌ Error (${userId}):`, error.message);
        if(ctx) ctx.reply('⚠️ الذاكرة ممتلئة، اضغط تحديث.', Markup.inlineKeyboard([[Markup.button.callback('🔄 تحديث', 'retry_login')]]));
        await cleanupSession(userId);
    }
}

bot.action('retry_login', async (ctx) => {
    const userId = ctx.from.id.toString();
    ctx.editMessageText('🧹 **تنظيف الذاكرة...**').catch(()=>{});
    await cleanupSession(userId);
    await sleep(2000);
    await startUserSession(userId, ctx); 
});

bot.action('logout', async (ctx) => {
    const userId = ctx.from.id.toString();
    ctx.editMessageText('⏳ **خروج...**').catch(()=>{});
    await cleanupSession(userId);
    ctx.reply('✅ **تم.**', Markup.inlineKeyboard([[Markup.button.callback('🔙 القائمة', 'main_menu')]]));
});

async function cleanupSession(userId) {
    if (sessions[userId]) { try { await sessions[userId].client.destroy(); } catch (e) {} delete sessions[userId]; }
    const sessionDir = path.join(__dirname, '.wwebjs_auth', `session_user_${userId}`);
    if (fs.existsSync(sessionDir)) { try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {} }
}

// ============================================================
// 4. بقية الأوامر (كما هي)
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

async function showMainMenu(ctx) {
    const userId = ctx.from.id.toString();
    const isAdmin = (userId == ADMIN_ID);
    const user = await User.findById(userId);
    const isPaid = (user && user.expiry > Date.now());

    let msg = `👋 **مرحباً بك**\n\n`;
    let buttons = [];

    if (isAdmin || isPaid) {
        msg += isAdmin ? "👑 **المدير**\n" : `✅ **مشترك فعال**\n`;
        buttons.push([Markup.button.callback('🔗 واتساب / الحالة', 'open_dashboard')]);
        buttons.push([Markup.button.callback('📂 الخدمات', 'services_menu')]);
        buttons.push([Markup.button.callback('⏳ اشتراكي', 'check_my_sub')]);
        if (isAdmin) buttons.push([Markup.button.callback('🛠️ لوحة المدير', 'admin_panel')]);
    } else {
        const adminSet = await Setting.findOne({ key: 'admin_user' });
        msg += `⛔ **غير مفعل**\nتواصل مع: @${adminSet ? adminSet.value : 'Admin'}`;
        buttons.push([Markup.button.callback('🛒 طلب اشتراك', 'req_sub')]);
    }
    try { await ctx.editMessageText(msg, Markup.inlineKeyboard(buttons)); } catch { await ctx.reply(msg, Markup.inlineKeyboard(buttons)); }
}

async function showServicesMenu(ctx) {
    const kb = Markup.inlineKeyboard([
        [Markup.button.callback('📨 نشر', 'broadcast'), Markup.button.callback('⚙️ جروبات', 'fetch_groups')],
        [Markup.button.callback('🤖 ردود', 'my_replies'), Markup.button.callback('🔙 القائمة', 'main_menu')]
    ]);
    try { await ctx.editMessageText('📂 **الخدمات:**', kb); } catch { await ctx.reply('📂 **الخدمات:**', kb); }
}

bot.start((ctx) => showMainMenu(ctx));
bot.action('main_menu', (ctx) => showMainMenu(ctx));
bot.action('services_menu', (ctx) => showServicesMenu(ctx));
bot.action('open_dashboard', (ctx) => startUserSession(ctx.from.id.toString(), ctx));

bot.action('check_my_sub', async (ctx) => {
    const userId = ctx.from.id.toString();
    if (userId == ADMIN_ID) return ctx.reply('👑 مدير.');
    const user = await User.findById(userId);
    if (user && user.expiry > Date.now()) {
        const days = Math.floor((user.expiry - Date.now()) / 86400000);
        ctx.reply(`✅ باقي ${days} يوم`);
    } else { ctx.reply('⛔ منتهي.'); }
});

bot.action('req_sub', async (ctx) => {
    const adminSet = await Setting.findOne({ key: 'admin_user' });
    ctx.editMessageText(`✅ تم الإرسال.`, Markup.inlineKeyboard([[Markup.button.url('تواصل', `https://t.me/${adminSet ? adminSet.value : 'Admin'}`)]]));
    bot.telegram.sendMessage(ADMIN_ID, `🔔 طلب: \`${ctx.from.id}\``, 
        Markup.inlineKeyboard([[Markup.button.callback('30 يوم', `act_${ctx.from.id}_30`), Markup.button.callback('يدوي', `manual_days_${ctx.from.id}`)], [Markup.button.callback('رفض', `reject_${ctx.from.id}`)]]));
});

bot.action(/act_(.+)_(.+)/, async (ctx) => { await activateUser(ctx, ctx.match[1], parseInt(ctx.match[2])); });
bot.action(/manual_days_(.+)/, (ctx) => { userStates[ADMIN_ID] = { step: 'TYPE_DAYS_FOR_REQ', targetId: ctx.match[1] }; ctx.reply('🔢 عدد الايام:'); });
async function activateUser(ctx, targetId, days) {
    await User.findByIdAndUpdate(targetId, { expiry: Date.now() + (days * 86400000) }, { upsert: true });
    await bot.telegram.sendMessage(targetId, `🎉 تم التفعيل ${days} يوم.`).catch(()=>{});
    if(ctx.updateType==='callback_query') ctx.editMessageText('✅ تم التفعيل.');
}
bot.action(/reject_(.+)/, async (ctx) => { 
    try { await bot.telegram.sendMessage(ctx.match[1], '❌ تم الرفض.').catch(()=>{}); } catch(e){}
    ctx.editMessageText('❌ تم الرفض.'); 
});

bot.action('fetch_groups', async (ctx) => {
    const s = sessions[ctx.from.id.toString()];
    if(!s?.client?.info) return ctx.reply('⚠️ اربط الواتساب.');
    await ctx.answerCbQuery('تحميل...');
    const chats = await s.client.getChats();
    s.groups = chats.filter(c => c.isGroup && !c.isReadOnly);
    sendGroupMenu(ctx, ctx.from.id.toString());
});

async function sendGroupMenu(ctx, userId) {
    const s = sessions[userId];
    const btns = s.groups.slice(0, 30).map(g => [Markup.button.callback(`${s.selected.includes(g.id._serialized)?'✅':'⬜'} ${g.name.substring(0,15)}`, `sel_${g.id._serialized}`)]);
    btns.push([Markup.button.callback('✅ الكل', 'sel_all'), Markup.button.callback('❌ إلغاء', 'desel_all')]);
    btns.push([Markup.button.callback(`💾 حفظ (${s.selected.length})`, 'done_sel')]);
    try { await ctx.editMessageText('اختر:', Markup.inlineKeyboard(btns)); } catch { ctx.reply('اختر:', Markup.inlineKeyboard(btns)); }
}

bot.action(/sel_(.+)/, (ctx) => {
    const s = sessions[ctx.from.id.toString()];
    const id = ctx.match[1];
    s.selected.includes(id) ? s.selected = s.selected.filter(i=>i!==id) : s.selected.push(id);
    sendGroupMenu(ctx, ctx.from.id.toString());
});
bot.action('sel_all', (ctx) => { sessions[ctx.from.id.toString()].selected = sessions[ctx.from.id.toString()].groups.map(g => g.id._serialized); sendGroupMenu(ctx, ctx.from.id.toString()); });
bot.action('desel_all', (ctx) => { sessions[ctx.from.id.toString()].selected = []; sendGroupMenu(ctx, ctx.from.id.toString()); });
bot.action('done_sel', (ctx) => { ctx.answerCbQuery('تم الحفظ'); showServicesMenu(ctx); });

bot.action('broadcast', (ctx) => {
    if (!sessions[ctx.from.id.toString()]?.selected.length) return ctx.reply('⚠️ اختر الجروبات.');
    userStates[ctx.from.id.toString()] = { step: 'WAIT_CONTENT' };
    ctx.reply('📝 أرسل المحتوى:');
});
bot.action('my_replies', async (ctx) => {
    const count = await Reply.countDocuments({ userId: ctx.from.id.toString() });
    ctx.editMessageText(`🤖 ردود: ${count}`, Markup.inlineKeyboard([[Markup.button.callback('➕', 'add_rep'), Markup.button.callback('❌', 'del_rep')], [Markup.button.callback('🔙', 'services_menu')]]));
});
bot.action('add_rep', (ctx) => { userStates[ctx.from.id] = { step: 'WAIT_KEYWORD' }; ctx.reply('الكلمة؟'); });
bot.action('del_rep', (ctx) => { userStates[ctx.from.id] = { step: 'WAIT_DEL_KEY' }; ctx.reply('للحذف؟'); });

bot.action('admin_panel', async (ctx) => {
    const total = await User.countDocuments();
    ctx.editMessageText(`🛠️ ${total} مشترك`, Markup.inlineKeyboard([[Markup.button.callback('➕ تفعيل', 'adm_add'), Markup.button.callback('❌ حذف', 'adm_del')], [Markup.button.callback('📢 برودكاست', 'adm_cast'), Markup.button.callback('🔒 قناة', 'adm_force')], [Markup.button.callback('🔙', 'main_menu')]]));
});
bot.action('adm_add', (ctx) => { userStates[ADMIN_ID] = { step: 'ADM_SUB_ID' }; ctx.reply('الآيدي؟'); });
bot.action('adm_del', (ctx) => { userStates[ADMIN_ID] = { step: 'ADM_DEL_ID' }; ctx.reply('الآيدي؟'); });
bot.action('adm_cast', (ctx) => { userStates[ADMIN_ID] = { step: 'ADM_CAST' }; ctx.reply('الرسالة؟'); });
bot.action('adm_force', (ctx) => { userStates[ADMIN_ID] = { step: 'ADM_CHAN' }; ctx.reply('اليوزر؟ (أو off)'); });

bot.on(['text', 'photo', 'video'], async (ctx) => {
    const userId = ctx.from.id.toString();
    const text = ctx.message.caption || ctx.message.text || ''; 

    if (userId == ADMIN_ID && userStates[userId]) {
        const step = userStates[userId].step;
        if (step === 'TYPE_DAYS_FOR_REQ') { await activateUser(ctx, userStates[userId].targetId, parseInt(text)); userStates[userId] = null; return; }
        if (step === 'ADM_SUB_ID') { userStates[userId].tempId = text; userStates[userId].step = 'ADM_SUB_DAYS'; return ctx.reply('الايام؟'); }
        if (step === 'ADM_SUB_DAYS') { await activateUser(ctx, userStates[userId].tempId, parseInt(text)); userStates[userId] = null; return; }
        if (step === 'ADM_DEL_ID') { await User.findByIdAndDelete(text); userStates[userId] = null; return ctx.reply('تم.'); }
        if (step === 'ADM_CAST') {
            const h = await History.find({}); ctx.reply(`إرسال لـ ${h.length}...`);
            for(const item of h) { try { await ctx.copyMessage(item._id); } catch {} await sleep(50); }
            userStates[userId] = null; return ctx.reply('تم.');
        }
        if (step === 'ADM_CHAN') {
            if(text==='off' || text==='حذف') await Setting.findOneAndDelete({key:'force_channel'});
            else await Setting.findOneAndUpdate({key:'force_channel'},{value:text},{upsert:true});
            userStates[userId] = null; return ctx.reply('تم.');
        }
    }

    const session = sessions[userId];
    const state = userStates[userId];

    if (state?.step === 'WAIT_KEYWORD') { state.tempKey = text; state.step = 'WAIT_REPLY'; return ctx.reply('الرد؟'); }
    if (state?.step === 'WAIT_REPLY') { await Reply.create({ userId, keyword: state.tempKey, response: text }); userStates[userId] = null; ctx.reply('تم.'); return; }
    if (state?.step === 'WAIT_DEL_KEY') { await Reply.deleteMany({ userId, keyword: text }); userStates[userId] = null; ctx.reply('تم.'); return; }

    if (state?.step === 'WAIT_CONTENT' && session) {
        session.media = null;
        if (ctx.message.photo) {
            const link = await bot.telegram.getFileLink(ctx.message.photo.pop().file_id);
            const res = await axios.get(link.href, { responseType: 'arraybuffer' });
            session.media = new MessageMedia('image/jpeg', Buffer.from(res.data).toString('base64'), 'img.jpg');
            session.text = ctx.message.caption || '';
        } else if (ctx.message.video) {
            const link = await bot.telegram.getFileLink(ctx.message.video.file_id);
            const res = await axios.get(link.href, { responseType: 'arraybuffer' });
            session.media = new MessageMedia('video/mp4', Buffer.from(res.data).toString('base64'), 'video.mp4');
            session.text = ctx.message.caption || '';
        } else session.text = text;
        state.step = 'WAIT_DELAY';
        return ctx.reply('السرعة (دقائق)؟ (0 للقصوى)');
    }

    if (state?.step === 'WAIT_DELAY' && session) {
        session.delay = parseInt(text) || 0;
        session.publishing = true;
        userStates[userId] = null;
        ctx.reply('🚀 بدأ!', Markup.inlineKeyboard([[Markup.button.callback('⛔ إيقاف', 'stop_pub')]]));
        let sent = 0;
        while(session.publishing) {
            for(const id of session.selected) {
                if(!session.publishing) break;
                try {
                    if(session.media) await session.client.sendMessage(id, session.media, { caption: session.text });
                    else await session.client.sendMessage(id, session.text);
                    sent++;
                } catch {}
                await sleep(300); 
            }
            if(!session.publishing || !session.selected.length) break;
            if(session.delay > 0) await sleep(session.delay * 60000); else break;
        }
        bot.telegram.sendMessage(userId, `✅ انتهى: ${sent}`);
    }
});
bot.action('stop_pub', (ctx) => { if(sessions[ctx.from.id]) sessions[ctx.from.id].publishing = false; ctx.reply('🛑 تم.'); });

bot.launch();
process.once('SIGINT', () => bot.stop());
