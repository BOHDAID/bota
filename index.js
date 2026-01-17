const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, delay, initAuthCreds, BufferJSON, proto, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');

// 1. Render Server
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('✅ Bot Running (Auto-Post Scheduler Added)'));
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// 2. Database
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN; 
const ADMIN_ID = process.env.ADMIN_ID; 
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
    .then(() => {
        console.log('✅ MongoDB Connected!');
        restoreSessions();
        restoreAutoPosts(); // استعادة مهام النشر التلقائي
    })
    .catch(err => console.error('❌ MongoDB Error:', err));

// Schemas
const User = mongoose.model('User', new mongoose.Schema({ _id: String, expiry: Number }));
const Setting = mongoose.model('Setting', new mongoose.Schema({ key: String, value: String }));
const Reply = mongoose.model('Reply', new mongoose.Schema({ userId: String, keyword: String, response: String }));
const History = mongoose.model('History', new mongoose.Schema({ _id: String, date: Number }));
const SessionModel = mongoose.model('AuthSession', new mongoose.Schema({ _id: String, data: String }));

// 🔥 جدول النشر التلقائي الجديد
const AutoPost = mongoose.model('AutoPost', new mongoose.Schema({
    userId: String,
    content: String,
    intervalMinutes: Number,
    groupIds: [String],
    active: Boolean
}));

// Variables
const sessions = {}; 
const userStates = {}; 
const msgRetryCounterCache = new Map();
// لتخزين المؤقتات النشطة (Timers)
const activeCronJobs = {}; 
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// 3. Auth System
const useMongoDBAuthState = async (sessionId) => {
    const writeData = async (data, key) => {
        try { await SessionModel.findByIdAndUpdate(`${sessionId}-${key}`, { data: JSON.stringify(data, BufferJSON.replacer) }, { upsert: true }); } catch (e) {}
    };
    const readData = async (key) => {
        try {
            const result = await SessionModel.findById(`${sessionId}-${key}`);
            if (result?.data) return JSON.parse(result.data, BufferJSON.reviver);
        } catch (e) {}
        return null;
    };
    const removeData = async (key) => { try { await SessionModel.findByIdAndDelete(`${sessionId}-${key}`); } catch (e) {} };
    let creds = await readData('creds');
    if (!creds) { creds = initAuthCreds(); await writeData(creds, 'creds'); }
    return { state: { creds, keys: { get: async (type, ids) => { const data = {}; await Promise.all(ids.map(async (id) => { let value = await readData(`${type}-${id}`); if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value); if (value) data[id] = value; })); return data; }, set: async (data) => { const tasks = []; for (const category in data) { for (const id in data[category]) { const value = data[category][id]; const key = `${category}-${id}`; if (value) tasks.push(writeData(value, key)); else tasks.push(removeData(key)); } } await Promise.all(tasks); } } }, saveCreds: () => writeData(creds, 'creds') };
};

async function restoreSessions() {
    try {
        const activeSessions = await SessionModel.find({ _id: { $regex: /-creds$/ } });
        for (const sess of activeSessions) {
            const userId = sess._id.replace('-creds', '');
            const user = await User.findById(userId);
            if (user && user.expiry > Date.now()) startBaileysSession(userId, null);
        }
    } catch (e) {}
}

// 🔥 استعادة المهام المجدولة عند تشغيل السيرفر
async function restoreAutoPosts() {
    const posts = await AutoPost.find({ active: true });
    console.log(`♻️ Restoring ${posts.length} auto-posts...`);
    posts.forEach(post => startAutoPostTimer(post));
}

// 🔥 تشغيل المؤقت للمهمة
function startAutoPostTimer(post) {
    // إيقاف القديم إن وجد لمنع التكرار
    if (activeCronJobs[post._id]) clearInterval(activeCronJobs[post._id]);

    const runTask = async () => {
        const s = sessions[post.userId];
        // التأكد أن المستخدم متصل
        if (s && s.status === 'READY') {
            console.log(`🚀 Auto-Posting for user ${post.userId}`);
            for (const groupId of post.groupIds) {
                try {
                    await s.sock.sendMessage(groupId, { text: post.content });
                    await delay(1000); // تأخير بسيط بين الجروبات
                } catch (e) { console.log(`Error posting to group: ${e.message}`); }
            }
        } else {
            console.log(`⚠️ User ${post.userId} not connected, skipping auto-post.`);
        }
    };

    // تشغيل فوري (اختياري)
    // runTask(); 

    // جدولة التكرار
    const timerId = setInterval(runTask, post.intervalMinutes * 60 * 1000);
    activeCronJobs[post._id] = timerId;
}

