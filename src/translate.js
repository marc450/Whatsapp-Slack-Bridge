const DEEPL_API_KEY = process.env.DEEPL_API_KEY;
const DEEPL_URL = "https://api-free.deepl.com/v2/translate";

// Translate text and return { text, detectedLanguage }
async function translate(text, targetLang, sourceLang = null) {
  if (!DEEPL_API_KEY) throw new Error("DEEPL_API_KEY not set");
  if (!text || !text.trim()) return { text, detectedLanguage: null };

  const params = new URLSearchParams({
    text,
    target_lang: targetLang,
  });
  if (sourceLang) params.append("source_lang", sourceLang);

  const response = await fetch(DEEPL_URL, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${DEEPL_API_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`DeepL error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const result = data.translations[0];
  return {
    text: result.text,
    detectedLanguage: result.detected_source_language,
  };
}

module.exports = { translate };
