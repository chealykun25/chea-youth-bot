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

// Detect resource type for Cloudinary
function getResourceType(mimeType) {
  if (!mimeType) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf') return 'image'; // Cloudinary handles PDFs as image type
  return 'image';
}

// Get file extension from mime type
function getExtension(mimeType) {
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/x-msvideo': 'avi',
    'video/webm': 'webm',
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
    contentType: resourceType === 'video' ? `video/${ext}` : (ext === 'pdf' ? 'application/pdf' : `image/${ext}`)
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
  return { url: data.secure_url, type: resourceType };
}

async function processFileFromTelegram(fileId, filename, mimeType) {
  const fileRes = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const fileData = await fileRes.json();
  if (!fileData.ok) throw new Error('Could not get file from Telegram');

  const buffer = await downloadBuffer(`${TELEGRAM_FILE}/${fileData.result.file_path}`);
  const resourceType = getResourceType(mimeType);
  const ext = getExtension(mimeType);
  return await uploadToCloudinary(buffer, filename, resourceType, ext);
}

app.get('/health', (req, res) => res.json({
  status: 'ok',
  bot: !!TELEGRAM_TOKEN,
  cloudinary: !!CLOUD_NAME,
  supports: ['photos', 'videos', 'pdfs']
}));

app.post('/webhook', async (req, res) => {
  res.json({ ok: true });
  const msg = req.body.message;
  if (!msg) return;

  const timestamp = Date.now();
  const caption = msg.caption || '(none)';

  try {
    // â”€â”€ PHOTO â”€â”€
    if (msg.photo) {
      const best = msg.photo[msg.photo.length - 1];
      const filename = `photo_${msg.message_id}_${timestamp}`;
      const result = await processFileFromTelegram(best.file_id, filename, 'image/jpeg');
      console.log(`âœ… Photo uploaded: ${result.url} | Caption: ${caption}`);
      return;
    }

    // â”€â”€ VIDEO â”€â”€
    if (msg.video) {
      const filename = `video_${msg.message_id}_${timestamp}`;
      const mimeType = msg.video.mime_type || 'video/mp4';
      const result = await processFileFromTelegram(msg.video.file_id, filename, mimeType);
      console.log(`âœ… Video uploaded: ${result.url} | Caption: ${caption}`);
      return;
    }

    // â”€â”€ VIDEO NOTE (circle videos) â”€â”€
    if (msg.video_note) {
      const filename = `vidnote_${msg.message_id}_${timestamp}`;
      const result = await processFileFromTelegram(msg.video_note.file_id, filename, 'video/mp4');
      console.log(`âœ… Video note uploaded: ${result.url}`);
      return;
    }

    // â”€â”€ DOCUMENT (PDF or other) â”€â”€
    if (msg.document) {
      const mimeType = msg.document.mime_type || 'application/pdf';
      const filename = `doc_${msg.message_id}_${timestamp}`;
      const result = await processFileFromTelegram(msg.document.file_id, filename, mimeType);
      console.log(`âœ… Document uploaded: ${result.url} | Type: ${mimeType} | Caption: ${caption}`);
      return;
    }

  } catch (err) {
    console.error(`âŒ Upload error:`, err.message);
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