// 4. Baileys Engine
async function startBaileysSession(userId, ctx, phoneNumber = null) {
    if (sessions[userId] && sessions[userId].status === 'READY' && !phoneNumber) return;
    if (phoneNumber) await SessionModel.deleteMany({ _id: { $regex: `^${userId}-` } });

    const { state, saveCreds } = await useMongoDBAuthState(userId);
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
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 2000,
        getMessage: async (key) => { return { conversation: 'hello' }; }
    });

    sessions[userId] = { sock, status: 'CONNECTING', selected: [], allGroups: [], page: 0 };

    if (phoneNumber && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
                await delay(2000); 
                const code = await sock.requestPairingCode(cleanNumber);
                if (ctx) ctx.reply(`🔢 **رمز الربط:**\n\`${code}\``, { parse_mode: 'Markdown' });
            } catch (e) { if (ctx) ctx.reply('❌ فشل طلب الرمز.'); }
        }, 3000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            if (statusCode === 401 || statusCode === 403) {
                 delete sessions[userId];
                 await SessionModel.deleteMany({ _id: { $regex: `^${userId}-` } });
                 if (ctx) ctx.reply('⚠️ انتهت الجلسة.');
            } else if (statusCode !== DisconnectReason.loggedOut) {
                startBaileysSession(userId, null);
            } else {
                delete sessions[userId];
                await SessionModel.deleteMany({ _id: { $regex: `^${userId}-` } });
                if (ctx) ctx.reply('❌ تم تسجيل الخروج.');
            }
        } else if (connection === 'open') {
            console.log(`✅ ${userId} Connected!`);
            sessions[userId].status = 'READY';
            const kb = Markup.inlineKeyboard([
                [Markup.button.callback('⏰ النشر التلقائي', 'autopost_menu')],
                [Markup.button.callback('📨 نشر فوري', 'broadcast'), Markup.button.callback('⚙️ الجروبات', 'fetch_groups')],
                [Markup.button.callback('🤖 الردود', 'my_replies'), Markup.button.callback('❌ خروج', 'logout')]
            ]);
            if (ctx) ctx.reply('✅ **تم الاتصال بنجاح!**', kb);
            else bot.telegram.sendMessage(userId, '✅ **تم إعادة الاتصال.**', kb).catch(()=>{});
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

// 5. Middleware
bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    const userId = ctx.from.id.toString();
    try { await History.create({ _id: userId, date: Date.now() }); } catch(e) {} 
    const isAdmin = (userId == ADMIN_ID);

    if (ctx.callbackQuery && ctx.callbackQuery.data === 'check_sub') {
        try {
            const setting = await Setting.findOne({ key: 'force_channel' });
            if (setting && setting.value) {
                let channelUser = setting.value.startsWith('@') ? setting.value : `@${setting.value}`;
                const member = await ctx.telegram.getChatMember(channelUser, userId);
                if (['creator', 'administrator', 'member'].includes(member.status)) {
                    await ctx.deleteMessage();
                    await ctx.reply('✅ شكراً لاشتراكك!');
                    return showMainMenu(ctx);
                } else return ctx.answerCbQuery('❌ لم تشترك بعد!', { show_alert: true });
            }
        } catch (e) { return ctx.answerCbQuery('⚠️ خطأ', { show_alert: true }); }
    }

    if (!isAdmin) {
        try {
            const setting = await Setting.findOne({ key: 'force_channel' });
            if (setting && setting.value) {
                let channelUser = setting.value.startsWith('@') ? setting.value : `@${setting.value}`;
                try {
                    const member = await ctx.telegram.getChatMember(channelUser, userId);
                    if (['left', 'kicked'].includes(member.status)) throw new Error();
                } catch (err) {
                    return ctx.reply(`⛔ **اشترك في القناة أولاً:**\n${channelUser}`, Markup.inlineKeyboard([[Markup.button.callback('✅ تم الاشتراك', 'check_sub')]]));
                }
            }
        } catch (e) {}
        if (ctx.message && ['/start', '/reset'].includes(ctx.message.text)) return next();
        if (ctx.callbackQuery && ['login_check', 'logout'].includes(ctx.callbackQuery.data)) return next();
        const user = await User.findById(userId);
        if (!user || user.expiry < Date.now()) return ctx.reply('⛔ اشتراكك منتهي.');
    }
    return next();
});

