const MAX_TEXT_ADS = 30;
const MAX_IMAGE_ADS = 8;

// Try these in order — if one is overloaded (503) or rate-limited (429), fall back to the next.
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

        // Overloaded or rate-limited: worth retrying / falling back. Anything else is likely a real error (bad key, bad request) — stop immediately.
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
    // exhausted retries on this model, move to the next one in the chain
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

  const promptIntro = `Eres un estratega de marketing digital analizando anuncios extraídos de la Meta Ad Library para: ${queryLabel || 'la búsqueda actual'}.

Aquí están los datos de ${sample.length} anuncios en JSON (texto, fechas, estado, plataformas):
${JSON.stringify(sample, null, 2)}

También te comparto ${imageResults.filter(Boolean).length} imágenes/creativos reales de algunos de estos anuncios (en el mismo orden en que aparecen a continuación) para que analices el mensaje visual, el texto incrustado en la imagen, estilo y colores.

IMPORTANTE sobre límites de los datos: esta información viene de la Ad Library pública de Meta, NO incluye métricas de rendimiento (clics, CTR, gasto, conversiones). Cuando hables de "qué está funcionando", acláralo explícitamente como una INFERENCIA basada en señales indirectas (tiempo que lleva activo el anuncio, cantidad de variantes similares corriendo en paralelo, mensajes repetidos) — nunca lo presentes como dato confirmado de rendimiento real.

Da un análisis en español, directo y accionable, con estas secciones:
1. Patrones de mensaje/ángulos creativos que se repiten (texto Y visual)
2. Qué comunican las imágenes/creativos: estilo, ganchos visuales, texto incrustado
3. Ganchos, ofertas y CTAs más usados
4. Plataformas priorizadas y qué sugiere eso
5. Señales indirectas de qué podría estar funcionando (con la aclaración de que es inferencia, no dato confirmado)
6. 3 recomendaciones concretas para diferenciarse de esta competencia

Sé específico citando ejemplos del texto y de lo que veas en las imágenes. Evita generalidades vacías.`;

  const parts = [{ text: promptIntro }];
  imageResults.forEach(img => {
    if (img) parts.push({ inlineData: img });
  });

  const result = await callGeminiWithFallback(apiKey, parts);

  if (result.error) {
    res.status(503).json({ error: result.error });
    return;
  }

  res.status(200).json({ text: result.text, imagesAnalyzed: imageResults.filter(Boolean).length, modelUsed: result.modelUsed });
};
