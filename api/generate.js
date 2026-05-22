    // ---- Получение параметров ----
    let key, charactersRaw, imgbb_key;

    if (req.query.data && encryptionKey) {
      const decrypted = decryptData(req.query.data, encryptionKey);
      if (decrypted && typeof decrypted === 'object') {
        key = decrypted.key;
        // charactersRaw НЕ берём из decrypted, только key и imgbb_key
        imgbb_key = decrypted.imgbb_key;
        console.log('✅ [3/9] Данные расшифрованы');
      } else {
        console.error('❌ [3/9] Ошибка расшифровки');
        return res.status(400).send('Invalid encrypted data');
      }
    } else {
      key = req.query.key;
      imgbb_key = req.query.imgbb_key;
      console.log('⚠️ [3/9] Используется незашифрованный запрос');
    }

    // charactersRaw всегда берём из URL (не из шифровки)
    charactersRaw = req.query.characters;

    // Декодируем, если закодировано
    if (charactersRaw && typeof charactersRaw === 'string' && (charactersRaw.includes('%') || charactersRaw.includes('+'))) {
      try {
        charactersRaw = decodeURIComponent(charactersRaw);
        console.log('🔓 characters decoded');
      } catch (e) { console.warn('Decode failed', e.message); }
    }
