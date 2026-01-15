const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const mongoose = require('mongoose');
const express = require('express');
const axios = require('axios'); // تأكدنا من إضافتها

// ============================================================
// 🌍 1. إعداد السيرفر (أول خطوة لمنع أخطاء Render)
// ============================================================
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('✅ Bot is Running...');
});

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});

// ============================================================
// 🔐 2. المتغيرات البيئية (من Render)
// ============================================================
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN; 
const ADMIN_ID = process.env.ADMIN_ID; 
const MONGO_URI = process.env.MONGO_URI;

// التحقق من وجود المتغيرات
if (!TELEGRAM_BOT_TOKEN || !ADMIN_ID || !MONGO_URI) {
    console.error("❌ خطأ: تأكد من إضافة BOT_TOKEN و ADMIN_ID و MONGO_URI في إعدادات Render Environment Variables");
    // لن نوقف العملية لتجنب انهيار السيرفر، لكن البوت لن يعمل بشكل صحيح
}

// ============================================================
// ☁️ 3. قاعدة البيانات
// ============================================================
mongoose.connect(MONGO_URI)
    .then(() => {
        console.log('✅ MongoDB Connected!');
        restoreSessions(); 
    })
    .catch(err => console.error('❌ MongoDB Error:', err));

// تعريف الجداول
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

// ============================================================
// 🛡️ 4. حماية النظام
// ============================================================
process.on('uncaughtException', (err) => console.log('⚠️ Error:', err.message));
process.on('unhandledRejection', (err) => console.log('⚠️ Rejection:', err.message));

// إصلاح ملفات الواتساب
const libFile = path.join(__dirname, 'node_modules', 'whatsapp-web.js', 'src', 'Client.js');
try {
    if (fs.existsSync(libFile)) {
        let content = fs.readFileSync(libFile, 'utf8');
        if (content.includes('window.WWebJS.markedUnread')) {
            content = content.replace(/window\.WWebJS\.markedUnread/g, '(()=>true)');
            content = content.replace(/window\.WWebJS\.sendSeen/g, '(()=>true)');
            fs.writeFileSync(libFile, content, 'utf8');
        }
    }
} catch (err) {}

// ============================================================
// 🤖 5. كود البوت
// ============================================================
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

async function fetchAdmin() {
    try {
        const chat = await bot.telegram.getChat(ADMIN_ID);
        if(chat.username) {
            ADMIN_USERNAME_CACHE = chat.username;
            await Setting.findOneAndUpdate({ key: 'admin_user' }, { value: chat.username }, { upsert: true });
        }
    } catch (e) {}
}
if(ADMIN_ID) fetchAdmin(); // تشغيل فقط إذا كان الآيدي موجوداً

async function restoreSessions() {
    console.log('🔄 استعادة الجلسات...');
    const authPath = path.join(__dirname, '.wwebjs_auth');
    if (fs.existsSync(authPath)) {
        const folders = fs.readdirSync(authPath).filter(f => f.startsWith('session_user_'));
        for (const folder of folders) {
            const userId = folder.replace('session_user_', '');
            const user = await User.findById(userId);
            if (user && user.expiry > Date.now()) {
                await startUserSession(userId, null); 
                await sleep(5000);
            }
        }
    }
}

// 🏭 إدارة الجلسات
async function startUserSession(userId, ctx) {
    if (sessions[userId]) {
        if (sessions[userId].status === 'READY') {
            if (ctx) ctx.reply('✅ **أنت متصل بالفعل!**', Markup.inlineKeyboard([[Markup.button.callback('📂 الخدمات', 'services_menu')], [Markup.button.callback('❌ خروج', 'logout')]]));
            return;
        }
        if (sessions[userId].status === 'QR_SENT') return;
    }

    if (ctx) ctx.editMessageText('⚙️ **جاري التجهيز...**').catch(()=>{});

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: `user_${userId}` }),
        puppeteer: { 
            headless: true, 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] 
        }
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
                    caption: '📱 **امسح الرمز**\nاضغط تحديث إذا لم يظهر.',
                    ...Markup.inlineKeyboard([[Markup.button.callback('🔄 تحديث الرمز', 'retry_login')]])
                });
            } catch (e) {}
        }
    });

    client.on('ready', () => {
        sessions[userId].status = 'READY';
        if(ctx) bot.telegram.sendMessage(userId, '✅ **تم الربط بنجاح!**').catch(()=>{});
        console.log(`User ${userId} Ready`);
    });

    client.on('auth_failure', () => { sessions[userId].status = 'FAILED'; if(ctx) ctx.reply('❌ فشل الاتصال.'); });
    client.on('disconnected', () => { if (sessions[userId]) sessions[userId].status = 'DISCONNECTED'; });

    client.on('message', async (msg) => {
        if (msg.fromMe || msg.isStatus) return;
        const replies = await Reply.find({ userId: userId });
        for (const rep of replies) {
            if (msg.body.toLowerCase().includes(rep.keyword.toLowerCase())) {
                await msg.reply(rep.response);
                break;
            }
        }
    });

    try { await client.initialize(); } catch (error) { if(ctx) ctx.reply('خطأ في التشغيل.'); }
}

