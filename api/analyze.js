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

function extractStructuredJson(rawText) {
  const match = rawText.match(/```json\s*([\s\S]*?)```/i);
  if (!match) return { narrative: rawText.trim(), concept: null, insights: null, overallScore: null, adScores: null };
  const narrative = rawText.replace(match[0], '').trim();
  try {
    const parsed = JSON.parse(match[1]);
    return {
      narrative,
      concept: parsed.concept || null,
      insights: parsed.insights || null,
      overallScore: parsed.overall_score || null,
      adScores: Array.isArray(parsed.ad_scores) ? parsed.ad_scores : null
    };
  } catch (e) {
    return { narrative, concept: null, insights: null, overallScore: null, adScores: null };
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

  const sample = ads.slice(0, MAX_TEXT_ADS).map((ad, i) => ({
    id: ad.adArchiveID || `idx_${i}`,
    anunciante: ad['pageInfo.page.name'] || (ad.pageInfo && ad.pageInfo.page && ad.pageInfo.page.name),
    texto: ad.adText || (ad.adCreativeBodies && ad.adCreativeBodies[0]),
    titulo: ad['snapshot.title'],
    inicio: ad.startDateFormatted,
    fin: ad.endDateFormatted,
    activo: ad.isActive,
    plataformas: ad.publisherPlatform
  }));

  const getAdImage = ad => ad.snapshotImageUrl || ad.imageUrl || (ad.images && ad.images[0]) || null;
  const adsWithImages = ads.filter(getAdImage).slice(0, MAX_IMAGE_ADS);
  const imageResults = await Promise.all(
    adsWithImages.map(ad => fetchImageAsInlineData(getAdImage(ad)))
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

Al final de TODO el análisis, en un bloque separado, agrega EXACTAMENTE este formato (JSON válido dentro de un bloque \`\`\`json) con DOS partes: "insights" (para tarjetas resumen visuales) y "concept" (para una vista previa de anuncio nuevo).

REGLA CRÍTICA para "insights": los porcentajes deben ser FRECUENCIAS REALES calculadas sobre los ${sample.length} anuncios que te compartí — por ejemplo, "de los anuncios analizados, qué % menciona transformación/beneficio X en su texto". NUNCA inventes métricas de rendimiento (CTR, engagement, conversiones) — eso no existe en estos datos y no debes fabricarlo. Para "oportunidades", los valores son sugerencias cualitativas tuyas, no datos medidos — represéntalos como una recomendación con un signo "+" solo si tiene sentido como estimación aproximada, y dejamos claro en la interfaz que es inferencia.

REGLA CRÍTICA para "overall_score" y "ad_scores": estos son una EVALUACIÓN CUALITATIVA DE CALIDAD CREATIVA hecha por ti como director creativo experto — NO son métricas de rendimiento real (no existe CTR, conversión ni gasto en estos datos). Básate en criterios de copywriting y diseño publicitario observables en el texto/imagen (claridad del mensaje, fuerza del gancho, presencia de oferta concreta, fuerza del CTA, señales de urgencia, presencia de prueba social). "overall_score" es tu evaluación holística del conjunto de anuncios analizados. "ad_scores" debe incluir EXACTAMENTE un objeto por cada anuncio de la muestra (usa el campo "id" tal cual te lo compartí, sin modificarlo) — si no puedes evaluar algún criterio por falta de información en ese anuncio específico, usa 5 como valor neutro en vez de inventar.

\`\`\`json
{
  "overall_score": {
    "total": 84,
    "competitividad": 85,
    "creatividad": 82,
    "claridad_mensaje": 90,
    "fuerza_cta": 74
  },
  "ad_scores": [
    {"id": "el id exacto del anuncio", "gancho": 8, "creatividad": 7, "oferta": 9, "cta": 6, "urgencia": 4, "prueba_social": 8}
  ],
  "insights": {
    "patrones_mensaje": {
      "headline": "una oración con un % real basado en frecuencia de mensaje en el texto de los anuncios",
      "items": [{"label": "nombre corto del patrón", "pct": 24}, {"label": "...", "pct": 19}, {"label": "...", "pct": 15}]
    },
    "ganchos_ctas": {
      "headline": "una oración sobre qué tipo de gancho o CTA se repite más, con % real",
      "items": [{"label": "gancho o CTA corto", "pct": 31}, {"label": "...", "pct": 27}, {"label": "...", "pct": 22}]
    },
    "formatos": {
      "headline": "una oración sobre qué formato (imagen/video/carrusel) predomina, con % real",
      "items": [{"label": "formato", "pct": 54}, {"label": "...", "pct": 28}, {"label": "...", "pct": 18}]
    },
    "senales_indirectas": {
      "headline": "una oración sobre qué sugiere el tiempo activo/variantes en paralelo (aclarando que es inferencia)",
      "items": [{"label": "señal", "pct": 38}, {"label": "...", "pct": 27}, {"label": "...", "pct": 21}]
    },
    "oportunidades": {
      "headline": "una oración sobre huecos que ves para diferenciarse",
      "items": [{"label": "oportunidad concreta", "delta": "+18%"}, {"label": "...", "delta": "+14%"}, {"label": "...", "delta": "+12%"}]
    }
  },
  "concept": {
    "colors": [{"hex": "#XXXXXX", "name": "nombre corto"}, {"hex": "#XXXXXX", "name": "nombre corto"}, {"hex": "#XXXXXX", "name": "nombre corto"}],
    "concept_headline": "máximo 8 palabras, en español",
    "concept_subheadline": "máximo 14 palabras, en español",
    "concept_cta": "texto de botón, máximo 3 palabras",
    "concept_style_notes": "una frase describiendo el estilo visual recomendado y por qué se diferencia de la competencia"
  }
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

  const { narrative, concept, insights, overallScore, adScores } = extractStructuredJson(result.text);

  res.status(200).json({
    text: narrative,
    concept,
    insights,
    overallScore,
    adScores,
    imagesAnalyzed: imageResults.filter(Boolean).length,
    modelUsed: result.modelUsed
  });
};
