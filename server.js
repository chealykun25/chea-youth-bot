const express = require('express');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const FormData = require('form-data');
const { MongoClient } = require('mongodb');
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
const MONGODB_URI      = process.env.MONGODB_URI;
const TELEGRAM_API     = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const TELEGRAM_FILE    = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}`;

// â”€â”€ MongoDB connection â”€â”€
let db = null;
async function getDb() {
  if (db) return db;
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('cheayouth');
  console.log('MongoDB connected');
  return db;
}

// â”€â”€ Helper: download file as buffer â”€â”€
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

function getResourceType(mimeType) {
  if (!mimeType) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return 'image';
}

function getExtension(mimeType) {
  const map = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
    'application/pdf': 'pdf'
  };
  return map[mimeType] || 'jpg';
}

async function uploadToCloudinary(buffer, filename, resourceType = 'image', ext = 'jpg') {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const folder = 'chea-youth';
  const signStr = `folder=${folder}&public_id=${filename}&timestamp=${timestamp}${CLOUD_API_SECRET}`;
  const signature = crypto.createHash('sha256').update(signStr).digest('hex');

  const form = new FormData();
  form.append('file', buffer, {
    filename: `${filename}.${ext}`,
    contentType: ext === 'pdf' ? 'application/pdf' : `${resourceType}/${ext}`
  });
  form.append('api_key', CLOUD_API_KEY);
  form.append('timestamp', timestamp);
  form.append('signature', signature);
  form.append('folder', folder);
  form.append('public_id', filename);
  form.append('resource_type', resourceType);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/${resourceType}/upload`,
    { method: 'POST', body: form, headers: form.getHeaders() }
  );
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch(e) { throw new Error('Cloudinary bad response: ' + text.substring(0, 200)); }
  if (data.error) throw new Error('Cloudinary error: ' + data.error.message);
  return data.secure_url;
}

async function saveToMongo(doc) {
  try {
    const database = await getDb();
    await database.collection('media').insertOne(doc);
  } catch (err) {
    console.error('MongoDB save error:', err.message);
  }
}

async function processFile(fileId, filename, mimeType, caption) {
  const fileRes = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const fileData = await fileRes.json();
  if (!fileData.ok) throw new Error('Cannot get file from Telegram');

  const buffer = await downloadBuffer(`${TELEGRAM_FILE}/${fileData.result.file_path}`);
  const resourceType = getResourceType(mimeType);
  const ext = getExtension(mimeType);
  const url = await uploadToCloudinary(buffer, filename, resourceType, ext);

  await saveToMongo({
    url,
    filename,
    caption: caption || '',
    type: resourceType,
    mimeType,
    uploadedAt: new Date(),
    source: 'telegram'
  });

  return url;
}

// â”€â”€ GET /health â”€â”€
app.get('/health', (req, res) => res.json({
  status: 'ok',
  bot: !!TELEGRAM_TOKEN,
  cloudinary: !!CLOUD_NAME,
  mongodb: !!MONGODB_URI,
  supports: ['photos', 'videos', 'pdfs']
}));

// â”€â”€ GET /media â”€â”€ returns all media for the gallery
app.get('/media', async (req, res) => {
  try {
    const database = await getDb();
    const media = await database.collection('media')
      .find({})
      .sort({ uploadedAt: -1 })
      .limit(200)
      .toArray();
    res.json({ success: true, count: media.length, media });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// â”€â”€ POST /webhook â”€â”€
app.post('/webhook', async (req, res) => {
  res.json({ ok: true });
  const msg = req.body.message;
  if (!msg) return;

  const caption = msg.caption || '';
  const timestamp = Date.now();

  try {
    if (msg.photo) {
      const best = msg.photo[msg.photo.length - 1];
      const filename = `photo_${msg.message_id}_${timestamp}`;
      const url = await processFile(best.file_id, filename, 'image/jpeg', caption);
      console.log('âœ… Photo saved:', url);
      return;
    }
    if (msg.video) {
      const filename = `video_${msg.message_id}_${timestamp}`;
      const url = await processFile(msg.video.file_id, filename, msg.video.mime_type || 'video/mp4', caption);
      console.log('âœ… Video saved:', url);
      return;
    }
    if (msg.video_note) {
      const filename = `vidnote_${msg.message_id}_${timestamp}`;
      const url = await processFile(msg.video_note.file_id, filename, 'video/mp4', caption);
      console.log('âœ… Video note saved:', url);
      return;
    }
    if (msg.document) {
      const filename = `doc_${msg.message_id}_${timestamp}`;
      const url = await processFile(msg.document.file_id, filename, msg.document.mime_type || 'application/pdf', caption);
      console.log('âœ… Document saved:', url);
      return;
    }
  } catch (err) {
    console.error('âŒ Error:', err.message);
  }
});

// â”€â”€ POST /set-webhook â”€â”€
app.post('/set-webhook', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const r = await fetch(`${TELEGRAM_API}/setWebhook?url=${encodeURIComponent(url + '/webhook')}`);
  res.json(await r.json());
});

// â”€â”€ GET /bot-info â”€â”€
app.get('/bot-info', async (req, res) => {
  const r = await fetch(`${TELEGRAM_API}/getMe`);
  res.json(await r.json());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CHEA Youth Bot Server running on port ${PORT}`));
