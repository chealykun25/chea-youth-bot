const express = require('express');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const FormData = require('form-data');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CLOUD_NAME       = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUD_API_KEY    = process.env.CLOUDINARY_API_KEY;
const CLOUD_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const TELEGRAM_API     = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const TELEGRAM_FILE    = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}`;

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

async function uploadToCloudinary(buffer, filename) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const folder = 'chea-youth';
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

app.get('/health', (req, res) => res.json({
  status: 'ok',
  bot: !!TELEGRAM_TOKEN,
  cloudinary: !!CLOUD_NAME
}));

app.post('/webhook', async (req, res) => {
  res.json({ ok: true });
  const msg = req.body.message;
  if (!msg || !msg.photo) return;

  try {
    const best = msg.photo[msg.photo.length - 1];
    const fileRes = await fetch(`${TELEGRAM_API}/getFile?file_id=${best.file_id}`);
    const fileData = await fileRes.json();
    if (!fileData.ok) return;

    const buffer = await downloadBuffer(`${TELEGRAM_FILE}/${fileData.result.file_path}`);
    const filename = `chea_${msg.message_id}_${Date.now()}`;
    const url = await uploadToCloudinary(buffer, filename);

    console.log('Photo uploaded:', url, '| Caption:', msg.caption || '(none)');
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

app.post('/set-webhook', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const r = await fetch(`${TELEGRAM_API}/setWebhook?url=${encodeURIComponent(url + '/webhook')}`);
  res.json(await r.json());
});

app.get('/bot-info', async (req, res) => {
  const r = await fetch(`${TELEGRAM_API}/getMe`);
  res.json(await r.json());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CHEA Youth Bot Server running on port ${PORT}`));
