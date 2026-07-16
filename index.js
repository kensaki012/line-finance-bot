require('dotenv').config();
const express = require('express');
const cors = require('cors');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
const { createWorker } = require('tesseract.js');

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

function thisMonth() {
  return todayISO().slice(0, 7);
}

function nextMonthISO(month) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m, 1); // m is already 0-indexed for "next month"
  return d.toISOString().slice(0, 10);
}

function fmtBaht(n) {
  return '฿' + Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const app = express();
app.use(cors());

let ocrWorkerPromise = null;
async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker('eng');
  }
  return ocrWorkerPromise;
}

async function ocrExtractText(buffer) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(buffer);
  return data.text || '';
}

function guessAmountFromText(text) {
  const cleaned = text.replace(/,/g, '');
  const decimalMatches = cleaned.match(/\d+\.\d{2}\b/g) || [];
  const candidates = decimalMatches.map(Number).filter((n) => n >= 1 && n <= 10000000);
  if (candidates.length) return Math.max(...candidates);

  const intMatches = cleaned.match(/\b\d{2,7}\b/g) || [];
  const intCandidates = intMatches.map(Number).filter((n) => n >= 1 && n <= 10000000);
  if (intCandidates.length) return Math.max(...intCandidates);

  return null;
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function checkBudgetAndNotify(deviceId) {
  try {
    const { data: device } = await supabase.from('devices').select('*').eq('id', deviceId).single();
    if (!device || !device.line_user_id || !device.monthly_budget || Number(device.monthly_budget) <= 0) return;

    const month = thisMonth();
    const { data: rows } = await supabase
      .from('transactions')
      .select('amount')
      .eq('device_id', deviceId)
      .eq('type', 'expense')
      .gte('date', `${month}-01`)
      .lt('date', nextMonthISO(month));

    const spent = (rows || []).reduce((s, r) => s + Number(r.amount), 0);
    const budget = Number(device.monthly_budget);
    const pct = (spent / budget) * 100;

    const currentLevel = device.last_budget_alert_month === month ? device.last_budget_alert_level || 0 : 0;
    const targetLevel = pct >= 100 ? 100 : pct >= 80 ? 80 : 0;

    if (targetLevel > currentLevel) {
      const msg =
        targetLevel >= 100
          ? `⚠️ เกินงบประมาณเดือนนี้แล้ว!\nใช้ไป ${fmtBaht(spent)} จากงบ ${fmtBaht(budget)}`
          : `⏳ ใช้งบไปแล้ว ${Math.round(pct)}% ของเดือนนี้\n${fmtBaht(spent)} จากงบ ${fmtBaht(budget)}`;
      try {
        await lineClient.pushMessage(device.line_user_id, { type: 'text', text: msg });
      } catch (err) {
        console.error('Budget alert push failed:', err);
      }
      await supabase
        .from('devices')
        .update({ last_budget_alert_level: targetLevel, last_budget_alert_month: month })
        .eq('id', deviceId);
    } else if (device.last_budget_alert_month !== month) {
      await supabase.from('devices').update({ last_budget_alert_level: 0, last_budget_alert_month: month }).eq('id', deviceId);
    }
  } catch (err) {
    console.error('checkBudgetAndNotify error:', err);
  }
}

const api = express.Router();
api.use(express.json());

api.get('/device/new', async (req, res) => {
  try {
    const code = genLinkCode();
    const { data, error } = await supabase.from('devices').insert({ link_code: code }).select().single();
    if (error) throw error;
    res.json({ device_id: data.id, link_code: data.link_code });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ไม่สามารถสร้างอุปกรณ์ใหม่ได้' });
  }
});

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
    checkBudgetAndNotify(device_id);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'บันทึกรายการไม่สำเร็จ' });
  }
});

