// lib/socialCreators.js
// Capa compartida: llamadas a Scrape Creators (IG/TikTok/FB), normalización a un
// shape común, y helpers de almacenamiento en Upstash/Vercel KV (vía REST API).
// La usan api/social-search.js, api/social-analyze.js, api/social-history.js
// y api/cron-social-snapshot.js para no duplicar lógica.

const SC_BASE = 'https://api.scrapecreators.com';

function scHeaders() {
  const key = process.env.SCRAPE_CREATORS_API_KEY;
  if (!key) throw new Error('Falta configurar SCRAPE_CREATORS_API_KEY en las variables de entorno del proyecto en Vercel.');
  return { 'x-api-key': key };
}

async function scGet(path, params) {
  const url = new URL(SC_BASE + path);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString(), { headers: scHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `Error ${res.status} de Scrape Creators`;
    throw new Error(msg);
  }
  return data;
}

// ---------- Instagram ----------
// v1/instagram/profile trae perfil + hasta ~12 posts recientes en un solo request
// (1 crédito), así que lo usamos como fuente única para snapshot + contenido.
async function fetchInstagram(handle) {
  const data = await scGet('/v1/instagram/profile', { handle });
  const user = data && data.data && data.data.user;
  if (!user) throw new Error(`No se encontró el perfil de Instagram @${handle}.`);

  const edges = (user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.edges) || [];
  const posts = edges.map(({ node }) => ({
    id: node.id,
    url: `https://www.instagram.com/p/${node.shortcode}/`,
    caption: (node.edge_media_to_caption && node.edge_media_to_caption.edges[0] && node.edge_media_to_caption.edges[0].node.text) || '',
    thumbnail: node.display_url || node.thumbnail_src || null,
    isVideo: !!node.is_video,
    views: node.video_view_count || null,
    likes: (node.edge_liked_by && node.edge_liked_by.count) ?? (node.edge_media_preview_like && node.edge_media_preview_like.count) ?? null,
    comments: (node.edge_media_to_comment && node.edge_media_to_comment.count) || null,
    publishedAt: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : null
  }));

  return {
    platform: 'instagram',
    handle: user.username || handle,
    name: user.full_name || user.username || handle,
    avatar: user.profile_pic_url_hd || user.profile_pic_url || null,
    bio: user.biography || '',
    followers: (user.edge_followed_by && user.edge_followed_by.count) || 0,
    following: (user.edge_follow && user.edge_follow.count) || 0,
    postsCount: (user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.count) || 0,
    isVerified: !!user.is_verified,
    profileUrl: `https://www.instagram.com/${user.username || handle}/`,
    posts
  };
}

// ---------- TikTok ----------
async function fetchTikTok(handle) {
  const profileData = await scGet('/v1/tiktok/profile', { handle });
  const user = profileData && profileData.user;
  const stats = profileData && profileData.stats;
  if (!user || !stats) throw new Error(`No se encontró el perfil de TikTok @${handle}.`);

  let videos = [];
  try {
    const videoData = await scGet('/v3/tiktok/profile/videos', { handle, sort_by: 'latest', trim: 'true' });
    const list = (videoData && videoData.aweme_list) || [];
    videos = list.slice(0, 12).map(v => ({
      id: v.aweme_id,
      url: v.url || (v.share_url ? v.share_url.split('?')[0] : `https://www.tiktok.com/@${handle}/video/${v.aweme_id}`),
      caption: v.desc || '',
      thumbnail: (v.video && v.video.dynamic_cover && v.video.dynamic_cover.url_list && v.video.dynamic_cover.url_list[0]) || null,
      isVideo: true,
      views: (v.statistics && v.statistics.play_count) || null,
      likes: (v.statistics && v.statistics.digg_count) || null,
      comments: (v.statistics && v.statistics.comment_count) || null,
      shares: (v.statistics && v.statistics.share_count) || null,
      publishedAt: v.create_time ? new Date(v.create_time * 1000).toISOString() : null
    }));
  } catch (e) {
    // Si falla el listado de videos, seguimos con solo el perfil.
  }

  return {
    platform: 'tiktok',
    handle: user.uniqueId || handle,
    name: user.nickname || user.uniqueId || handle,
    avatar: user.avatarLarger || user.avatarMedium || null,
    bio: user.signature || '',
    followers: stats.followerCount || 0,
    following: stats.followingCount || 0,
    postsCount: stats.videoCount || 0,
    totalLikes: stats.heartCount || stats.heart || 0,
    isVerified: !!user.verified,
    profileUrl: `https://www.tiktok.com/@${user.uniqueId || handle}`,
    posts: videos
  };
}

// ---------- Facebook ----------
function extractFacebookUrl(input) {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://www.facebook.com/${trimmed.replace(/^\/+/, '')}`;
}