bot.action('retry_login', async (ctx) => {
    const userId = ctx.from.id.toString();
    ctx.editMessageText('🔄 **تحديث...**').catch(()=>{});
    await cleanupSession(userId);
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

// 🔐 التحقق
bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const userId = ctx.from.id.toString();
    try { await History.create({ _id: userId, date: Date.now() }); } catch(e) {} 
    const isAdmin = (userId == ADMIN_ID);

    if (!isAdmin) {
        const setting = await Setting.findOne({ key: 'force_channel' });
        if (setting && setting.value) {
            try {
                const member = await ctx.telegram.getChatMember(setting.value, userId);
                if (!['creator', 'administrator', 'member'].includes(member.status)) throw new Error();
            } catch {
                return ctx.reply(`⛔ **اشترك أولاً:** ${setting.value}`, Markup.inlineKeyboard([[Markup.button.callback('✅ تم', 'check_sub')]]));
            }
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

// 📱 القوائم
async function showMainMenu(ctx) {
    const userId = ctx.from.id.toString();
    const isAdmin = (userId == ADMIN_ID);
    const user = await User.findById(userId);
    const isPaid = (user && user.expiry > Date.now());

    let msg = `👋 **مرحباً بك**\n\n`;
    let buttons = [];

    if (isAdmin || isPaid) {
        msg += isAdmin ? "👑 **المدير**\n" : `✅ **مشترك فعال**\n`;
        msg += `🚀 القائمة الرئيسية:`;
        buttons.push([Markup.button.callback('🔗 واتساب / الحالة', 'open_dashboard')]);
        buttons.push([Markup.button.callback('📂 النشر والردود', 'services_menu')]);
        buttons.push([Markup.button.callback('⏳ فحص اشتراكي', 'check_my_sub')]);
        if (isAdmin) buttons.push([Markup.button.callback('🛠️ لوحة المدير', 'admin_panel')]);
    } else {
        const adminSet = await Setting.findOne({ key: 'admin_user' });
        const adminName = adminSet ? adminSet.value : ADMIN_USERNAME_CACHE;
        msg += `⛔ **غير مفعل**\nتواصل مع: @${adminName}`;
        buttons.push([Markup.button.callback('🛒 طلب اشتراك', 'req_sub')]);
    }
    try { await ctx.editMessageText(msg, Markup.inlineKeyboard(buttons)); } catch { await ctx.reply(msg, Markup.inlineKeyboard(buttons)); }
}

async function showServicesMenu(ctx) {
    const txt = '📂 **الخدمات:**';
    const kb = Markup.inlineKeyboard([
        [Markup.button.callback('📨 نشر جماعي', 'broadcast'), Markup.button.callback('⚙️ الجروبات', 'fetch_groups')],
        [Markup.button.callback('🤖 الردود', 'my_replies'), Markup.button.callback('🔙 القائمة', 'main_menu')]
    ]);
    try { await ctx.editMessageText(txt, kb); } catch { await ctx.reply(txt, kb); }
}

bot.start((ctx) => showMainMenu(ctx));
bot.action('main_menu', (ctx) => showMainMenu(ctx));
bot.action('services_menu', (ctx) => showServicesMenu(ctx));

bot.action('check_my_sub', async (ctx) => {
    const userId = ctx.from.id.toString();
    if (userId == ADMIN_ID) return ctx.reply('👑 أنت المدير.');
    const user = await User.findById(userId);
    if (user && user.expiry > Date.now()) {
        const days = Math.floor((user.expiry - Date.now()) / (86400000));
        ctx.reply(`✅ **نشط** (باقي ${days} يوم)`);
    } else { ctx.reply('⛔ منتهي.'); }
});

bot.action('req_sub', async (ctx) => {
    const adminSet = await Setting.findOne({ key: 'admin_user' });
    const adminName = adminSet ? adminSet.value : 'Admin';
    ctx.editMessageText(`✅ **تم الإرسال.** تواصل مع @${adminName}`, Markup.inlineKeyboard([[Markup.button.url('💬 المدير', `https://t.me/${adminName}`)]]));
    bot.telegram.sendMessage(ADMIN_ID, `🔔 **طلب جديد:** \`${ctx.from.id}\``, 
        Markup.inlineKeyboard([
            [Markup.button.callback('30 يوم', `act_${ctx.from.id}_30`), Markup.button.callback('✏️ يدوي', `manual_days_${ctx.from.id}`)],
            [Markup.button.callback('❌ رفض', `reject_${ctx.from.id}`)]
        ]));
});

bot.action(/act_(.+)_(.+)/, async (ctx) => { await activateUser(ctx, ctx.match[1], parseInt(ctx.match[2])); });
bot.action(/manual_days_(.+)/, (ctx) => { userStates[ADMIN_ID] = { step: 'TYPE_DAYS_FOR_REQ', targetId: ctx.match[1] }; ctx.reply('🔢 الأيام:'); });
async function activateUser(ctx, targetId, days) {
    await User.findByIdAndUpdate(targetId, { expiry: Date.now() + (days * 86400000) }, { upsert: true });
    await bot.telegram.sendMessage(targetId, `🎉 تم التفعيل ${days} يوم.`).catch(()=>{});
    if(ctx.updateType === 'callback_query') ctx.editMessageText('✅ تم.');
}
bot.action(/reject_(.+)/, (ctx) => { bot.telegram.sendMessage(ctx.match[1], '❌ مرفوض.').catch(()=>{}); ctx.editMessageText('❌ تم الرفض.'); });

bot.action('open_dashboard', async (ctx) => { await startUserSession(ctx.from.id.toString(), ctx); });
bot.action('fetch_groups', async (ctx) => {
    const s = sessions[ctx.from.id.toString()];
    if(!s?.client?.info) return ctx.reply('⚠️ اربط الواتساب.');
    ctx.answerCbQuery('تحميل...');
    const chats = await s.client.getChats();
    s.groups = chats.filter(c => c.isGroup && !c.isReadOnly);
    sendGroupMenu(ctx, ctx.from.id.toString());
});

async function sendGroupMenu(ctx, userId) {
    const s = sessions[userId];
    const btns = s.groups.slice(0, 30).map(g => [Markup.button.callback(`${s.selected.includes(g.id._serialized)?'✅':'⬜'} ${g.name.substring(0,15)}`, `sel_${g.id._serialized}`)]);
    btns.push([Markup.button.callback('✅ الكل', 'sel_all'), Markup.button.callback('❌ إلغاء', 'desel_all')]);
    btns.push([Markup.button.callback(`💾 حفظ (${s.selected.length})`, 'done_sel')]);
    try { await ctx.editMessageText('📂 **اختر:**', Markup.inlineKeyboard(btns)); } catch { ctx.reply('📂 **اختر:**', Markup.inlineKeyboard(btns)); }
}

bot.action(/sel_(.+)/, (ctx) => {
    const s = sessions[ctx.from.id.toString()];
    const id = ctx.match[1];
    s.selected.includes(id) ? s.selected = s.selected.filter(i=>i!==id) : s.selected.push(id);
    sendGroupMenu(ctx, ctx.from.id.toString());
});
bot.action('sel_all', (ctx) => { const s = sessions[ctx.from.id.toString()]; s.selected = s.groups.map(g => g.id._serialized); sendGroupMenu(ctx, ctx.from.id.toString()); });
bot.action('desel_all', (ctx) => { sessions[ctx.from.id.toString()].selected = []; sendGroupMenu(ctx, ctx.from.id.toString()); });
bot.action('done_sel', (ctx) => { ctx.answerCbQuery('حفظ'); showServicesMenu(ctx); });

bot.action('broadcast', (ctx) => {
    if (!sessions[ctx.from.id.toString()]?.selected.length) return ctx.reply('⚠️ اختر الجروبات.');
    userStates[ctx.from.id.toString()] = { step: 'WAIT_CONTENT' };
    ctx.reply('📝 **أرسل المحتوى:**');
});

bot.action('my_replies', async (ctx) => {
    const count = await Reply.countDocuments({ userId: ctx.from.id.toString() });
    ctx.editMessageText(`🤖 **ردودك:** (${count})`, Markup.inlineKeyboard([[Markup.button.callback('➕ إضافة', 'add_rep'), Markup.button.callback('❌ حذف', 'del_rep')], [Markup.button.callback('🔙', 'services_menu')]]));
});
bot.action('add_rep', (ctx) => { userStates[ctx.from.id] = { step: 'WAIT_KEYWORD' }; ctx.reply('الكلمة؟'); });
bot.action('del_rep', (ctx) => { userStates[ctx.from.id] = { step: 'WAIT_DEL_KEY' }; ctx.reply('للحذف؟'); });

bot.action('admin_panel', async (ctx) => {
    const total = await User.countDocuments();
    ctx.editMessageText(`🛠️ **تحكم:** ${total} مشترك`, Markup.inlineKeyboard([[Markup.button.callback('➕ تفعيل', 'adm_add'), Markup.button.callback('❌ حذف', 'adm_del')], [Markup.button.callback('📢 برودكاست', 'adm_cast'), Markup.button.callback('🔒 قناة', 'adm_force')], [Markup.button.callback('🔙', 'main_menu')]]));
});
bot.action('adm_add', (ctx) => { userStates[ADMIN_ID] = { step: 'ADM_SUB_ID' }; ctx.reply('الآيدي؟'); });
bot.action('adm_del', (ctx) => { userStates[ADMIN_ID] = { step: 'ADM_DEL_ID' }; ctx.reply('الآيدي؟'); });
bot.action('adm_cast', (ctx) => { userStates[ADMIN_ID] = { step: 'ADM_CAST' }; ctx.reply('الرسالة؟'); });
bot.action('adm_force', (ctx) => { userStates[ADMIN_ID] = { step: 'ADM_CHAN' }; ctx.reply('يوزر القناة؟ (أو "off" للإيقاف)'); });

bot.on(['text', 'photo', 'video'], async (ctx) => {
    const userId = ctx.from.id.toString();
    const text = ctx.message.caption || ctx.message.text || ''; 

    if (userId == ADMIN_ID && userStates[userId]) {
        const step = userStates[userId].step;
        if (step === 'TYPE_DAYS_FOR_REQ') { await activateUser(ctx, userStates[userId].targetId, parseInt(text)); userStates[userId] = null; return; }
        if (step === 'ADM_SUB_ID') { userStates[userId].tempId = text; userStates[userId].step = 'ADM_SUB_DAYS'; return ctx.reply('الأيام؟'); }
        if (step === 'ADM_SUB_DAYS') { await activateUser(ctx, userStates[userId].tempId, parseInt(text)); userStates[userId] = null; return; }
        if (step === 'ADM_DEL_ID') { await User.findByIdAndDelete(text); userStates[userId] = null; return ctx.reply('✅ تم.'); }
        if (step === 'ADM_CAST') {
            const history = await History.find({});
            ctx.reply(`⏳ إرسال لـ ${history.length}...`);
            for(const h of history) { try { await ctx.copyMessage(h._id); } catch {} await sleep(50); }
            userStates[userId] = null; return ctx.reply('✅ تم.');
        }
        if (step === 'ADM_CHAN') {
            if(text==='off') { await Setting.findOneAndDelete({key:'force_channel'}); ctx.reply('تم الإيقاف.'); }
            else { await Setting.findOneAndUpdate({key:'force_channel'},{value:text},{upsert:true}); ctx.reply('✅ تم.'); }
            userStates[userId] = null; return;
        }
    }

    const session = sessions[userId];
    const state = userStates[userId];

    if (state?.step === 'WAIT_KEYWORD') { state.tempKey = text; state.step = 'WAIT_REPLY'; return ctx.reply('الرد؟'); }
    if (state?.step === 'WAIT_REPLY') { await Reply.create({ userId, keyword: state.tempKey, response: text }); userStates[userId] = null; ctx.reply('✅ تم.'); return; }
    if (state?.step === 'WAIT_DEL_KEY') { await Reply.deleteMany({ userId, keyword: text }); userStates[userId] = null; ctx.reply('✅ تم.'); return; }

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
        return ctx.reply('🏎️ **السرعة (دقائق):** (0 للقصوى)');
    }

    if (state?.step === 'WAIT_DELAY' && session) {
        session.delay = parseInt(text) || 0;
        session.publishing = true;
        userStates[userId] = null;
        ctx.reply('🚀 **بدأ!**', Markup.inlineKeyboard([[Markup.button.callback('⛔ إيقاف', 'stop_pub')]]));
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
        bot.telegram.sendMessage(userId, `✅ **انتهى.** المرسل: ${sent}`);
    }
});

bot.action('stop_pub', (ctx) => { if(sessions[ctx.from.id]) sessions[ctx.from.id].publishing = false; ctx.reply('🛑 تم.'); });

// 🚀 تشغيل البوت مع Express (لضمان Render)
bot.launch();
console.log('Bot Launched');
