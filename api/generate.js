// api/generate.js — RiftAI proxy
import Redis from 'ioredis';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

export const maxDuration = 300;

// ---------- Расшифровка с нормализацией base64 ----------
function decryptData(encryptedBase64, secretKeyBase64) {
  try {
    let normalized = encryptedBase64.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
    const parts = normalized.split(':');
    if (parts.length !== 2) return null;
    const [ivBase64, encryptedBase64Data] = parts;
    const iv = Buffer.from(ivBase64, 'base64');
    const encrypted = Buffer.from(encryptedBase64Data, 'base64');
    const key = Buffer.from(secretKeyBase64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (err) {
    console.error('Decryption failed:', err.message);
    return null;
  }
}

// ---------- Загрузка стилей ----------
let styleMap = {};
try {
  styleMap = require('./styles.json');
  console.log(`✅ [1/9] Загружено стилей: ${Object.keys(styleMap).length}`);
} catch (err) {
  console.error('❌ [1/9] styles.json error:', err.message);
  styleMap = { kodak_portra_400: "Kodak Portra 400 film look" };
}

// ---------- Redis ----------
const redisUrl = process.env.REDIS_URL || process.env.KV_URL;
let redis = null;
if (redisUrl) {
  redis = new Redis(redisUrl);
  redis.on('error', (err) => console.warn('Redis warning:', err.message));
}

function getCacheKey(userId, prompt, characters, style) {
  let chars = [];
  try { chars = JSON.parse(characters || '[]'); chars.sort((a,b)=>a.name.localeCompare(b.name)); } catch(e) {}
  const hash = Buffer.from(JSON.stringify({ userId, prompt, characters: chars, style })).toString('base64');
  return `img:${hash}`;
}

async function fetchImageBuffer(url) {
  const res = await fetch(url, { headers: { Accept: 'image/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') || 'image/png';
  if (!contentType.startsWith('image/')) throw new Error(`Not an image: ${contentType}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, contentType };
}

function extFromContentType(ct) {
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('webp')) return 'webp';
  return 'png';
}

async function uploadToImgBB(imgbb_key, b64) {
  const clean = b64.replace(/^data:image\/\w+;base64,/, '').replace(/\s/g, '');
  const form = new FormData();
  form.append('key', imgbb_key);
  form.append('image', clean);
  form.append('name', `gen_${Date.now()}`);
  const res = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`ImgBB error: ${data.error?.message || 'unknown'}`);
  return data.data.url;
}

// ---------- Fetch с retry и подробным логированием ----------
async function fetchWithRetry(url, options, retries = 3, delay = 1500) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (networkErr) {
      lastError = new Error(`Network error: ${networkErr.message}`);
      console.error(`❌ Network error attempt ${attempt}/${retries}: ${networkErr.message}`);
      if (attempt < retries) await new Promise(r => setTimeout(r, delay));
      continue;
    }

    const rawText = await res.text();

    if (res.ok) {
      return {
        ok: true,
        status: res.status,
        json: async () => {
          try { return JSON.parse(rawText); }
          catch(e) { throw new Error(`Invalid JSON from RiftAI: ${rawText.slice(0, 200)}`); }
        }
      };
    }

    let errorDetails = rawText;
    try {
      const parsed = JSON.parse(rawText);
      errorDetails = JSON.stringify(parsed, null, 2);
    } catch(e) {}

    console.error(`❌ RiftAI attempt ${attempt}/${retries} — HTTP ${res.status}`);
    console.error(`   Response: ${errorDetails.slice(0, 800)}`);

    lastError = new Error(`RiftAI HTTP ${res.status}: ${errorDetails.slice(0, 400)}`);

    if (res.status !== 502 && res.status !== 503) throw lastError;
    if (attempt < retries) {
      console.warn(`⏳ Retry in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).end();

  try {
    console.log('🚀 [2/9] Начало запроса');

    if (req.query.data) {
      console.log('🔍 RAW data:', req.query.data.slice(0, 80));

      let raw = req.query.data
        .replace(/[\r\n\t]/g, '')  // убираем переносы строк и табы
        .replace(/%2B/gi, '+')     // %2B → +
        .replace(/%2F/gi, '/')     // %2F → /
        .replace(/%3D/gi, '=')     // %3D → =
        .replace(/ /g, '+');       // пробелы → +

      // Убираем двойные плюсы
      raw = raw.replace(/\+{2,}/g, '+');

      const parts = raw.split(':');
      if (parts.length === 2) {
        let encrypted = parts[1];
        const missing = (4 - (encrypted.length % 4)) % 4;
        if (missing) encrypted += '='.repeat(missing);
        raw = parts[0] + ':' + encrypted;
      }

      console.log('🔍 data normalized (first 60):', raw.slice(0, 60));
      console.log('🔍 data length:', raw.length);
      console.log('🔍 data (last 20):', raw.slice(-20));
      req.query.data = raw;
    }

    const encryptionKey = process.env.ENCRYPTION_KEY;
    let key, charactersRaw, imgbb_key;

    if (req.query.data && encryptionKey) {
      const decrypted = decryptData(req.query.data, encryptionKey);
      if (decrypted && typeof decrypted === 'object') {
        key = decrypted.key;
        imgbb_key = decrypted.imgbb_key;
        charactersRaw = req.query.characters;
        console.log('✅ [3/9] Данные расшифрованы');
      } else {
        console.error('❌ [3/9] Ошибка расшифровки');
        return res.status(400).send('Invalid encrypted data');
      }
    } else {
      key = req.query.key;
      charactersRaw = req.query.characters;
      imgbb_key = req.query.imgbb_key;
      console.log('⚠️ [3/9] Незашифрованный запрос');
    }

    if (charactersRaw && typeof charactersRaw === 'string' && charactersRaw.includes('%')) {
      try {
        charactersRaw = decodeURIComponent(charactersRaw);
        console.log('🔓 characters decoded');
      } catch (e) { console.warn('Decode failed', e.message); }
    }
    console.log('🔍 charactersRaw:', charactersRaw);

    const userId = req.query.userId;
    const prompt = req.query.prompt;
    const style = req.query.style;
    const model = req.query.model || 'gemini-3.1-flash-image-preview';

    if (!key || !prompt || !userId) {
      console.error(`❌ 400: key=${!!key}, prompt=${!!prompt}, userId=${!!userId}`);
      return res.status(400).send('Missing key, prompt, or userId');
    }
    if (!imgbb_key) {
      console.error('❌ 400: imgbb_key missing');
      return res.status(400).send('Missing imgbb_key');
    }
    console.log(`✅ [3/9] userId: ${userId}, model: ${model}`);

    // Стиль
    let finalStyle = style;
    if (style && styleMap[style.toLowerCase()]) {
      finalStyle = styleMap[style.toLowerCase()];
      console.log(`🎨 [4/9] Стиль "${style}" заменён`);
    } else {
      const defaultStyle = 'kodak_portra_400';
      finalStyle = styleMap[defaultStyle] || "Kodak Portra 400 film look";
      console.log(`🎨 [4/9] Стиль по умолчанию (${defaultStyle})`);
    }

    const fullPrompt = `${finalStyle}\n\n${prompt}`;

    // ---- Кэш и блокировка ----
    const cacheKey = getCacheKey(userId, prompt, charactersRaw, finalStyle);
    let cachedUrl = null;
    let lockAcquired = false;
    const lockKey = `lock:${cacheKey}`;

    if (redis) {
      console.log('🔄 [5/9] Проверка кэша...');
      try { cachedUrl = await redis.get(cacheKey); } catch(e) { console.warn('Redis error:', e.message); }
      if (!cachedUrl) {
        const locked = await redis.set(lockKey, 'locked', 'EX', 2, 'NX');
        if (locked) {
          lockAcquired = true;
          console.log(`🔒 Блокировка получена`);
        } else {
          console.log(`⏳ Ожидание блокировки`);
          await new Promise(resolve => setTimeout(resolve, 600));
          const retryCache = await redis.get(cacheKey);
          if (retryCache) return res.redirect(302, retryCache);
          else await redis.del(lockKey);
        }
      }
    }
    if (cachedUrl) return res.redirect(302, cachedUrl);
    console.log('❌ [5/9] Кэш промах, генерация');

    // ---- Референсы ----
    let chars = [];
    try {
      chars = JSON.parse(charactersRaw || '[]');
      console.log(`📸 [6/9] Референсов: ${chars.length}`);
    } catch(e) {
      console.warn('Ошибка парсинга characters:', e.message);
    }

    const isGptImage = model.startsWith('gpt-image');
    let imageUrl;

    if (isGptImage) {
      console.log('🤖 [7/9] RiftAI images/edits...');
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', fullPrompt);
      form.append('n', '1');
      form.append('size', '1024x1024');
      for (const c of chars) {
        if (!c.url) continue;
        try {
          const { buf, contentType } = await fetchImageBuffer(c.url);
          const ext = extFromContentType(contentType);
          const blob = new Blob([buf], { type: contentType });
          form.append('image[]', blob, `${c.name}.${ext}`);
          console.log(`   ✅ "${c.name}" загружен (${buf.length} bytes)`);
        } catch(e) { console.warn(`   ⚠️ "${c.name}": ${e.message}`); }
      }
      const riftRes = await fetchWithRetry('https://riftai.su/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      const riftData = await riftRes.json();
      const b64 = riftData.data?.[0]?.b64_json;
      if (!b64) throw new Error('No image from RiftAI (images/edits)');
      console.log('✅ [7/9] RiftAI ответил');
      imageUrl = await uploadToImgBB(imgbb_key, b64);

    } else {
      console.log('🤖 [7/9] RiftAI chat/completions...');
      const messages = [{ role: 'user', content: [{ type: 'text', text: fullPrompt }] }];
      for (const c of chars) {
        if (!c.url) continue;
        try {
          const { buf, contentType } = await fetchImageBuffer(c.url);
          const base64 = buf.toString('base64');
          messages[0].content.push({ type: 'image_url', image_url: { url: `data:${contentType};base64,${base64}` } });
          console.log(`   ✅ "${c.name}" загружен (${buf.length} bytes)`);
        } catch(e) { console.warn(`   ⚠️ "${c.name}": ${e.message}`); }
      }
      const riftRes = await fetchWithRetry('https://riftai.su/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages }),
      });
      const riftData = await riftRes.json();
      let b64 = riftData.data?.b64_json || riftData.b64_json || riftData.image;
      if (!b64 && riftData.choices?.[0]?.message?.content) {
        const match = riftData.choices[0].message.content.match(/data:image\/[^;]+;base64,([a-zA-Z0-9+/=]+)/);
        if (match) b64 = match[1];
      }
      if (!b64) throw new Error('No image from RiftAI (chat/completions)');
      console.log('✅ [7/9] RiftAI ответил');
      imageUrl = await uploadToImgBB(imgbb_key, b64);
    }

    console.log(`✅ [8/9] Изображение готово`);

    if (redis) {
      try {
        await redis.set(cacheKey, imageUrl, 'EX', 604800);
        if (lockAcquired) await redis.del(lockKey);
        console.log(`💾 [9/9] Сохранено в кэш`);
      } catch(e) { console.warn('Redis set error:', e.message); }
    }

    return res.redirect(302, imageUrl);
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    return res.status(500).send(`Proxy error: ${err.message}`);
  }
}

