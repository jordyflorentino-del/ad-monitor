const ACTOR_SLUG = 'whoareyouanas~meta-ad-scraper'; // whoareyouanas/meta-ad-scraper — 4.9★, 2.2K usuarios, trae images[]/videos[] reales

// Convierte "1/15/2025" (formato del actor) a ISO, que es lo que el resto de la app espera.
function toIsoDate(mdy) {
  if (!mdy) return null;
  const parts = String(mdy).split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts.map(n => parseInt(n, 10));
  if (!m || !d || !y) return null;
  return new Date(Date.UTC(y, m - 1, d)).toISOString();
}

// Extrae el slug/nombre de página de una URL de Facebook para usarlo como búsqueda,
// ya que este actor no acepta una URL de página cruda como identificador directo.
function extractPageSlug(pageUrl) {
  try {
    const clean = pageUrl.trim().replace(/^https?:\/\/(www\.)?facebook\.com\//i, '');
    return decodeURIComponent(clean.split('?')[0].split('/')[0]).replace(/[-_.]/g, ' ');
  } catch (e) {
    return pageUrl;
  }
}

// Traduce el output del actor nuevo al mismo shape que ya consumen index.html y analyze.js
// (pageInfo.page.name, adText, startDateFormatted, snapshotImageUrl, adArchiveID, isActive, publisherPlatform...)
// para no tener que tocar el resto de la app.
function normalizeAd(ad) {
  const image = ad.images && ad.images[0] && ad.images[0].url;
  const video = ad.videos && ad.videos[0] && ad.videos[0].url;
  return {
    adArchiveID: ad.libraryID,
    'pageInfo.page.name': ad.brand,
    adText: ad.body || '',
    'snapshot.title': ad.linkTitle || '',
    startDateFormatted: toIsoDate(ad.startDate),
    endDateFormatted: null,
    isActive: !!ad.active,
    publisherPlatform: ad.platforms || [],
    snapshotImageUrl: image || null,
    imageUrl: image || null,
    videoUrl: video || null, // no usado en la UI todavía, disponible para una futura vista previa de video
    adLibraryURL: `https://www.facebook.com/ads/library/?id=${ad.libraryID}`
  };
}

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

  const { term, pageUrl, country, status, maxAds } = req.body || {};

  const safeMax = Math.min(parseInt(maxAds, 10) || 50, 500);
  const statusMap = { active: 'active', inactive: 'inactive', all: 'all' };
  const safeStatus = statusMap[status] || 'active';

  const input = { activeStatus: safeStatus };

  if (country && country !== 'ALL') input.country = country;

  if (pageUrl && pageUrl.trim()) {
    input.searchQuery = extractPageSlug(pageUrl);
  } else if (term && term.trim()) {
    input.searchQuery = term.trim();
  } else {
    res.status(400).json({ error: 'Escribe una palabra clave o pega la URL exacta de la página.' });
    return;
  }

  // Proxy residencial de Apify — necesario para tener cobertura completa de resultados.
  // La contraseña del proxy de Apify es el mismo token de tu cuenta.
  input.proxyUrl = `http://groups-RESIDENTIAL:${token}@proxy.apify.com:8000`;

  try {
    const apifyRes = await fetch(
      `https://api.apify.com/v2/acts/${ACTOR_SLUG}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      }
    );

    if (!apifyRes.ok) {
      const text = await apifyRes.text();
      res.status(apifyRes.status).json({ error: `Error de Apify: ${text.slice(0, 300)}` });
      return;
    }

    const data = await apifyRes.json();
    const rawAds = Array.isArray(data) ? data : [];
    // Este actor no expone un límite de resultados en su input — lo topamos aquí para
    // controlar el costo y el tamaño de la respuesta. Ojo: Apify puede seguir cobrando
    // por todo lo que el actor haya scrapeado antes de este corte, no solo lo que regresamos.
    const ads = rawAds.slice(0, safeMax).map(normalizeAd);

    res.status(200).json({ ads });
  } catch (err) {
    res.status(500).json({ error: `No se pudo conectar con Apify: ${err.message}` });
  }
};