async function fetchFacebook(handleOrUrl) {
  const url = extractFacebookUrl(handleOrUrl);
  const profile = await scGet('/v1/facebook/profile', { url });
  if (!profile || profile.success === false) throw new Error(`No se encontró la página de Facebook: ${handleOrUrl}`);

  let posts = [];
  try {
    const postsData = await scGet('/v1/facebook/profile/posts', profile.id ? { pageId: profile.id } : { url });
    posts = ((postsData && postsData.posts) || []).slice(0, 6).map(p => ({
      id: p.id,
      url: p.permalink || p.url || null,
      caption: p.text || '',
      thumbnail: (p.videoDetails && p.videoDetails.thumbnailUrl) || null,
      isVideo: !!p.videoDetails,
      views: p.videoViewCount || null,
      likes: p.reactionCount || null,
      comments: p.commentCount || null,
      publishedAt: p.publishTime ? new Date(p.publishTime * 1000).toISOString() : null
    }));
  } catch (e) {
    // Si falla el listado de posts, seguimos con solo el perfil.
  }

  return {
    platform: 'facebook',
    handle: profile.url ? profile.url.replace(/^https?:\/\/(www\.)?facebook\.com\//i, '').replace(/\/$/, '') : handleOrUrl,
    name: profile.name || handleOrUrl,
    avatar: profile.profilePicLarge || profile.profilePicMedium || null,
    bio: profile.pageIntro || '',
    followers: profile.followerCount || 0,
    following: null,
    postsCount: null,
    totalLikes: profile.likeCount || 0,
    isVerified: false,
    profileUrl: profile.url || url,
    posts
  };
}

const FETCHERS = { instagram: fetchInstagram, tiktok: fetchTikTok, facebook: fetchFacebook };

async function fetchProfile(platform, handleOrUrl) {
  const fn = FETCHERS[platform];
  if (!fn) throw new Error(`Plataforma no soportada: ${platform}`);
  return fn(handleOrUrl);
}

// ---------- Almacenamiento (Upstash / Vercel KV vía REST API) ----------
// Requiere las variables de entorno KV_REST_API_URL y KV_REST_API_TOKEN
// (se crean automáticamente al conectar un KV/Upstash Redis store en Vercel).
function kvConfigured() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function kvCommand(command) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Falta configurar KV_REST_API_URL / KV_REST_API_TOKEN (conecta un KV Store en Vercel).');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status} de KV storage`);
  return data.result;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function trackedListKey() {
  return 'sc:tracked';
}

function snapshotKey(platform, handle, date) {
  return `sc:snapshot:${platform}:${handle.toLowerCase()}:${date}`;
}

function snapshotPrefix(platform, handle) {
  return `sc:snapshot:${platform}:${handle.toLowerCase()}:`;
}

// Guarda el snapshot del día para un perfil y lo registra en la lista de seguimiento
// (la lista de seguimiento es lo que usa el cron para saber a quién volver a consultar).
async function saveSnapshot(profile, label) {
  const date = todayISO();
  const snapshot = {
    date,
    followers: profile.followers,
    following: profile.following,
    postsCount: profile.postsCount,
    totalLikes: profile.totalLikes || null,
    topPosts: (profile.posts || []).slice(0, 5).map(p => ({ id: p.id, views: p.views, likes: p.likes, comments: p.comments }))
  };
  await kvCommand(['SET', snapshotKey(profile.platform, profile.handle, date), JSON.stringify(snapshot)]);

  // Registrar en la lista de tracked (para el cron). Idempotente: se guarda como
  // un objeto por platform:handle dentro de un hash.
  const trackKey = `${profile.platform}:${profile.handle.toLowerCase()}`;
  await kvCommand(['HSET', trackedListKey(), trackKey, JSON.stringify({
    platform: profile.platform,
    handle: profile.handle,
    label: label || profile.name || profile.handle,
    lastSnapshot: date
  })]);

  return snapshot;
}

async function getHistory(platform, handle, limit = 90) {
  const prefix = snapshotPrefix(platform, handle);
  const keys = await kvCommand(['KEYS', `${prefix}*`]);
  if (!Array.isArray(keys) || keys.length === 0) return [];
  const sortedKeys = keys.sort().slice(-limit); // las keys incluyen la fecha, así que el orden alfabético = cronológico
  const values = await kvCommand(['MGET', ...sortedKeys]);
  return values
    .map(v => { try { return JSON.parse(v); } catch (e) { return null; } })
    .filter(Boolean);
}

async function getTrackedList() {
  const all = await kvCommand(['HGETALL', trackedListKey()]);
  // HGETALL vía REST regresa un array plano [k1, v1, k2, v2, ...]
  const list = [];
  if (Array.isArray(all)) {
    for (let i = 0; i < all.length; i += 2) {
      try { list.push(JSON.parse(all[i + 1])); } catch (e) { /* skip */ }
    }
  }
  return list;
}

module.exports = {
  fetchProfile,
  kvConfigured,
  saveSnapshot,
  getHistory,
  getTrackedList,
  todayISO
};