api.delete('/transactions/:id', async (req, res) => {
  const { device_id } = req.query;
  if (!device_id) return res.status(400).json({ error: 'device_id required' });
  try {
    const { error } = await supabase.from('transactions').delete().eq('id', req.params.id).eq('device_id', device_id);
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
    const { data, error } = await supabase.from('devices').select('monthly_budget').eq('id', device_id).single();
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
    const { error } = await supabase.from('devices').update({ monthly_budget }).eq('id', device_id);
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

async function getDeviceByLineUser(lineUserId) {
  const { data } = await supabase.from('devices').select('*').eq('line_user_id', lineUserId).single();
  return data || null;
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
  if (text === 'ยกเลิก') {
    await clearPending(userId);
    return replyText(event, 'ยกเลิกรายการที่ค้างอยู่แล้ว ส่งรูปสลิปใหม่ หรือพิมพ์ "รายรับ"/"รายจ่าย" ได้เลยเมื่อพร้อม');
  }

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
    return replyText(
      event,
      'เชื่อมบัญชีสำเร็จ ✅\nส่งรูปสลิปโอนเงินมาได้เลย บอทจะถามยืนยันรายละเอียดก่อนบันทึกทุกครั้ง\nหรือพิมพ์ "สรุป" เพื่อดูยอดเดือนนี้ทันที'
    );
  }

  if (text === 'สรุป' || text === 'สรุปยอด') {
    return handleSummaryCommand(event, userId);
  }

  if (text === 'รายรับ' || text === 'รายจ่าย') {
    return handleQuickStart(event, userId, text === 'รายรับ' ? 'income' : 'expense');
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
      text: `จำนวนเงิน ${fmtBaht(amount)} — เลือกหมวดหมู่`,
      quickReply: {
        items: cats.map((c) => ({
          type: 'action',
          action: { type: 'postback', label: c, data: `cat=${encodeURIComponent(c)}`, displayText: c },
        })),
      },
    });
  }

  return replyText(
    event,
    'ส่งรูปสลิปโอนเงินมาได้เลย 📸\nหรือพิมพ์ "รายรับ" / "รายจ่าย" เพื่อบันทึกด่วน\nหรือพิมพ์ "สรุป" เพื่อดูยอดเดือนนี้\nพิมพ์รหัส 6 หลักจากหน้าเว็บแอปเพื่อเชื่อมบัญชีก่อนใช้งานครั้งแรก'
  );
}

async function handleSummaryCommand(event, userId) {
  const device = await getDeviceByLineUser(userId);
  if (!device) {
    return replyText(event, 'กรุณาเชื่อมบัญชีก่อน โดยพิมพ์รหัส 6 หลักจากหน้าเว็บแอป');
  }
  const month = thisMonth();
  const { data: rows } = await supabase
    .from('transactions')
    .select('type, amount')
    .eq('device_id', device.id)
    .gte('date', `${month}-01`)
    .lt('date', nextMonthISO(month));

  const income = (rows || []).filter((r) => r.type === 'income').reduce((s, r) => s + Number(r.amount), 0);
  const expense = (rows || []).filter((r) => r.type === 'expense').reduce((s, r) => s + Number(r.amount), 0);

  let msg = `📊 สรุปเดือนนี้\nรายรับ: ${fmtBaht(income)}\nรายจ่าย: ${fmtBaht(expense)}\nคงเหลือ: ${fmtBaht(income - expense)}`;
  if (device.monthly_budget && Number(device.monthly_budget) > 0) {
    const pct = Math.round((expense / Number(device.monthly_budget)) * 100);
    msg += `\nงบประมาณ: ${fmtBaht(device.monthly_budget)} (ใช้ไป ${pct}%)`;
  }
  return replyText(event, msg);
}

async function handleQuickStart(event, userId, type) {
  const device = await getDeviceByLineUser(userId);
  if (!device) {
    return replyText(event, 'กรุณาเชื่อมบัญชีก่อน โดยพิมพ์รหัส 6 หลักจากหน้าเว็บแอป');
  }
  await supabase.from('pending_slips').upsert({
    line_user_id: userId,
    device_id: device.id,
    step: 'awaiting_amount',
    type,
    amount: null,
    category: null,
    suggested_amount: null,
  });
  return replyText(event, `บันทึก${type === 'income' ? 'รายรับ' : 'รายจ่าย'} — พิมพ์จำนวนเงิน (ตัวเลขเท่านั้น) เช่น 250`);
}

