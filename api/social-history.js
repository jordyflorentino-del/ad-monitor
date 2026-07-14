const { getHistory, kvConfigured } = require('../lib/socialCreators');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }

  if (!kvConfigured()) {
    res.status(200).json({ history: [], storageConfigured: false });
    return;
  }

  const { platform, handle } = req.query || {};
  if (!platform || !handle) {
    res.status(400).json({ error: 'Faltan los parámetros platform y handle.' });
    return;
  }

  try {
    const history = await getHistory(platform, handle);
    res.status(200).json({ history, storageConfigured: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
