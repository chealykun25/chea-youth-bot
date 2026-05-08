const express = require('express');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ── CORS ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const TELEGRAM_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const CLOUD_NAME        = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUD_API_KEY     = process.env.CLOUDINARY_API_KEY;
const CLOUD_API_SECRET  = process.env.CLOUDINARY_API_SECRET;
const TELEGRAM_API      = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const TELEGRAM_FILE     = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}`;

// ── Helper: download file as buffer ──
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Helper: upload buffer to Cloudinary ──
async function uploadToCloudinary(buffer, filename) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const folder = 'chea-youth';
  const publicId = `${folder}/${filename}`;

  // Generate signature
  const signStr = `folder=${folder}&public_id=${filename}&timestamp=${timestamp}${CLOUD_API_SECRET}`;
  const signature = crypto.createHash('sha256').update(signStr).digest('hex');

  const form = new FormData();
  form.append('file', buffer, { filename: filename + '.jpg', contentType: 'image/jpeg' });
  form.append('api_key', CLOUD_API_KEY);
  form.append('timestamp', timestamp);
  form.append('signature', signature);
  form.append('folder', folder);
  form.append('public_id', filename);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`,
    { method: 'POST', body: form, headers: form.getHeaders() }
  );

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch(e) { throw new Error('Cloudinary bad response: ' + text.substring(0, 200)); }

  if (data.error) throw new Error('Cloudinary error: ' + data.error.message);
  return data.secure_url;
}

// ── GET /health ──
app.get('/health', (req, res) => res.json({
  status: 'ok',
  bot: !!TELEGRAM_TOKEN,
  cloudinary: !!CLOUD_NAME
}));

// ── POST /webhook ──
app.post('/webhook', async (req, res) => {
  res.json({ ok: true });

  const update = req.body;
  const msg = update.message;
  if (!msg || !msg.photo) return;

  try {
    const best = msg.photo[msg.photo.length - 1];

    const fileRes = await fetch(`${TELEGRAM_API}/getFile?file_id=${best.file_id}`);
    const fileData = await fileRes.json();
    if (!fileData.ok) return;

    const fileUrl = `${TELEGRAM_FILE}/${fileData.result.file_path}`;
    const buffer = await downloadBuffer(fileUrl);
    const filename = `chea_${msg.message_id}_${Date.now()}`;
    const cloudUrl = await uploadToCloudinary(buffer, filename);

    console.log('✅ Photo uploaded:', cloudUrl, '| Caption:', msg.caption || '(none)');
  } catch (err) {
    console.error('❌ Webhook photo error:', err.message);
  }
});

// ── POST /set-webhook ──
app.post('/set-webhook', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const r = await fetch(`${TELEGRAM_API}/setWebhook?url=${encodeURIComponent(url + '/webhook')}`);
  const d = await r.json();
  res.json(d);
});

// ── GET /bot-info ──
app.get('/bot-info', async (req, res) => {
  const r = await fetch(`${TELEGRAM_API}/getMe`);
  const d = await r.json();
  res.json(d);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CHEA Youth Bot Server running on port ${PORT}`));

// ── CORS ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const IMGBB_KEY      = process.env.IMGBB_API_KEY;
const TELEGRAM_API   = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const TELEGRAM_FILE  = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}`;

// ── Helper: download file as buffer ──
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Helper: upload buffer to imgbb ──
async function uploadToImgbb(buffer, filename) {
  const b64 = buffer.toString('base64');
  
  const form = new FormData();
  form.append('key', IMGBB_KEY);
  form.append('image', b64);
  form.append('name', filename);

  const res = await fetch('https://api.imgbb.com/1/upload', {
    method: 'POST',
    body: form,
    headers: form.getHeaders()
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } 
  catch(e) { throw new Error('imgbb bad response: ' + text.substring(0, 200)); }

  if (!data.success) throw new Error('imgbb upload failed: ' + JSON.stringify(data));
  return data.data.url;
}

// ── GET /health ──
app.get('/health', (req, res) => res.json({ status: 'ok', bot: !!TELEGRAM_TOKEN }));

// ── POST /extract-photos ──
// Body: { chat_id: "-100xxxxxxx", limit: 100 }
// Returns: array of imgbb URLs
app.post('/extract-photos', async (req, res) => {
  const { chat_id, limit = 50 } = req.body;
  if (!chat_id) return res.status(400).json({ error: 'chat_id required' });

  try {
    // Get chat history via getUpdates or forwardFromChat
    // Using getHistory approach via bot API
    const historyRes = await fetch(
      `${TELEGRAM_API}/getUpdates?limit=100&allowed_updates=["message"]`
    );
    const historyData = await historyRes.json();

    const photos = [];
    const messages = historyData.result || [];

    for (const update of messages) {
      const msg = update.message;
      if (!msg) continue;
      if (String(msg.chat.id) !== String(chat_id)) continue;
      if (!msg.photo) continue;

      // Get highest resolution photo
      const photoArr = msg.photo;
      const best = photoArr[photoArr.length - 1];

      // Get file path
      const fileRes = await fetch(`${TELEGRAM_API}/getFile?file_id=${best.file_id}`);
      const fileData = await fileRes.json();
      if (!fileData.ok) continue;

      const fileUrl = `${TELEGRAM_FILE}/${fileData.result.file_path}`;
      const buffer = await downloadBuffer(fileUrl);
      const filename = `chea_${Date.now()}_${photos.length}.jpg`;
      const imgbbUrl = await uploadToImgbb(buffer, filename);

      photos.push({
        telegram_msg_id: msg.message_id,
        caption: msg.caption || '',
        url: imgbbUrl,
        date: msg.date
      });

      if (photos.length >= limit) break;
    }

    res.json({ success: true, count: photos.length, photos });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /webhook ──
// Telegram sends new messages here automatically
// Auto-uploads every new photo posted to the group
app.post('/webhook', async (req, res) => {
  res.json({ ok: true }); // Respond immediately to Telegram

  const update = req.body;
  const msg = update.message;
  if (!msg || !msg.photo) return;

  try {
    const photoArr = msg.photo;
    const best = photoArr[photoArr.length - 1];

    const fileRes = await fetch(`${TELEGRAM_API}/getFile?file_id=${best.file_id}`);
    const fileData = await fileRes.json();
    if (!fileData.ok) return;

    const fileUrl = `${TELEGRAM_FILE}/${fileData.result.file_path}`;
    const buffer = await downloadBuffer(fileUrl);
    const filename = `chea_auto_${msg.message_id}.jpg`;
    const imgbbUrl = await uploadToImgbb(buffer, filename);

    console.log('New photo uploaded:', imgbbUrl, '| Caption:', msg.caption || '(none)');
  } catch (err) {
    console.error('Webhook photo error:', err.message);
  }
});

// ── POST /set-webhook ──
// Call once to register this server with Telegram
app.post('/set-webhook', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const r = await fetch(`${TELEGRAM_API}/setWebhook?url=${encodeURIComponent(url + '/webhook')}`);
  const d = await r.json();
  res.json(d);
});

// ── GET /bot-info ──
app.get('/bot-info', async (req, res) => {
  const r = await fetch(`${TELEGRAM_API}/getMe`);
  const d = await r.json();
  res.json(d);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CHEA Youth Bot Server running on port ${PORT}`));
