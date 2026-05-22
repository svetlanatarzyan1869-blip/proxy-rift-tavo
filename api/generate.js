// api/generate.js — RiftAI proxy (gpt-image-1 via /v1/images/edits)
import Redis from 'ioredis';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

// ---------- Расшифровка с нормализацией base64 ----------
function decryptData(encryptedBase64, secretKeyBase64) {
  try {
    let normalized = encryptedBase64.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
    const parts = normalized.split(':');
    if (parts.length !== 2) {
      console.error('Invalid format: expected iv:encrypted, got', parts.length);
      return null;
    }
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

// ---------- Загрузка стилей из styles.json ----------
let styleMap = {};
try {
  styleMap = require('./styles.json');
  console.log(`✅ [1/9] Загружено стилей: ${Object.keys(styleMap).length}`);
} catch (err) {
  console.error('❌ [1/9] Ошибка загрузки styles.json:', err.message);
  throw new Error('styles.json not found or invalid');
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
  try {
    chars = JSON.parse(characters || '[]');
    chars.sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {}
  const hash = Buffer.from(JSON.stringify({ userId, prompt, characters: chars, style })).toString('base64');
  return `img:${hash}`;
}

// ---------- Скачать изображение и вернуть Buffer + contentType ----------
async function fetchImageBuffer(url) {
  const res = await fetch(url, { headers: { Accept: 'image/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') || 'image/png';
  if (!contentType.startsWith('image/')) throw new Error(`Not an image: ${contentType}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, contentType };
}

// ---------- Определяем расширение из contentType ----------
function extFromContentType(ct) {
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('webp')) return 'webp';
  return 'png';
}

// ---------- Загрузить на ImgBB ----------
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).end();

  try {
    console.log('🚀 [2/9] Начало запроса');
    const encryptionKey = process.env.ENCRYPTION_KEY;
    let key, charactersRaw, imgbb_key;

    // ---- Получение зашифрованной части (key, characters, imgbb_key) ----
    if (req.query.data && encryptionKey) {
      const decrypted = decryptData(req.query.data, encryptionKey);
      if (decrypted && typeof decrypted === 'object') {
        key = decrypted.key;
        charactersRaw = decrypted.characters;
        imgbb_key = decrypted.imgbb_key;
        console.log('✅ [3/9] Данные расшифрованы');
      } else {
        console.error('❌ [3/9] Ошибка расшифровки');
        return res.status(400).send('Invalid encrypted data');
      }
    } else {
      // fallback для старых версий (без шифрования)
      key = req.query.key;
      charactersRaw = req.query.characters;
      imgbb_key = req.query.imgbb_key;
      console.log('⚠️ [3/9] Используется незашифрованный запрос (устаревший)');
    }

    // ---- Эти параметры всегда из URL (не секретные) ----
    const userId = req.query.userId;
    const prompt = req.query.prompt;
    const style = req.query.style;
    const model = req.query.model || 'gemini-3.1-flash-image-preview';

    if (!key || !prompt || !userId) {
      console.error('❌ [3/9] Отсутствуют key, prompt или userId');
      return res.status(400).send('Missing key, prompt, or userId');
    }
    if (!imgbb_key) {
      console.error('❌ [3/9] Отсутствует imgbb_key');
      return res.status(400).send('Missing imgbb_key');
    }
    console.log(`✅ [3/9] Параметры получены (userId: ${userId}, model: ${model})`);

    // ---- Обработка стиля: если нет или не найден → kodak_portra_400 ----
    let finalStyle = style;
    if (style && styleMap[style.toLowerCase()]) {
      finalStyle = styleMap[style.toLowerCase()];
      console.log(`🎨 [4/9] Стиль "${style}" заменён`);
    } else {
      const defaultStyleName = 'kodak_portra_400';
      if (styleMap[defaultStyleName]) {
        finalStyle = styleMap[defaultStyleName];
        console.log(`🎨 [4/9] Стиль не указан или не найден, использован ${defaultStyleName}`);
      } else {
        console.error(`❌ [4/9] Стиль по умолчанию ${defaultStyleName} не найден в styles.json`);
        return res.status(500).send('Default style missing');
      }
    }

    const fullPrompt = `${finalStyle}\n\n${prompt}`;

    // ---- Кэш и блокировка для предотвращения гонки ----
    const cacheKey = getCacheKey(userId, prompt, charactersRaw, finalStyle);
    let cachedUrl = null;
    let lockAcquired = false;
    const lockKey = `lock:${cacheKey}`;

    if (redis) {
      console.log('🔄 [5/9] Проверка кэша...');
      try {
        cachedUrl = await redis.get(cacheKey);
      } catch (e) {
        console.warn('Redis error:', e.message);
      }

      if (!cachedUrl) {
        const locked = await redis.set(lockKey, 'locked', 'EX', 2, 'NX');
        if (locked) {
          lockAcquired = true;
          console.log(`🔒 Блокировка получена для ${cacheKey}`);
        } else {
          console.log(`⏳ Ожидание блокировки для ${cacheKey}`);
          await new Promise(resolve => setTimeout(resolve, 600));
          const retryCache = await redis.get(cacheKey);
          if (retryCache) {
            console.log(`✅ Кэш получен после ожидания блокировки`);
            return res.redirect(302, retryCache);
          } else {
            await redis.del(lockKey);
          }
        }
      }
    } else {
      console.log('⚠️ [5/9] Redis не настроен, кэш отключён');
    }

    if (cachedUrl && typeof cachedUrl === 'string') {
      console.log(`✅ [5/9] Кэш попадание`);
      return res.redirect(302, cachedUrl);
    }
    console.log('❌ [5/9] Кэш промах, генерация');

    // ---- Референсы персонажей ----
    let chars = [];
    try {
      chars = JSON.parse(charactersRaw || '[]');
    } catch (e) {
      console.warn('Ошибка парсинга characters');
    }
    console.log(`📸 [6/9] Референсов: ${chars.length}`);

    // ---- Определяем стратегию по модели ----
    const isGptImage = model.startsWith('gpt-image');

    let imageUrl;

    if (isGptImage) {
      // ======================================================
      // GPT Image — /v1/images/edits (multipart/form-data)
      // Референсы передаются как файлы image[]
      // ======================================================
      console.log('🤖 [7/9] Запрос в RiftAI (images/edits)...');

      const form = new FormData();
      form.append('model', model);
      form.append('prompt', fullPrompt);
      form.append('n', '1');
      form.append('size', '1024x1024');

      // Загружаем каждый референс и добавляем в форму
      for (const c of chars) {
        if (!c.url) continue;
        try {
          const { buf, contentType } = await fetchImageBuffer(c.url);
          const ext = extFromContentType(contentType);
          const blob = new Blob([buf], { type: contentType });
          form.append('image[]', blob, `${c.name}.${ext}`);
          console.log(`   ✅ Референс "${c.name}" загружен`);
        } catch (e) {
          console.warn(`   ⚠️ "${c.name}": ${e.message}`);
        }
      }

      const riftRes = await fetch('https://riftai.su/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });

      if (!riftRes.ok) {
        const errText = await riftRes.text();
        throw new Error(`RiftAI error ${riftRes.status}: ${errText.slice(0, 200)}`);
      }

      const riftData = await riftRes.json();
      const b64 = riftData.data?.[0]?.b64_json;
      if (!b64) throw new Error('Нет изображения от RiftAI (images/edits)');

      console.log('✅ [7/9] RiftAI ответил');

      // ---- ImgBB ----
      console.log('☁️ [8/9] Загрузка на ImgBB...');
      imageUrl = await uploadToImgBB(imgbb_key, b64);

    } else {
      // ======================================================
      // Gemini и прочие модели — /v1/chat/completions
      // Референсы передаются как base64 image_url в messages
      // ======================================================
      console.log('🤖 [7/9] Запрос в RiftAI (chat/completions)...');

      const messages = [
        {
          role: 'user',
          content: [{ type: 'text', text: fullPrompt }],
        },
      ];

      for (const c of chars) {
        if (!c.url) continue;
        try {
          const { buf, contentType } = await fetchImageBuffer(c.url);
          const base64 = buf.toString('base64');
          messages[0].content.push({
            type: 'image_url',
            image_url: { url: `data:${contentType};base64,${base64}` },
          });
          console.log(`   ✅ Референс "${c.name}" загружен`);
        } catch (e) {
          console.warn(`   ⚠️ "${c.name}": ${e.message}`);
        }
      }

      const riftRes = await fetch('https://riftai.su/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ model, messages }),
      });

      if (!riftRes.ok) {
        const errText = await riftRes.text();
        throw new Error(`RiftAI error ${riftRes.status}: ${errText.slice(0, 200)}`);
      }

      const riftData = await riftRes.json();

      // Извлекаем base64 из markdown data URL в content
      let b64 = riftData.data?.b64_json || riftData.b64_json || riftData.image;
      if (!b64 && riftData.choices?.[0]?.message?.content) {
        const match = riftData.choices[0].message.content.match(
          /data:image\/[^;]+;base64,([a-zA-Z0-9+/=]+)/
        );
        if (match) b64 = match[1];
      }
      if (!b64) throw new Error('Нет изображения от RiftAI (chat/completions)');

      console.log('✅ [7/9] RiftAI ответил');

      // ---- ImgBB ----
      console.log('☁️ [8/9] Загрузка на ImgBB...');
      imageUrl = await uploadToImgBB(imgbb_key, b64);
    }

    console.log(`✅ [8/9] Изображение готово`);

    // ---- Сохраняем в кэш и снимаем блокировку ----
    if (redis) {
      try {
        await redis.set(cacheKey, imageUrl, 'EX', 604800);
        if (lockAcquired) await redis.del(lockKey);
        console.log(`💾 [9/9] Сохранено в кэш`);
      } catch (e) {
        console.warn('Redis set error:', e.message);
      }
    }

    return res.redirect(302, imageUrl);
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    return res.status(500).send(`Proxy error: ${err.message}`);
  }
}