// 6. UI & Logic
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
        if (isConnected) {
            buttons.push([Markup.button.callback('⏰ النشر التلقائي (مجدول)', 'autopost_menu')]);
            buttons.push([Markup.button.callback('🚀 خدمات فورية (نشر/ردود)', 'services_menu')]);
            buttons.push([Markup.button.callback('❌ تسجيل خروج', 'logout')]);
        } else {
            buttons.push([Markup.button.callback('🔗 ربط واتساب', 'login_check')]);
        }
        buttons.push([Markup.button.callback('⏳ اشتراكي', 'check_my_sub')]);
        if (isAdmin) buttons.push([Markup.button.callback('🛠️ المدير', 'admin_panel')]);
    } else {
        const adminSet = await Setting.findOne({ key: 'admin_user' });
        buttons.push([Markup.button.callback('🛒 طلب اشتراك', 'req_sub')]);
    }
    try { await ctx.editMessageText(msg, Markup.inlineKeyboard(buttons)); } catch { await ctx.reply(msg, Markup.inlineKeyboard(buttons)); }
}

bot.start((ctx) => showMainMenu(ctx));
bot.action('main_menu', (ctx) => showMainMenu(ctx));
bot.action('login_check', (ctx) => {
    const userId = ctx.from.id.toString();
    if (sessions[userId] && sessions[userId].status === 'READY') ctx.reply('✅ متصل.');
    else { ctx.reply('📞 هات رقمك (9665xxxxxxxx):'); sessions[userId] = { step: 'WAIT_PHONE' }; }
});
bot.action('logout', async (ctx) => {
    const userId = ctx.from.id.toString();
    if (sessions[userId]?.sock) { try{sessions[userId].sock.end()}catch(e){} }
    delete sessions[userId];
    await SessionModel.deleteMany({ _id: { $regex: `^${userId}-` } });
    // إيقاف كل المهام المجدولة لهذا المستخدم
    const posts = await AutoPost.find({ userId });
    posts.forEach(p => { if(activeCronJobs[p._id]) clearInterval(activeCronJobs[p._id]); });
    await AutoPost.updateMany({ userId }, { active: false });
    ctx.editMessageText('✅ تم الخروج وإيقاف المهام.');
});

bot.action('services_menu', (ctx) => {
    ctx.editMessageText('📂 **الخدمات الفورية:**', Markup.inlineKeyboard([
        [Markup.button.callback('📨 نشر للكل', 'broadcast'), Markup.button.callback('⚙️ الجروبات', 'fetch_groups')],
        [Markup.button.callback('🤖 الردود', 'my_replies'), Markup.button.callback('🔙 القائمة', 'main_menu')]
    ]));
});

// 🔥🔥🔥 نظام النشر التلقائي (Auto Post UI) 🔥🔥🔥
bot.action('autopost_menu', async (ctx) => {
    const userId = ctx.from.id.toString();
    const tasks = await AutoPost.find({ userId: userId });
    let msg = `⏰ **مهام النشر التلقائي:**\nلديك (${tasks.length}) مهام.\n\n`;
    tasks.forEach((t, i) => {
        msg += `${i+1}. 📝 "${t.content.substring(0, 10)}..." \n⏳ كل ${t.intervalMinutes} دقيقة | 🟢 ${t.active ? 'نشط' : 'متوقف'}\n\n`;
    });

    ctx.editMessageText(msg, Markup.inlineKeyboard([
        [Markup.button.callback('➕ إنشاء مهمة جديدة', 'new_autopost')],
        [Markup.button.callback('❌ حذف كل المهام', 'del_all_autopost')],
        [Markup.button.callback('🔙 القائمة', 'main_menu')]
    ]));
});

bot.action('new_autopost', (ctx) => {
    const userId = ctx.from.id.toString();
    if (!sessions[userId]?.selected.length) return ctx.reply('⚠️ **يجب عليك اختيار الجروبات أولاً!**\nاذهب إلى "الخدمات > الجروبات" وحدد الجروبات ثم عد إلى هنا.');
    userStates[userId] = { step: 'WAIT_AUTO_MSG' };
    ctx.reply('📝 **أرسل الرسالة التي تريد نشرها تلقائياً:**');
});

bot.action('del_all_autopost', async (ctx) => {
    const userId = ctx.from.id.toString();
    const tasks = await AutoPost.find({ userId });
    tasks.forEach(t => { if(activeCronJobs[t._id]) clearInterval(activeCronJobs[t._id]); });
    await AutoPost.deleteMany({ userId });
    ctx.reply('✅ تم حذف وإيقاف جميع المهام.');
});

