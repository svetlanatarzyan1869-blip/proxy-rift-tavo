# rift-proxy

Image generation proxy for **RiftAI** — supports GPT Image and Gemini models with character references, style presets, ImgBB upload, and Redis cache.

## Supported models

| Model | Strategy |
|---|---|
| `gpt-image-1`, `gpt-image-1.5`, `gpt-image-2`, `gpt-image-1-mini` | `/v1/images/edits` — references as multipart files |
| `gemini-2.5-flash-image`, `gemini-3.1-flash-image-preview`, `gemini-3-pro-image-preview` | `/v1/chat/completions` — references as base64 in messages |

Default model: `gemini-3.1-flash-image-preview`

---

## Deploy to Vercel

```bash
git clone https://github.com/YOUR_USERNAME/rift-proxy
cd rift-proxy
vercel deploy
```

### Environment variables (set in Vercel dashboard)

| Variable | Description |
|---|---|
| `ENCRYPTION_KEY` | Base64-encoded 32-byte AES key |
| `REDIS_URL` | Redis connection string (optional, for caching) |

---

## API

```
GET /api/generate
  ?data=ENCRYPTED_BASE64        — encrypted payload (key + imgbb_key + characters)
  &prompt=URL_ENCODED_PROMPT    — scene description
  &style=kodak_portra_400       — style name from styles.json (optional)
  &model=gpt-image-1            — model name (optional)
  &userId=USER_ID               — for cache key
```

The encrypted `data` payload (JSON before encryption):
```json
{
  "key": "sk-riftai-...",
  "imgbb_key": "...",
  "characters": "[{\"name\":\"Alex\",\"url\":\"https://...\"}]"
}
```

Response: `302 redirect` to the ImgBB image URL.

---

## SillyTavern / Tavo prompt template

```
RULE: One image per message, middle of text.

=== YOUR SETTINGS (edit once) ===
DATA    = <your encrypted data>
MODEL   = gemini-3.1-flash-image-preview
USER_ID = <your user id>
STYLE   =
CHARACTERS:
* char1
* char2

ALGORITHM:
1. CRITICAL: You will execute the following steps EXACTLY ONCE per user message.
   After you output the HTML, you MUST NOT generate any additional image,
   call the API again, or create alternative descriptions.
2. Analyse last messages → who, where, action, emotion, lighting.
3. Write 3-5 sentences of story.
4. Pick ONE single vivid moment → describe in ONE sentence.
   This description must be final and unique.
   DO NOT propose alternatives, DO NOT generate multiple candidates.
5. URL-encode that sentence (spaces→%20, commas→%2C, etc.).
6. Build JSON array of characters present.
   Example: [{"name":"Maks","url":"..."}]
   Then URL-encode the JSON string (no backslashes).
7. Build exactly ONE GET URL:
   https://YOUR_VERCEL_URL/api/generate?data=DATA&characters=URL_ENCODED_JSON&prompt=URL_ENCODED_DESCRIPTION&style=STYLE&model=MODEL&userId=USER_ID
8. Insert the URL into <img src> in the HTML template below.
9. STOP. No further processing. No second image. No alternative prompts.

TEMPLATE:
[text before]
<div style="max-width:680px;margin:20px auto;padding:18px;background:linear-gradient(160deg,rgba(18,18,18,0.96),rgba(10,10,10,0.96));border:1px solid rgba(255,255,255,0.06);border-radius:16px;box-shadow:0 12px 32px rgba(0,0,0,0.65);">
  <img src="URL" style="width:100%;height:auto;display:block;border-radius:12px;">
  <div style="text-align:center;color:#a8a8a8;margin-top:16px;"><i>short description</i></div>
</div>
[text after]

CRITICAL:
- Only characters actually in scene.
- URL-encode JSON, no backslashes.
- If a suitable ImgBB link already exists in chat, reuse it directly.
- STRICTLY ONE IMAGE PER RESPONSE. NO DUPLICATES. NO VARIATIONS. NO SECOND CALLS.
```

---

## File structure

```
rift-proxy/
├── api/
│   └── generate.js   — main handler
├── api/
│   └── styles.json   — style presets (place here)
├── vercel.json
├── package.json
└── README.md
```
