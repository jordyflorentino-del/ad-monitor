module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Falta configurar ANTHROPIC_API_KEY en las variables de entorno del proyecto en Vercel.' });
    return;
  }

  const { ads, queryLabel } = req.body || {};
  if (!ads || !Array.isArray(ads) || ads.length === 0) {
    res.status(400).json({ error: 'No hay anuncios para analizar.' });
    return;
  }

  const sample = ads.slice(0, 30).map(ad => ({
    anunciante: ad.page && ad.page.name,
    texto: ad.content && ad.content.ad_text,
    titulo: ad.content && ad.content.title,
    cta: ad.content && ad.content.cta_text,
    inicio: ad.targeting && ad.targeting.start_date,
    fin: ad.targeting && ad.targeting.end_date,
    activo: ad.targeting && ad.targeting.is_active,
    plataformas: ad.targeting && ad.targeting.platform
  }));

  const prompt = `Eres un estratega de marketing digital analizando anuncios extraídos de la Meta Ad Library para: ${queryLabel || 'la búsqueda actual'}.

Aquí están los datos de ${sample.length} anuncios en JSON:
${JSON.stringify(sample, null, 2)}

Da un análisis en español, directo y accionable, con estas secciones:
1. Patrones de mensaje/ángulos creativos que se repiten
2. Ganchos, ofertas y CTAs más usados
3. Plataformas priorizadas (Facebook, Instagram, etc.) y qué sugiere eso
4. Actividad (¿están escalando, pausando, probando muchas variantes?)
5. 3 recomendaciones concretas para diferenciarse de esta competencia

Sé específico citando ejemplos del texto cuando sea relevante. Evita generalidades vacías.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      res.status(response.status).json({ error: data.error ? data.error.message : 'Error de la API de Anthropic.' });
      return;
    }

    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    res.status(200).json({ text });
  } catch (err) {
    res.status(500).json({ error: `No se pudo completar el análisis: ${err.message}` });
  }
};
