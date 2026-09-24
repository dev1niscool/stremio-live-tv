import { createHash } from 'node:crypto';

export function readConfig(env = process.env) {
  let input;
  try { input = JSON.parse(env.PLAYLISTS_JSON || '[]'); }
  catch { throw new Error('PLAYLISTS_JSON must be a JSON array.'); }
  if (!Array.isArray(input) || input.length > 50) throw new Error('Configure an array of at most 50 playlists.');
  const ids = new Set();
  const sources = input.map((item, i) => {
    const fail = (message) => { throw new Error(`Playlist ${i + 1}: ${message}`); };
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('expected an object.');
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80) fail('name must contain 1–80 characters.');
    let url;
    try { url = new URL(item.url); } catch { fail('enter a complete HTTP or HTTPS M3U URL.'); }
    if (!['http:', 'https:'].includes(url.protocol)) fail('only HTTP and HTTPS URLs are supported.');
    const id = item.id || createHash('sha256').update(item.name.trim()).digest('hex').slice(0, 12);
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ids.has(id)) fail('id must be unique and use letters, numbers, dashes or underscores.');
    ids.add(id);
    const groups = (key) => {
      const value = item[key] || [];
      if (!Array.isArray(value) || value.length > 500 || value.some(g => typeof g !== 'string' || !g.trim() || g.length > 200)) fail(`${key} must be an array of group names.`);
      return value.map(g => g.trim());
    };
    const headers = item.headers || {};
    if (typeof headers !== 'object' || Array.isArray(headers) || Object.entries(headers).some(([k,v]) => !['user-agent','referer','authorization','accept'].includes(k.toLowerCase()) || typeof v !== 'string' || /[\r\n]/.test(v))) fail('headers may only contain User-Agent, Referer, Authorization and Accept text values.');
    return { id, name: item.name.trim(), url: url.href, includeGroups: groups('includeGroups'), excludeGroups: groups('excludeGroups'), headers };
  });
  const token = env.ADDON_TOKEN || '';
  if (token && !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('ADDON_TOKEN must be 32–256 URL-safe characters.');
  if (sources.length && !token) throw new Error('Set ADDON_TOKEN before adding playlists.');
  let publicUrl = env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || (env.SPACE_HOST ? `https://${env.SPACE_HOST}` : '');
  if (publicUrl) {
    const u = new URL(publicUrl);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('PUBLIC_URL must be an HTTP(S) origin without a path or credentials.');
    publicUrl = u.origin;
  }
  const ttl = Number(env.CACHE_TTL_SECONDS || 900);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) throw new Error('CACHE_TTL_SECONDS must be between 60 and 86400.');
  const port = Number(env.PORT || 7860);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  return { sources, token, publicUrl, ttlMs: ttl * 1000, port, name: 'Stremio Live TV' };
}
