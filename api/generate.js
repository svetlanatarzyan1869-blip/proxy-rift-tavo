// api/generate.js — RiftAI proxy
import Redis from 'ioredis';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

export const maxDuration = 300;

// ---------- SVG-ошибка ----------
function errorSvg(res, message) {
  const lines = [];
  const words = message.split(' ');
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > 55) {
      lines.push(line.trim());
      line = word;
    } else {
      line = (line + ' ' + word).trim();
    }
  }
  if (line) lines.push(line.trim());
  const lineHeight = 22;
  const startY = 90 - ((lines.length - 1) * lineHeight) / 2;
  const textRows = lines.map((l, i) =>
    `<text x="340" y="${startY + i * lineHeight}" font-family="system-ui,sans-serif" font-size="14" fill="#aaaaaa" text-anchor="middle">${l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</text>`
  ).join('\n  ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="680" height="160" viewBox="0 0 680 160">
  <rect width="680" height="160" rx="16" fill="#1a1a1a" stroke="#ff4444" stroke-width="1.5"/>
  <text x="340" y="48" font-family="system-ui,sans-serif" font-size="24" fill="#ff4444" text-anchor="middle">⚠️ Ошибка генерации</text>
  ${textRows}
</svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  return res.status(200).send(svg);
}

// ---------- Понятные ошибки ----------
function friendlyError(raw) {
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (/daily credit limit/i.test(s))
    return 'Закончились дневные кредиты RiftAI. Попробуй завтра или пополни баланс на riftai.su/pricing';
  if (/insufficient credits/i.test(s))
    return 'Недостаточно кредитов RiftAI для этого запроса. Пополни баланс на riftai.su/pricing';
  if (/IMAGE_OTHER/i.test(s))
    return 'Контент заблокирован фильтром. Попробуй другой промт или более нейтральный референс';
  if (/IMAGE_SAFETY/i.test(s) || /safety/i.test(s))
    return 'Контент заблокирован по соображениям безопасности. Измени промт';
  if (/blocked/i.test(s) && /refunded/i.test(s))
    return 'Генерация заблокирована фильтром (кредиты возвращены). Попробуй другой промт';
  if (/rate.?limit/i.test(s))
    return 'Слишком много запросов. Подожди немного и попробуй снова';
  if (/upstream_error/i.test(s))
    return 'Ошибка на стороне RiftAI. Попробуй ещё раз через минуту';
  if (/network error/i.test(s))
    return 'Ошибка сети при обращении к RiftAI. Попробуй ещё раз';
  if (/HTTP 5/i.test(s))
    return 'Сервер RiftAI временно недоступен. Попробуй через минуту';
  if (/No image from RiftAI/i.test(s))
    return 'RiftAI не вернул изображение. Попробуй ещё раз';
  if (/Invalid encrypted data/i.test(s) || /Missing key/i.test(s))
    return 'Ошибка конфигурации: неверный или отсутствующий API-ключ';
  if (/Missing imgbb/i.test(s))
    return 'Ошибка конфигурации: отсутствует ImgBB ключ';
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

// ---------- Замена generic-слов на имена персонажей ----------
function replaceGenericWords(prompt, chars) {
  if (!chars || chars.length === 0) return prompt;
  const names = chars.map(c => c.name).filter(Boolean);
  if (names.length === 0) return prompt;
  let result = prompt;
  if (names.length === 1) {
    const name = names[0];
    // Порядок важен: сначала длинные фразы, потом короткие
    const generics = [
      'the young man','the young woman','the older man','the older woman',
      'the man','the woman','the guy','the girl','the person','the figure','the character','the individual',
      'a young man','a young woman','an older man','an older woman',
      'a man','a woman','a guy','a girl','a person','a figure','a character',
      'young man','young woman','older man','older woman',
      'man','woman','guy','girl','person','figure',
      'мужчина','женщина','парень','девушка','персонаж','человек','молодой человек','молодая девушка',
      'мужчину','женщину','парня','девушку','персонажа','человека',
      'мужчине','женщине','парню','девушке',
      'мужчиной','женщиной','парнем','девушкой',
      'мужчины','женщины','парня','девушки',
    ];
    for (const word of generics) {
      result = result.replace(new RegExp(`\\b${word}\\b`, 'gi'), name);
    }
  } else {
    // При 2+ персонажах добавляем явное указание в начало промта
    const nameList = names.join(' and ');
    const hint = `CRITICAL: The ONLY people in this image are ${nameList}. Never use generic terms like man/woman/guy/girl/person/figure — use ONLY their names. `;
    result = hint + result;
  }
  if (result !== prompt) console.log(`🔤 Generic words replaced. Names: ${names.join(', ')}`);
  return result;
}

// ---------- Расшифровка ----------
function decryptData(encryptedBase64, secretKeyBase64) {
  try {
    // Поддерживаем оба формата: новый (--) и старый (:)
    let normalized = encryptedBase64
      .replace(/[\r\n\t ]/g, '')
      .replace(/%2B/gi, '+')
      .replace(/%2F/gi, '/')
      .replace(/%3D/gi, '=');

    let ivBase64, encryptedBase64Data;
    if (normalized.includes('--')) {
      const parts = normalized.split('--');
      ivBase64 = parts[0];
      encryptedBase64Data = parts[1];
    } else if (normalized.includes(':')) {
      const parts = normalized.split(':');
      ivBase64 = parts[0];
      encryptedBase64Data = parts[1];
    } else {
      console.error('Invalid format: no separator found');
      return null;
    }

    // Исправляем padding
    const stripped = encryptedBase64Data.replace(/=+$/, '');
    const missing = (4 - (stripped.length % 4)) % 4;
    encryptedBase64Data = stripped + '='.repeat(missing);

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
  // Авто-фикс ссылки на страницу ImgBB → прямую ссылку
  if (/^https?:\/\/ibb\.co\/[a-zA-Z0-9]+$/.test(url)) {
    try {
      const pageRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const html = await pageRes.text();
      const match = html.match(/https:\/\/i\.ibb\.co\/[^"'\s]+\.(?:jpg|jpeg|png|webp|gif)/i);
      if (match) { console.log(`🔗 Fixed ImgBB URL: ${url} → ${match[0]}`); url = match[0]; }
    } catch(e) { console.warn('ImgBB URL fix failed:', e.message); }
  }
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

// ---------- Fetch с retry ----------
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
    lastError = new Error(friendlyError(`RiftAI HTTP ${res.status}: ${errorDetails}`));

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
    console.log('🔍 RAW data:', req.query.data?.slice(0, 80));

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
        return errorSvg(res, 'Ошибка расшифровки data: возможно, ключ шифрования в Vercel не совпадает с тем, что использовался в шифраторе. Перешифруй ключи заново на сайте шифратора и обнови DATA в промте.');
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
      return errorSvg(res, 'Missing key, prompt, or userId');
    }
    if (!imgbb_key) {
      console.error('❌ 400: imgbb_key missing');
      return errorSvg(res, 'Missing imgbb_key');
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

    // ---- Парсим персонажей заранее для замены generic-слов ----
    let chars = [];
    try {
      chars = JSON.parse(charactersRaw || '[]');
      console.log(`📸 [6/9] Референсов: ${chars.length}`);
    } catch(e) {
      console.warn('Ошибка парсинга characters:', e.message);
    }

    // Заменяем generic-слова на имена персонажей
    const cleanPrompt = replaceGenericWords(prompt, chars);
    const fullPrompt = `${finalStyle}\n\n${cleanPrompt}`;

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
      if (!b64) {
        const rawMsg = JSON.stringify(riftData).slice(0, 400);
        throw new Error(friendlyError(rawMsg));
      }
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
      console.log('🔍 RiftAI response keys:', JSON.stringify(Object.keys(riftData)));
      console.log('🔍 RiftAI response (truncated):', JSON.stringify(riftData).slice(0, 800));
      let b64 = riftData.data?.b64_json || riftData.b64_json || riftData.image;
      if (!b64 && riftData.choices?.[0]?.message?.content) {
        const content = riftData.choices[0].message.content;
        console.log('🔍 content type:', typeof content, Array.isArray(content) ? 'array len=' + content.length : '');
        // content может быть массивом (multimodal response)
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === 'image_url' && part.image_url?.url) {
              const match = part.image_url.url.match(/data:image\/[^;]+;base64,([a-zA-Z0-9+/=]+)/);
              if (match) { b64 = match[1]; break; }
            }
            if (part.type === 'image' && part.source?.data) {
              b64 = part.source.data; break;
            }
          }
        } else if (typeof content === 'string') {
          const match = content.match(/data:image\/[^;]+;base64,([a-zA-Z0-9+/=]+)/);
          if (match) b64 = match[1];
        }
      }
      if (!b64) {
        const rawMsg = riftData.choices?.[0]?.message?.content || JSON.stringify(riftData).slice(0, 400);
        console.error('❌ Full RiftAI response:', JSON.stringify(riftData).slice(0, 1500));
        throw new Error(friendlyError(rawMsg));
      }
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
    return errorSvg(res, err.message);
  }
}
