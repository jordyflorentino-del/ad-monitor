const MAX_IMAGE_POSTS = 8;
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
  if (!match) return { narrative: rawText.trim(), insights: null, overallScore: null, topPosts: null };
  const narrative = rawText.replace(match[0], '').trim();
  try {
    const parsed = JSON.parse(match[1]);
    return {
      narrative,
      insights: parsed.insights || null,
      overallScore: parsed.overall_score || null,
      topPosts: Array.isArray(parsed.top_posts) ? parsed.top_posts : null,
      cadenceRecommendation: parsed.cadence_recommendation || null
    };
  } catch (e) {
    return { narrative, insights: null, overallScore: null, topPosts: null };
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

  const { profiles } = req.body || {};
  if (!profiles || !Array.isArray(profiles) || profiles.length === 0) {
    res.status(400).json({ error: 'No hay perfiles para analizar.' });
    return;
  }

  const sample = profiles.map(p => ({
    plataforma: p.platform,
    usuario: p.handle,
    nombre: p.name,
    bio: p.bio,
    seguidores: p.followers,
    publicaciones_totales: p.postsCount,
    verificado: p.isVerified,
    posts_recientes: (p.posts || []).slice(0, 12).map((post, i) => ({
      id: post.id || `idx_${i}`,
      texto: post.caption,
      es_video: post.isVideo,
      vistas: post.views,
      likes: post.likes,
      comentarios: post.comments,
      compartidos: post.shares || null,
      publicado: post.publishedAt
    }))
  }));

  // Reunir hasta MAX_IMAGE_POSTS miniaturas repartidas entre plataformas para que
  // Gemini vea el estilo visual real del contenido, no solo los números.
  const thumbCandidates = [];
  profiles.forEach(p => (p.posts || []).forEach(post => {
    if (post.thumbnail) thumbCandidates.push(post.thumbnail);
  }));
  const thumbsToFetch = thumbCandidates.slice(0, MAX_IMAGE_POSTS);
  const imageResults = await Promise.all(thumbsToFetch.map(fetchImageAsInlineData));

  const promptIntro = `Eres un estratega de marketing digital especializado en crecimiento orgánico de redes sociales (Instagram, TikTok, Facebook), analizando el/los perfil(es) de un artista/marca para: ${sample.map(s => `${s.plataforma} @${s.usuario}`).join(', ')}.

Datos de los perfiles y sus publicaciones más recientes en JSON:
${JSON.stringify(sample, null, 2)}

También te comparto ${imageResults.filter(Boolean).length} miniaturas reales de algunas publicaciones para que evalúes el estilo visual, composición y consistencia de marca.

IMPORTANTE sobre los datos: vistas/likes/comentarios son las métricas públicas reales de cada publicación (no son inferidas). El número de seguidores es el actual al momento de la consulta, no un histórico.

Escribe el análisis en español, en formato Markdown, usando ## para cada sección (no uses # de nivel 1), con estas secciones:
## Diagnóstico general de las cuentas
## Qué tipo de contenido genera más interacción
## Consistencia visual y de marca
## Comparación entre plataformas (si hay más de una)
## Oportunidades de crecimiento orgánico

Sé específico citando ejemplos reales de las publicaciones (por texto o tema, no inventes cifras que no te di). Usa **negritas** para términos clave y listas con viñetas donde ayude a la lectura.

Al final de TODO el análisis, en un bloque separado, agrega EXACTAMENTE este formato (JSON válido dentro de un bloque \`\`\`json):

REGLA CRÍTICA para "overall_score": es tu EVALUACIÓN CUALITATIVA como estratega experto, basada en las métricas reales que te di (relación seguidores/engagement, consistencia de publicación aparente por las fechas, calidad visual de las miniaturas) — no inventes datos que no están en el JSON de entrada.

REGLA CRÍTICA para "top_posts": selecciona ÚNICAMENTE ids que existan tal cual en los datos que te compartí, ordenados por desempeño relativo (vistas/likes sobre el promedio de esa cuenta). Máximo 5.

\`\`\`json
{
  "overall_score": {
    "total": 72,
    "consistencia_publicacion": 65,
    "calidad_visual": 78,
    "engagement_relativo": 70,
    "coherencia_de_marca": 75
  },
  "top_posts": [
    {"id": "el id exacto de la publicación", "plataforma": "tiktok", "motivo": "por qué destaca en una frase corta"}
  ],
  "cadence_recommendation": {
    "headline": "una oración con la cadencia de publicación sugerida por plataforma",
    "instagram": "ej. 4 posts/semana + 3 historias diarias",
    "tiktok": "ej. 5 videos/semana",
    "facebook": "ej. 3 posts/semana"
  },
  "insights": {
    "patrones_contenido": {
      "headline": "una oración sobre qué tipo de contenido repite mejor desempeño",
      "items": [{"label": "tipo de contenido", "pct": 40}, {"label": "...", "pct": 30}, {"label": "...", "pct": 20}]
    },
    "mejores_formatos": {
      "headline": "una oración sobre qué formato (reel/carrusel/foto/video) rinde mejor",
      "items": [{"label": "formato", "pct": 55}, {"label": "...", "pct": 30}, {"label": "...", "pct": 15}]
    },
    "oportunidades": {
      "headline": "una oración sobre los huecos de contenido u oportunidades detectadas",
      "items": [{"label": "oportunidad concreta", "delta": "+15%"}, {"label": "...", "delta": "+10%"}, {"label": "...", "delta": "+8%"}]
    }
  }
}
\`\`\``;

  const parts = [{ text: promptIntro }];
  imageResults.forEach(img => { if (img) parts.push({ inlineData: img }); });

  const result = await callGeminiWithFallback(apiKey, parts);
  if (result.error) {
    res.status(503).json({ error: result.error });
    return;
  }

  const { narrative, insights, overallScore, topPosts, cadenceRecommendation } = extractStructuredJson(result.text);

  res.status(200).json({
    text: narrative,
    insights,
    overallScore,
    topPosts,
    cadenceRecommendation,
    imagesAnalyzed: imageResults.filter(Boolean).length,
    modelUsed: result.modelUsed
  });
};