// Groups & Pagination
bot.action('fetch_groups', async (ctx) => {
    const s = sessions[ctx.from.id.toString()];
    if(!s || s.status !== 'READY') return ctx.reply('⚠️ غير متصل.');
    await ctx.answerCbQuery('جاري التحميل...');
    try {
        const groups = await s.sock.groupFetchAllParticipating();
        s.allGroups = Object.values(groups).map(g => ({ id: g.id, name: g.subject || 'بدون اسم' }));
        s.page = 0;
        sendGroupMenu(ctx, ctx.from.id.toString());
    } catch { ctx.reply('❌ خطأ'); }
});

async function sendGroupMenu(ctx, userId) {
    const s = sessions[userId];
    const page = s.page || 0;
    const perPage = 10;
    const maxPage = Math.ceil(s.allGroups.length / perPage) - 1;
    const currentGroups = s.allGroups.slice(page * perPage, (page + 1) * perPage);

    let btns = currentGroups.map(g => [Markup.button.callback(`${s.selected.includes(g.id)?'✅':'⬜'} ${g.name.substring(0,15)}`, `sel_${g.id}`)]);
    let nav = [];
    if(page > 0) nav.push(Markup.button.callback('⬅️', 'prev_page'));
    if(page < maxPage) nav.push(Markup.button.callback('➡️', 'next_page'));
    if(nav.length) btns.push(nav);
    
    btns.push([Markup.button.callback('✅ الكل', 'sel_page'), Markup.button.callback('❌ إلغاء', 'desel_all')]);
    btns.push([Markup.button.callback(`💾 حفظ التحديد (${s.selected.length})`, 'save_selection')]); // زر مهم للعودة

    try { await ctx.editMessageText(`📂 **الجروبات (${page+1}/${maxPage+1}):**`, Markup.inlineKeyboard(btns)); } 
    catch { await ctx.reply(`📂 **الجروبات:**`, Markup.inlineKeyboard(btns)); }
}

bot.action('save_selection', (ctx) => { ctx.answerCbQuery('تم الحفظ'); showMainMenu(ctx); });
bot.action('next_page', (ctx) => { sessions[ctx.from.id.toString()].page++; sendGroupMenu(ctx, ctx.from.id.toString()); });
bot.action('prev_page', (ctx) => { sessions[ctx.from.id.toString()].page--; sendGroupMenu(ctx, ctx.from.id.toString()); });
bot.action('sel_page', (ctx) => { 
    const s = sessions[ctx.from.id.toString()];
    const page = s.page||0;
    s.allGroups.slice(page*10, (page+1)*10).forEach(g => { if(!s.selected.includes(g.id)) s.selected.push(g.id); });
    sendGroupMenu(ctx, ctx.from.id.toString());
});
bot.action(/sel_(.+)/, (ctx) => {
    const s = sessions[ctx.from.id.toString()];
    const id = ctx.match[1];
    s.selected.includes(id) ? s.selected = s.selected.filter(i=>i!==id) : s.selected.push(id);
    sendGroupMenu(ctx, ctx.from.id.toString());
});
bot.action('desel_all', (ctx) => { sessions[ctx.from.id.toString()].selected = []; sendGroupMenu(ctx, ctx.from.id.toString()); });

bot.action('broadcast', (ctx) => {
    if(!sessions[ctx.from.id.toString()]?.selected.length) return ctx.reply('⚠️ اختر جروبات.');
    userStates[ctx.from.id.toString()] = { step: 'CAST' };
    ctx.reply('📝 الرسالة:');
});
bot.action('my_replies', async (ctx) => {
    const c = await Reply.countDocuments({ userId: ctx.from.id.toString() });
    ctx.editMessageText(`🤖 الردود: ${c}`, Markup.inlineKeyboard([[Markup.button.callback('➕ إضافة', 'add_rep'), Markup.button.callback('❌ حذف', 'del_rep')], [Markup.button.callback('🔙 رجوع', 'services_menu')]]));
});
bot.action('add_rep', (ctx) => { userStates[ctx.from.id] = { step: 'WAIT_KEYWORD' }; ctx.reply('الكلمة:'); });
bot.action('del_rep', (ctx) => { userStates[ctx.from.id] = { step: 'WAIT_DEL_KEY' }; ctx.reply('الكلمة:'); });
bot.action('req_sub', async (ctx) => {
    const adminSet = await Setting.findOne({ key: 'admin_user' });
    ctx.editMessageText(`✅ تم الطلب.`, Markup.inlineKeyboard([[Markup.button.url('الدعم', `https://t.me/${adminSet ? adminSet.value : 'Admin'}`)]]));
    bot.telegram.sendMessage(ADMIN_ID, `🔔 طلب: \`${ctx.from.id}\``, Markup.inlineKeyboard([[Markup.button.callback('تفعيل', `act_${ctx.from.id}_30`)]]));
});
bot.action(/act_(.+)_(.+)/, async (ctx) => { await User.findByIdAndUpdate(ctx.match[1], { expiry: Date.now() + (parseInt(ctx.match[2]) * 86400000) }, { upsert: true }); ctx.editMessageText('✅'); });
bot.action('admin_panel', (ctx) => ctx.editMessageText('🛠️', Markup.inlineKeyboard([[Markup.button.callback('تفعيل', 'adm_add'), Markup.button.callback('نشر', 'adm_cast')], [Markup.button.callback('قناة', 'adm_force'), Markup.button.callback('🔙', 'main_menu')]])));
bot.action('adm_add', (ctx) => { userStates[ADMIN_ID] = { step: 'ADM_SUB_ID' }; ctx.reply('ID:'); });
bot.action('adm_cast', (ctx) => { userStates[ADMIN_ID] = { step: 'ADM_CAST' }; ctx.reply('msg:'); });
bot.action('adm_force', (ctx) => { userStates[ADMIN_ID] = { step: 'ADM_CHAN' }; ctx.reply('User:'); });

