const { fetchProfile, saveSnapshot, getTrackedList, kvConfigured } = require('../lib/socialCreators');

// Vercel llama a este endpoint automáticamente según el schedule definido en
// vercel.json ("crons"). Si configuras CRON_SECRET en las variables de entorno,
// Vercel lo manda como header Authorization: Bearer <CRON_SECRET> — lo validamos
// para que nadie más pueda disparar este endpoint (y gastar tus créditos) a mano.
module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'No autorizado' });
      return;
    }
  }

  if (!kvConfigured()) {
    res.status(200).json({ skipped: true, reason: 'KV storage no configurado.' });
    return;
  }

  let tracked;
  try {
    tracked = await getTrackedList();
  } catch (e) {
    res.status(500).json({ error: `No se pudo leer la lista de seguimiento: ${e.message}` });
    return;
  }

  if (!tracked.length) {
    res.status(200).json({ processed: 0, message: 'No hay perfiles en seguimiento todavía.' });
    return;
  }

  const results = await Promise.allSettled(
    tracked.map(async t => {
      const profile = await fetchProfile(t.platform, t.handle);
      await saveSnapshot(profile, t.label);
      return { platform: t.platform, handle: t.handle };
    })
  );

  const ok = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  const failed = results
    .map((r, i) => (r.status === 'rejected' ? { platform: tracked[i].platform, handle: tracked[i].handle, error: r.reason.message } : null))
    .filter(Boolean);

  res.status(200).json({ processed: ok.length, failed });
};
