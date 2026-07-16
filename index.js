require('dotenv').config();
const express = require('express');
const cors = require('cors');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

const REQUIRED_ENV = ['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error('Set them in your .env file (local) or in Render > Environment (deployed).');
}

const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
};
const lineClient = new line.Client(lineConfig);
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_KEY || '');

const INCOME_CATEGORIES = ['เงินเดือน', 'โบนัส', 'ธุรกิจ', 'ลงทุน', 'ของขวัญ', 'อื่นๆ'];
const EXPENSE_CATEGORIES = ['อาหาร', 'เดินทาง', 'ที่พัก/บ้าน', 'ช้อปปิ้ง', 'บันเทิง', 'สุขภาพ', 'การศึกษา', 'สาธารณูปโภค', 'อื่นๆ'];

function genLinkCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const app = express();
app.use(cors());

// ===================================================================
// REST API used by the web app (finance-tracker.html)
// ===================================================================
const api = express.Router();
api.use(express.json());

// Create a new "device" (one web-app installation) and its link code.
api.get('/device/new', async (req, res) => {
  try {
    const code = genLinkCode();
    const { data, error } = await supabase
      .from('devices')
      .insert({ link_code: code })
      .select()
      .single();
    if (error) throw error;
    res.json({ device_id: data.id, link_code: data.link_code });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ไม่สามารถสร้างอุปกรณ์ใหม่ได้' });
  }
});

// Check whether a device has been linked to a LINE account yet.
api.get('/device/:id/status', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('devices')
      .select('line_user_id, link_code, monthly_budget')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    res.json({ linked: !!data.line_user_id, link_code: data.link_code });
  } catch (err) {
    console.error(err);
    res.status(404).json({ error: 'ไม่พบอุปกรณ์นี้' });
  }
});

api.get('/transactions', async (req, res) => {
  const { device_id } = req.query;
  if (!device_id) return res.status(400).json({ error: 'device_id required' });
  try {
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('device_id', device_id)
      .order('date', { ascending: false })
      .order('id', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ดึงรายการไม่สำเร็จ' });
  }
});

api.post('/transactions', async (req, res) => {
  const { device_id, type, category, description, amount, date } = req.body || {};
  if (!device_id || !type || !amount || !date) {
    return res.status(400).json({ error: 'missing fields' });
  }
  if (type !== 'income' && type !== 'expense') {
    return res.status(400).json({ error: 'type must be income or expense' });
  }
  try {
    const { data, error } = await supabase
      .from('transactions')
      .insert({
        device_id,
        type,
        category: category || 'อื่นๆ',
        description: description || '',
        amount,
        date,
      })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'บันทึกรายการไม่สำเร็จ' });
  }
});

api.delete('/transactions/:id', async (req, res) => {
  const { device_id } = req.query;
  if (!device_id) return res.status(400).json({ error: 'device_id required' });
  try {
    const { error } = await supabase
      .from('transactions')
      .delete()
      .eq('id', req.params.id)
      .eq('device_id', device_id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ลบรายการไม่สำเร็จ' });
  }
});

api.get('/budget', async (req, res) => {
  const { device_id } = req.query;
  if (!device_id) return res.status(400).json({ error: 'device_id required' });
  try {
    const { data, error } = await supabase
      .from('devices')
      .select('monthly_budget')
      .eq('id', device_id)
      .single();
    if (error) throw error;
    res.json({ monthly_budget: Number(data.monthly_budget) || 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ดึงงบประมาณไม่สำเร็จ' });
  }
});

api.post('/budget', async (req, res) => {
  const { device_id, monthly_budget } = req.body || {};
  if (!device_id || monthly_budget == null) return res.status(400).json({ error: 'missing fields' });
  try {
    const { error } = await supabase
      .from('devices')
      .update({ monthly_budget })
      .eq('id', device_id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'บันทึกงบประมาณไม่สำเร็จ' });
  }
});

app.use('/api', api);

app.get('/', (req, res) => {
  res.type('text').send('LINE slip finance bot is running.');
});

// ===================================================================
// LINE webhook — must NOT have express.json() applied before it, so
// the bot-sdk middleware can validate the raw body signature itself.
// ===================================================================
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).end();
  }
});

async function reply(event, message) {
  return lineClient.replyMessage(event.replyToken, message);
}

async function replyText(event, text) {
  return reply(event, { type: 'text', text });
}

async function getPending(lineUserId) {
  const { data } = await supabase.from('pending_slips').select('*').eq('line_user_id', lineUserId).single();
  return data || null;
}

async function clearPending(lineUserId) {
  await supabase.from('pending_slips').delete().eq('line_user_id', lineUserId);
}

async function handleEvent(event) {
  const userId = event.source && event.source.userId;
  if (!userId) return;

  if (event.type === 'message' && event.message.type === 'text') {
    return handleTextMessage(event, userId, event.message.text.trim());
  }

  if (event.type === 'message' && event.message.type === 'image') {
    return handleImageMessage(event, userId);
  }

  if (event.type === 'postback') {
    return handlePostback(event, userId, event.postback.data || '');
  }
}