// Text Handler
bot.on('text', async (ctx) => {
    const userId = ctx.from.id.toString();
    const text = ctx.message.text;
    const state = userStates[userId];

    if (sessions[userId]?.step === 'WAIT_PHONE') {
        const phone = text.replace(/[^0-9]/g, '');
        ctx.reply('⏳...'); delete sessions[userId].step; startBaileysSession(userId, ctx, phone); return;
    }

    // 🔥 خطوات النشر التلقائي
    if (state?.step === 'WAIT_AUTO_MSG') {
        state.tempMsg = text;
        state.step = 'WAIT_AUTO_TIME';
        return ctx.reply('⏳ **كم دقيقة الفاصل الزمني؟**\n(مثال: اكتب 1 لدقيقة، أو 60 لساعة)');
    }
    if (state?.step === 'WAIT_AUTO_TIME') {
        const mins = parseInt(text);
        if (isNaN(mins) || mins < 1) return ctx.reply('⚠️ رقم خاطئ. أرسل عدد الدقائق (أرقام فقط):');
        
        // حفظ المهمة
        const newPost = await AutoPost.create({
            userId,
            content: state.tempMsg,
            intervalMinutes: mins,
            groupIds: sessions[userId].selected, // الجروبات المحددة حالياً
            active: true
        });

        startAutoPostTimer(newPost); // تشغيل
        userStates[userId] = null;
        return ctx.reply(`✅ **تمت جدولة المهمة بنجاح!**\nسيتم النشر كل ${mins} دقيقة.`);
    }

    if (userId == ADMIN_ID && state) {
        if (state.step === 'ADM_SUB_ID') { await User.findByIdAndUpdate(text, { expiry: Date.now() + 30*86400000 }, { upsert: true }); ctx.reply('✅'); userStates[userId]=null; return; }
        if (state.step === 'ADM_CAST') { const h = await History.find({}); h.forEach(u => ctx.copyMessage(u._id).catch(()=>{})); ctx.reply('✅'); userStates[userId]=null; return; }
        if (state.step === 'ADM_CHAN') { await Setting.findOneAndUpdate({key:'force_channel'}, {value:text}, {upsert:true}); ctx.reply('✅'); userStates[userId]=null; return; }
    }

    const s = sessions[userId];
    if (state?.step === 'CAST' && s) {
        ctx.reply('⏳...'); for (const id of s.selected) { await s.sock.sendMessage(id, { text: text }); await delay(1000); }
        userStates[userId] = null; ctx.reply('✅'); return;
    }
    if (state?.step === 'WAIT_KEYWORD') { state.tempKey = text; state.step = 'WAIT_REPLY'; return ctx.reply('الرد؟'); }
    if (state?.step === 'WAIT_REPLY') { await Reply.create({ userId, keyword: state.tempKey, response: text }); userStates[userId]=null; return ctx.reply('✅'); }
    if (state?.step === 'WAIT_DEL_KEY') { await Reply.deleteMany({ userId, keyword: text }); userStates[userId]=null; return ctx.reply('✅'); }
});

bot.action('check_my_sub', async (ctx) => {
    const user = await User.findById(ctx.from.id.toString());
    const days = user ? Math.floor((user.expiry - Date.now()) / 86400000) : 0;
    ctx.reply(`${days}`);
});

bot.launch();
process.once('SIGINT', () => bot.stop());
