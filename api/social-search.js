const { fetchProfile, saveSnapshot, kvConfigured } = require('../lib/socialCreators');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  const { instagram, tiktok, facebook, label } = req.body || {};
  const requests = [];
  if (instagram && instagram.trim()) requests.push(['instagram', instagram.trim().replace(/^@/, '')]);
  if (tiktok && tiktok.trim()) requests.push(['tiktok', tiktok.trim().replace(/^@/, '')]);
  if (facebook && facebook.trim()) requests.push(['facebook', facebook.trim()]);

  if (requests.length === 0) {
    res.status(400).json({ error: 'Escribe al menos un usuario/URL de Instagram, TikTok o Facebook.' });
    return;
  }

  const results = await Promise.allSettled(requests.map(([platform, handle]) => fetchProfile(platform, handle)));

  const profiles = [];
  const errors = [];
  results.forEach((r, i) => {
    const [platform] = requests[i];
    if (r.status === 'fulfilled') {
      profiles.push(r.value);
    } else {
      errors.push({ platform, error: r.reason.message || String(r.reason) });
    }
  });

  if (profiles.length === 0) {
    res.status(502).json({ error: 'No se pudo obtener ningún perfil.', details: errors });
    return;
  }

  // Guardar snapshot del día para el historial de crecimiento (si el KV store está
  // configurado). Si no lo está, seguimos funcionando en modo "solo snapshot actual".
  let saved = false;
  if (kvConfigured()) {
    try {
      await Promise.all(profiles.map(p => saveSnapshot(p, label)));
      saved = true;
    } catch (e) {
      errors.push({ platform: 'storage', error: e.message });
    }
  }

  res.status(200).json({ profiles, errors: errors.length ? errors : undefined, saved });
};
