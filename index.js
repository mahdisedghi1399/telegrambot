require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

const { BOT_TOKEN, ADMIN_ID, CHANNEL_ID, WEBHOOK_URL, PROXY_URL, PORT = 3000 } = process.env;

if (!BOT_TOKEN || !ADMIN_ID || !CHANNEL_ID) {
  console.error('BOT_TOKEN, ADMIN_ID and CHANNEL_ID must be set in .env');
  process.exit(1);
}

// پروکسی (برای وقتی که تلگرام فیلتر است)
// نمونه: socks5://127.0.0.1:10808  یا  http://127.0.0.1:10809
let agent;
if (PROXY_URL) {
  if (PROXY_URL.startsWith('socks')) {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    agent = new SocksProxyAgent(PROXY_URL);
  } else {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    agent = new HttpsProxyAgent(PROXY_URL);
  }
  console.log('Using proxy:', PROXY_URL);
}

const bot = new Telegraf(BOT_TOKEN, agent ? { telegram: { agent } } : {});
const app = express();

// ---------- ذخیره‌سازی ساده ----------
const DB_FILE = path.join(__dirname, 'data.json');
let db = { counter: 0, adminMsgToUser: {} };
try {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch (_) {}
const saveDb = () => fs.writeFileSync(DB_FILE, JSON.stringify(db));

// ---------- دسته‌بندی‌ها ----------
const CATEGORIES = {
  vpn: { title: '🔐 فروش وی پی ان', hint: 'نوع سرویس، مدت زمان و تعداد کاربر مورد نظرتان را بنویسید.' },
  appleid: { title: '🍎 اپل آیدی', hint: 'نوع اپل آیدی (کشور/نوع) و توضیحات خود را بنویسید.' },
  software: { title: '💻 خدمات نرم‌افزاری', hint: 'خدمات یا نرم‌افزار مورد نظر و توضیحات خود را بنویسید.' },
};

// وضعیت کاربران (دسته انتخاب‌شده)
const pending = new Map();

const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const mainMenu = () =>
  Markup.inlineKeyboard([
    ...Object.entries(CATEGORIES).map(([key, c]) => [Markup.button.callback(c.title, `cat:${key}`)]),
  ]);

const isAdmin = (ctx) => String(ctx.from?.id) === String(ADMIN_ID);

// ---------- شروع ----------
bot.start((ctx) => {
  pending.delete(ctx.from.id);
  return ctx.reply('سلام 👋\nلطفاً دسته‌بندی مورد نظرتان را انتخاب کنید:', mainMenu());
});

bot.command('cancel', (ctx) => {
  pending.delete(ctx.from.id);
  return ctx.reply('لغو شد. برای شروع دوباره دسته‌بندی را انتخاب کنید:', mainMenu());
});

// ---------- انتخاب دسته ----------
bot.action(/^cat:(.+)$/, async (ctx) => {
  const key = ctx.match[1];
  const cat = CATEGORIES[key];
  if (!cat) return ctx.answerCbQuery('دسته نامعتبر');
  pending.set(ctx.from.id, key);
  await ctx.answerCbQuery();
  await ctx.reply(
    `${cat.title}\n\n${cat.hint}\n\nپیام خود را همین‌جا بنویسید و ارسال کنید 👇`,
    Markup.inlineKeyboard([[Markup.button.callback('❌ انصراف', 'cancel')]])
  );
});

bot.action('cancel', async (ctx) => {
  pending.delete(ctx.from.id);
  await ctx.answerCbQuery('لغو شد');
  await ctx.reply('درخواست لغو شد. دسته‌بندی را انتخاب کنید:', mainMenu());
});

// ---------- دریافت پیام مشتری / پاسخ ادمین ----------
bot.on('text', async (ctx) => {
  const text = ctx.message.text;

  // پاسخ ادمین (Reply روی پیام درخواست) -> ارسال برای مشتری
  if (isAdmin(ctx) && ctx.message.reply_to_message) {
    const userId = db.adminMsgToUser[ctx.message.reply_to_message.message_id];
    if (userId) {
      try {
        await bot.telegram.sendMessage(userId, `📩 پاسخ ادمین:\n\n${text}`);
        return ctx.reply('✅ برای مشتری ارسال شد.');
      } catch (e) {
        return ctx.reply('❌ ارسال ناموفق بود (شاید کاربر ربات را بلاک کرده).');
      }
    }
  }

  if (text.startsWith('/')) return;

  const key = pending.get(ctx.from.id);
  if (!key) {
    return ctx.reply('ابتدا دسته‌بندی مورد نظرتان را انتخاب کنید:', mainMenu());
  }

  const cat = CATEGORIES[key];
  const u = ctx.from;
  const name = esc([u.first_name, u.last_name].filter(Boolean).join(' '));
  const username = u.username ? `@${esc(u.username)}` : 'ندارد';
  db.counter += 1;
  const id = db.counter;

  const report =
    `📥 <b>درخواست جدید #${id}</b>\n` +
    `📂 دسته: <b>${esc(cat.title)}</b>\n` +
    `👤 نام: ${name}\n` +
    `🔗 یوزرنیم: ${username}\n` +
    `🆔 آیدی عددی: <code>${u.id}</code>\n\n` +
    `💬 پیام:\n${esc(text)}`;

  try {
    // ارسال برای ادمین
    const adminMsg = await bot.telegram.sendMessage(ADMIN_ID, report + '\n\n<i>برای پاسخ، روی همین پیام Reply بزنید.</i>', {
      parse_mode: 'HTML',
    });
    db.adminMsgToUser[adminMsg.message_id] = u.id;
    saveDb();

    // ارسال در کانال
    await bot.telegram.sendMessage(CHANNEL_ID, report, { parse_mode: 'HTML' });

    pending.delete(u.id);
    await ctx.reply(`✅ درخواست شما با شماره #${id} ثبت شد.\nبه‌زودی ادمین پاسخ می‌دهد.`, mainMenu());
  } catch (err) {
    console.error('send error:', err.message);
    await ctx.reply('❌ خطا در ثبت درخواست. لطفاً دوباره تلاش کنید.');
  }
});

// پیام‌های غیر متنی
bot.on('message', (ctx) => ctx.reply('لطفاً فقط پیام متنی ارسال کنید.'));

bot.catch((err) => console.error('Bot error:', err));

// ---------- اجرای Express ----------
app.get('/', (_req, res) => res.send('Bot is running'));

(async () => {
  try {
    if (WEBHOOK_URL) {
      app.use(bot.webhookCallback('/telegram'));
      await bot.telegram.setWebhook(`${WEBHOOK_URL.replace(/\/$/, '')}/telegram`);
      console.log('Webhook set');
      app.listen(PORT, () => console.log(`Express listening on ${PORT}`));
    } else {
      app.listen(PORT, () => console.log(`Express listening on ${PORT}`));
      await bot.telegram.deleteWebhook();
      bot.launch();
      console.log('Bot started with polling');
    }
  } catch (err) {
    console.error('\n❌ اتصال به تلگرام برقرار نشد:', err.message);
    console.error('اگر در ایران هستید تلگرام فیلتر است. PROXY_URL را در .env تنظیم کنید یا ربات را روی سرور خارج از ایران اجرا کنید.\n');
    process.exit(1);
  }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));