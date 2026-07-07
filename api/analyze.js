const MAX_TEXT_ADS = 30;
const MAX_IMAGE_ADS = 8;

const MODEL_CHAIN = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchImageAsInlineData(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    const buffer = await resp.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    return { mimeType: contentType.split(';')[0], data: base64 };
  } catch (e) {
    return null;
  }
}

function extractConceptJson(rawText) {
  const match = rawText.match(/```json\s*([\s\S]*?)```/i);
  if (!match) return { narrative: rawText.trim(), concept: null };
  const narrative = rawText.replace(match[0], '').trim();
  try {
    const concept = JSON.parse(match[1]);
    return { narrative, concept };
  } catch (e) {
    return { narrative, concept: null };
  }
}

async function callGeminiWithFallback(apiKey, parts) {
  let lastMessage = 'No se pudo contactar a ningún modelo.';

  for (const model of MODEL_CHAIN) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts }] })
          }
        );
        const data = await response.json();

        if (response.ok) {
          const text = data.candidates &&
            data.candidates[0] &&
            data.candidates[0].content &&
            data.candidates[0].content.parts &&
            data.candidates[0].content.parts[0] &&
            data.candidates[0].content.parts[0].text;
          return { text: text || 'Sin respuesta del modelo.', modelUsed: model };
        }

        lastMessage = (data.error && data.error.message) || `Error ${response.status} en ${model}`;
        if (response.status === 503 || response.status === 429) {
          await sleep(1200 * (attempt + 1));
          continue;
        }
        return { error: lastMessage };

      } catch (e) {
        lastMessage = e.message;
        await sleep(800);
      }
    }
  }
  return { error: `Todos los modelos de Gemini están saturados ahora mismo (${lastMessage}). Intenta de nuevo en un par de minutos.` };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Falta configurar GEMINI_API_KEY en las variables de entorno del proyecto en Vercel.' });
    return;
  }

  const { ads, queryLabel } = req.body || {};
  if (!ads || !Array.isArray(ads) || ads.length === 0) {
    res.status(400).json({ error: 'No hay anuncios para analizar.' });
    return;
  }

  const sample = ads.slice(0, MAX_TEXT_ADS).map(ad => ({
    anunciante: ad.page && ad.page.name,
    texto: ad.content && ad.content.ad_text,
    titulo: ad.content && ad.content.title,
    cta: ad.content && ad.content.cta_text,
    inicio: ad.targeting && ad.targeting.start_date,
    fin: ad.targeting && ad.targeting.end_date,
    activo: ad.targeting && ad.targeting.is_active,
    plataformas: ad.targeting && ad.targeting.platform
  }));

  const adsWithImages = ads.filter(ad => ad.media && ad.media.media_urls && ad.media.media_urls[0]).slice(0, MAX_IMAGE_ADS);
  const imageResults = await Promise.all(
    adsWithImages.map(ad => fetchImageAsInlineData(ad.media.media_urls[0]))
  );

  const promptIntro = `Eres un estratega de marketing digital y director creativo analizando anuncios extraídos de la Meta Ad Library para: ${queryLabel || 'la búsqueda actual'}.

Aquí están los datos de ${sample.length} anuncios en JSON (texto, fechas, estado, plataformas):
${JSON.stringify(sample, null, 2)}

También te comparto ${imageResults.filter(Boolean).length} imágenes/creativos reales de algunos de estos anuncios para que analices el mensaje visual, el texto incrustado en la imagen, estilo y colores.

IMPORTANTE sobre límites de los datos: esta información viene de la Ad Library pública de Meta, NO incluye métricas de rendimiento (clics, CTR, gasto, conversiones). Cuando hables de "qué está funcionando", acláralo explícitamente como una INFERENCIA basada en señales indirectas (tiempo activo, cantidad de variantes similares, mensajes repetidos) — nunca como dato confirmado.

Escribe el análisis en español, en formato Markdown, usando ## para cada sección (no uses # de nivel 1), con estas secciones:
## Patrones de mensaje
## Qué comunican los creativos visuales
## Ganchos, ofertas y CTAs
## Plataformas y qué sugiere
## Señales indirectas de qué podría estar funcionando
## Recomendaciones para diferenciarse

Sé específico citando ejemplos reales. Usa **negritas** para los términos clave y listas con viñetas donde ayude a la lectura. Evita generalidades vacías.

Al final de TODO el análisis, en un bloque separado, agrega EXACTAMENTE este formato (JSON válido dentro de un bloque \`\`\`json) proponiendo UN concepto de anuncio nuevo y diferenciado basado en tus hallazgos — esto se usará para construir una vista previa visual real, así que sé concreto y usa colores hexadecimales reales que hayas visto o que tengan sentido para diferenciarse de la competencia:

\`\`\`json
{
  "colors": [{"hex": "#XXXXXX", "name": "nombre corto"}, {"hex": "#XXXXXX", "name": "nombre corto"}, {"hex": "#XXXXXX", "name": "nombre corto"}],
  "concept_headline": "máximo 8 palabras, en español",
  "concept_subheadline": "máximo 14 palabras, en español",
  "concept_cta": "texto de botón, máximo 3 palabras",
  "concept_style_notes": "una frase describiendo el estilo visual recomendado y por qué se diferencia de la competencia"
}
\`\`\``;

  const parts = [{ text: promptIntro }];
  imageResults.forEach(img => {
    if (img) parts.push({ inlineData: img });
  });

  const result = await callGeminiWithFallback(apiKey, parts);

  if (result.error) {
    res.status(503).json({ error: result.error });
    return;
  }

  const { narrative, concept } = extractConceptJson(result.text);

  res.status(200).json({
    text: narrative,
    concept,
    imagesAnalyzed: imageResults.filter(Boolean).length,
    modelUsed: result.modelUsed
  });
};