async function handleTextMessage(event, userId, text) {
  // "ยกเลิก" cancels whatever the bot is currently waiting for.
  if (text === 'ยกเลิก') {
    await clearPending(userId);
    return replyText(event, 'ยกเลิกรายการที่ค้างอยู่แล้ว ส่งรูปสลิปใหม่ได้เลยเมื่อพร้อม');
  }

  // A bare 6-digit code is treated as a link request from the web app.
  if (/^\d{6}$/.test(text)) {
    const { data: device, error } = await supabase.from('devices').select('*').eq('link_code', text).single();
    if (error || !device) {
      return replyText(event, 'ไม่พบรหัสนี้ กรุณาคัดลอกรหัส 6 หลักจากหน้าเว็บแอปอีกครั้ง');
    }
    const { error: updateErr } = await supabase.from('devices').update({ line_user_id: userId }).eq('id', device.id);
    if (updateErr) {
      console.error(updateErr);
      return replyText(event, 'เชื่อมบัญชีไม่สำเร็จ ลองใหม่อีกครั้ง');
    }
    return replyText(event, 'เชื่อมบัญชีสำเร็จ ✅\nต่อไปนี้ส่งรูปสลิปโอนเงินมาได้เลย บอทจะถามยืนยันรายละเอียดก่อนบันทึกทุกครั้ง');
  }

  const pending = await getPending(userId);
  if (pending && pending.step === 'awaiting_amount') {
    const amount = parseFloat(text.replace(/,/g, ''));
    if (!amount || amount <= 0) {
      return replyText(event, 'กรุณาพิมพ์จำนวนเงินเป็นตัวเลขเท่านั้น เช่น 250 หรือ 250.50');
    }
    await supabase.from('pending_slips').update({ amount, step: 'awaiting_category' }).eq('line_user_id', userId);
    const cats = pending.type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    return reply(event, {
      type: 'text',
      text: `จำนวนเงิน ฿${amount.toLocaleString('th-TH')} — เลือกหมวดหมู่`,
      quickReply: {
        items: cats.map((c) => ({
          type: 'action',
          action: { type: 'postback', label: c, data: `cat=${encodeURIComponent(c)}`, displayText: c },
        })),
      },
    });
  }

  return replyText(event, 'ส่งรูปสลิปโอนเงินมาได้เลย 📸\nหรือพิมพ์รหัส 6 หลักจากหน้าเว็บแอปเพื่อเชื่อมบัญชีก่อนใช้งานครั้งแรก');
}

async function handleImageMessage(event, userId) {
  const { data: device } = await supabase.from('devices').select('*').eq('line_user_id', userId).single();
  if (!device) {
    return replyText(event, 'กรุณาเชื่อมบัญชีก่อน โดยพิมพ์รหัส 6 หลักที่แสดงในหน้าเว็บแอป');
  }

  await supabase.from('pending_slips').upsert({
    line_user_id: userId,
    device_id: device.id,
    step: 'awaiting_type',
    type: null,
    amount: null,
    category: null,
  });

  return reply(event, {
    type: 'text',
    text: 'ได้รับรูปสลิปแล้ว 📸 รายการนี้เป็นรายรับหรือรายจ่าย?',
    quickReply: {
      items: [
        { type: 'action', action: { type: 'postback', label: '💰 รายรับ', data: 'type=income', displayText: 'รายรับ' } },
        { type: 'action', action: { type: 'postback', label: '💸 รายจ่าย', data: 'type=expense', displayText: 'รายจ่าย' } },
      ],
    },
  });
}

async function handlePostback(event, userId, dataStr) {
  const params = new URLSearchParams(dataStr);
  const pending = await getPending(userId);
  if (!pending) {
    return replyText(event, 'ไม่พบรายการที่รอยืนยัน กรุณาส่งรูปสลิปใหม่อีกครั้ง');
  }

  if (params.has('type')) {
    const type = params.get('type');
    await supabase.from('pending_slips').update({ type, step: 'awaiting_amount' }).eq('line_user_id', userId);
    return replyText(event, `รับทราบ: ${type === 'income' ? 'รายรับ' : 'รายจ่าย'}\nพิมพ์จำนวนเงิน (ตัวเลขเท่านั้น) เช่น 250`);
  }

  if (params.has('cat')) {
    const category = params.get('cat');
    return finalizeTransaction(event, userId, { ...pending, category });
  }
}

async function finalizeTransaction(event, userId, pending) {
  const { error } = await supabase.from('transactions').insert({
    device_id: pending.device_id,
    type: pending.type,
    category: pending.category,
    description: 'บันทึกจาก LINE (สลิป)',
    amount: pending.amount,
    date: todayISO(),
  });
  await clearPending(userId);

  if (error) {
    console.error(error);
    return replyText(event, 'เกิดข้อผิดพลาดในการบันทึก กรุณาลองส่งรูปสลิปใหม่อีกครั้ง');
  }

  const webAppUrl = process.env.WEB_APP_URL || '';
  const typeLabel = pending.type === 'income' ? 'รายรับ' : 'รายจ่าย';
  const amountLabel = Number(pending.amount).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return replyText(
    event,
    `บันทึก${typeLabel} ฿${amountLabel} (${pending.category}) เรียบร้อย ✅` + (webAppUrl ? `\nดูสรุปที่: ${webAppUrl}` : '')
  );
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`LINE slip finance bot listening on port ${port}`);
});