async function handleImageMessage(event, userId) {
  const device = await getDeviceByLineUser(userId);
  if (!device) {
    return replyText(event, 'กรุณาเชื่อมบัญชีก่อน โดยพิมพ์รหัส 6 หลักที่แสดงในหน้าเว็บแอป');
  }

  let suggestedAmount = null;
  try {
    const stream = await lineClient.getMessageContent(event.message.id);
    const buffer = await streamToBuffer(stream);
    const text = await ocrExtractText(buffer);
    suggestedAmount = guessAmountFromText(text);
  } catch (err) {
    console.error('OCR failed (falling back to manual entry):', err);
  }

  await supabase.from('pending_slips').upsert({
    line_user_id: userId,
    device_id: device.id,
    step: 'awaiting_type',
    type: null,
    amount: null,
    category: null,
    suggested_amount: suggestedAmount,
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
    return replyText(event, 'ไม่พบรายการที่รอยืนยัน กรุณาส่งรูปสลิปใหม่ หรือพิมพ์ "รายรับ"/"รายจ่าย" อีกครั้ง');
  }

  if (params.has('type')) {
    const type = params.get('type');
    await supabase.from('pending_slips').update({ type }).eq('line_user_id', userId);

    if (pending.suggested_amount) {
      await supabase.from('pending_slips').update({ step: 'confirm_amount' }).eq('line_user_id', userId);
      return reply(event, {
        type: 'text',
        text: `รับทราบ: ${type === 'income' ? 'รายรับ' : 'รายจ่าย'}\nระบบตรวจพบจำนวนเงินในสลิป: ${fmtBaht(
          pending.suggested_amount
        )}\nถูกต้องไหม?`,
        quickReply: {
          items: [
            { type: 'action', action: { type: 'postback', label: '✅ ใช่ ใช้ยอดนี้', data: 'amt_confirm=1', displayText: 'ใช่ ใช้ยอดนี้' } },
            { type: 'action', action: { type: 'postback', label: '✏️ ไม่ใช่ พิมพ์เอง', data: 'amt_confirm=0', displayText: 'พิมพ์เอง' } },
          ],
        },
      });
    }

    await supabase.from('pending_slips').update({ step: 'awaiting_amount' }).eq('line_user_id', userId);
    return replyText(event, `รับทราบ: ${type === 'income' ? 'รายรับ' : 'รายจ่าย'}\nพิมพ์จำนวนเงิน (ตัวเลขเท่านั้น) เช่น 250`);
  }

  if (params.has('amt_confirm')) {
    const confirmed = params.get('amt_confirm') === '1';
    if (confirmed && pending.suggested_amount) {
      await supabase.from('pending_slips').update({ amount: pending.suggested_amount, step: 'awaiting_category' }).eq('line_user_id', userId);
      const cats = pending.type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
      return reply(event, {
        type: 'text',
        text: `จำนวนเงิน ${fmtBaht(pending.suggested_amount)} — เลือกหมวดหมู่`,
        quickReply: {
          items: cats.map((c) => ({
            type: 'action',
            action: { type: 'postback', label: c, data: `cat=${encodeURIComponent(c)}`, displayText: c },
          })),
        },
      });
    }
    await supabase.from('pending_slips').update({ step: 'awaiting_amount' }).eq('line_user_id', userId);
    return replyText(event, 'พิมพ์จำนวนเงิน (ตัวเลขเท่านั้น) เช่น 250');
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

  checkBudgetAndNotify(pending.device_id);

  const webAppUrl = process.env.WEB_APP_URL || '';
  const typeLabel = pending.type === 'income' ? 'รายรับ' : 'รายจ่าย';
  return replyText(
    event,
    `บันทึก${typeLabel} ${fmtBaht(pending.amount)} (${pending.category}) เรียบร้อย ✅` + (webAppUrl ? `\nดูสรุปที่: ${webAppUrl}` : '')
  );
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`LINE slip finance bot listening on port ${port}`);
});
