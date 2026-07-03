const ACTOR_ID = 'g1aC9GnyEMiNjQFQX'; // scraperhive/meta-ads-library-scraper

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  const token = process.env.APIFY_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'Falta configurar APIFY_TOKEN en las variables de entorno del proyecto en Vercel.' });
    return;
  }

  const { term, country, status, maxAds } = req.body || {};
  if (!term) {
    res.status(400).json({ error: 'Falta el término de búsqueda.' });
    return;
  }

  const safeCountry = country || 'MX';
  const safeStatus = status || 'active';
  const safeMax = Math.min(parseInt(maxAds, 10) || 50, 500);

  const adsLibraryUrl = `https://www.facebook.com/ads/library/?active_status=${safeStatus}&ad_type=all&country=${safeCountry}&q=${encodeURIComponent(term)}&search_type=keyword_unordered&media_type=all`;

  try {
    const apifyRes = await fetch(
      `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: [adsLibraryUrl], status: safeStatus, maxAds: safeMax })
      }
    );

    if (!apifyRes.ok) {
      const text = await apifyRes.text();
      res.status(apifyRes.status).json({ error: `Error de Apify: ${text.slice(0, 300)}` });
      return;
    }

    const data = await apifyRes.json();
    res.status(200).json({ ads: Array.isArray(data) ? data : [] });
  } catch (err) {
    res.status(500).json({ error: `No se pudo conectar con Apify: ${err.message}` });
  }
};
