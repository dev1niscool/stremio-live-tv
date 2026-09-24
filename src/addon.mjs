import { parsePlaylist } from './playlist.mjs';
import { fetchPlaylist } from './fetch-playlist.mjs';

export const TYPE = 'Live TV';
export const PAGE_SIZE = 100;

export function createAddon(config, fetcher = source => fetchPlaylist(source, {includeFinalUrl:true}), now = Date.now) {
  const cache = new Map();
  const pending = new Map();
  const errors = new Map();
  const cacheBudget = 48 * 1024 * 1024;
  let cacheBytes = 0;
  let active = 0;
  const waiting = [];
  const acquire = async () => { if (active >= 2) await new Promise(resolve => waiting.push(resolve)); else active++; };
  const release = () => { const next = waiting.shift(); if (next) next(); else active--; };
  function remember(id, result) {
    // Conservative estimate includes strings, channel objects, headers and map overhead.
    const weight = result.channels.reduce((n, c) => n + 512 + 2 * (c.id.length + c.name.length + c.group.length + c.logo.length + c.url.length + JSON.stringify(c.headers).length), 0);
    if (cache.has(id)) { cacheBytes -= cache.get(id).weight; cache.delete(id); }
    while (cacheBytes + weight > cacheBudget && cache.size) {
      const oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest).weight; cache.delete(oldest);
    }
    if (weight <= cacheBudget) { cache.set(id, {...result, weight}); cacheBytes += weight; }
  }
  async function load(source) {
    const hit = cache.get(source.id);
    if (hit && now() - hit.loadedAt < config.ttlMs) { cache.delete(source.id); cache.set(source.id, hit); return hit; }
    if (pending.has(source.id)) return pending.get(source.id);
    const task = (async () => {
      await acquire();
      try {
        const fetched = await Promise.resolve().then(() => fetcher(source));
        const data = parsePlaylist(typeof fetched === 'string' ? fetched : fetched.text, {...source, url: typeof fetched === 'string' ? source.url : fetched.url});
        if (data.stats.invalidPlaylist) throw new Error('Not a channel playlist.');
        const result = { ...data, loadedAt: now() };
        remember(source.id, result);
        errors.delete(source.id);
        return result;
      } catch {
        errors.set(source.id, 'Could not load this playlist. Check the URL, credentials, provider access and outbound port.');
        throw new Error(errors.get(source.id));
      } finally { pending.delete(source.id); release(); }
    })();
    pending.set(source.id, task);
    return task;
  }
  const preview = channel => ({
    id: channel.id, type: TYPE, name: channel.name, posterShape: 'square',
    ...(channel.logo ? {poster: channel.logo} : {}),
    genres: channel.group ? [channel.group] : [],
    description: `${channel.name}${channel.group ? ` · ${channel.group}` : ''} — Live television`,
    behaviorHints: { defaultVideoId: channel.id, isLive: true }
  });
  return {
    manifest(origin) {
      return {
        id: 'community.stremio.live-tv', version: '1.0.0', name: config.name,
        description: 'Your private M3U playlists. Live channels in Discover, with no Home rows.',
        logo: `${origin}/icon.svg`,
        types: [TYPE],
        resources: ['catalog', {name: 'meta', types: [TYPE], idPrefixes: ['iptv:']}, {name:'stream', types:[TYPE], idPrefixes:['iptv:']}],
        catalogs: config.sources.map(s => ({
          type: TYPE, id: s.id, name: s.name,
          extra: [{ name: 'genre', isRequired: true, options: ['All channels'] }, {name: 'skip'}, {name: 'search'}]
        })),
        behaviorHints: { configurable: true, configurationRequired: false }
      };
    },
    async catalog(id, extra = {}) {
      // Stremio Home requests have no extras. Refuse them even if a client ignores the manifest requirement.
      if (extra.genre !== 'All channels') return { metas: [] };
      const source = config.sources.find(s => s.id === id);
      if (!source) return {metas: []};
      const skip = Number(extra.skip || 0);
      if (!Number.isSafeInteger(skip) || skip < 0) return {metas: []};
      const query = (extra.search || '').trim().toLocaleLowerCase();
      const {channels} = await load(source);
      const matches = query ? channels.filter(c => `${c.name} ${c.group}`.toLocaleLowerCase().includes(query)) : channels;
      return { metas: matches.slice(skip, skip + PAGE_SIZE).map(preview) };
    },
    async channel(id) {
      const source = config.sources.find(s => id.startsWith(`iptv:${s.id}:`));
      if (!source) return undefined;
      return (await load(source)).channels.find(c => c.id === id);
    },
    async meta(id) { const c = await this.channel(id); return {meta: c ? preview(c) : null}; },
    async stream(id) {
      const c = await this.channel(id);
      if (!c) return { streams: [] };
      return {streams: [{name:'Live TV', title:c.name, url:c.url,
        behaviorHints: {notWebReady: true, ...(Object.keys(c.headers || {}).length ? {proxyHeaders:{request:c.headers}} : {})}
      }]};
    },
    async status(sourceId) {
      // Limit concurrent provider requests, including on a large multi-playlist install.
      const results = [];
      const sources = sourceId ? config.sources.filter(s => s.id === sourceId) : config.sources;
      for (let i = 0; i < sources.length; i += 4) {
        results.push(...await Promise.all(sources.slice(i, i + 4).map(async source => {
          try {
            const data = await load(source);
            return {id:source.id, name:source.name, state:'ready', stats:data.stats, updatedAt:new Date(data.loadedAt).toISOString()};
          } catch { return {id:source.id, name:source.name, state:'error', error:errors.get(source.id)}; }
        })));
      }
      return {sources:results};
    },
    refresh() { cache.clear(); cacheBytes = 0; }
  };
}
