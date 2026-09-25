import { parsePlaylist } from './playlist.mjs';
import { fetchPlaylist } from './fetch-playlist.mjs';
import { fetchSource } from './fetch-source.mjs';
import { parseXmltv, programmesForDay } from './epg.mjs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { isNflChannel } from './nfl.mjs';
import { streamChoices } from './streams.mjs';

export const TYPE = 'Live TV';
export const NATIVE_TYPE = 'tv';
export const PAGE_SIZE = 100;

const profiles = {
  full: {idPrefix:'iptv:',catalogPrefix:'',accept:() => true},
  nfl: {idPrefix:'iptv-nfl:',catalogPrefix:'nfl:',accept:isNflChannel}
};
function profileSettings(profile) {
  if (!Object.hasOwn(profiles,profile)) throw new Error('Unknown channel profile.');
  return profiles[profile];
}
const projectChannel = (channel, profile) => profile === 'full' ? channel
  : {...channel,id:`${profileSettings(profile).idPrefix}${channel.id.slice('iptv:'.length)}`};

export function createAddon(config, fetcher = fetchSource, now = Date.now,
  guideFetcher = source => fetchPlaylist(source, {asBuffer:true})) {
  const cache = new Map();
  const pending = new Map();
  const errors = new Map();
  const guides = new Map();
  const guidePending = new Map();
  let guideBytes = 0;
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
  async function loadGuide(source, channels) {
    if (!source.epgUrl) return {programmes:new Map(),count:0,state:'not_configured'};
    const hit = guides.get(source.id);
    if (hit && now() - hit.loadedAt < (hit.state === 'error' ? 60000 : 15 * 60000)) return hit;
    if (guidePending.has(source.id)) return guidePending.get(source.id);
    const task = (async () => {
      await acquire();
      let result;
      try {
        const sameOrigin = new URL(source.epgUrl).origin === new URL(source.url).origin;
        const headers = Object.fromEntries(Object.entries(source.headers || {}).filter(([k]) => sameOrigin || ['user-agent','accept'].includes(k.toLowerCase())));
        let body = await guideFetcher({url:source.epgUrl,headers});
        if (Buffer.isBuffer(body)) {
          if (body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body,{maxOutputLength:25 * 1024 * 1024});
          body = body.toString('utf8');
        }
        const parsed = parseXmltv(body,{channelIds:new Set(channels.map(c => c.tvgId).filter(Boolean)),nowMs:now()});
        result = {...parsed,state:parsed.count ? 'ready' : 'empty',loadedAt:now()};
      } catch { result = {programmes:new Map(),count:0,state:'error',loadedAt:now()}; }
      finally { release(); guidePending.delete(source.id); }
      const weight = [...result.programmes.values()].flat().reduce((n,p) => n + 512 + 2 * (p.title.length + (p.overview || '').length), 0);
      if (guides.has(source.id)) { guideBytes -= guides.get(source.id).weight; guides.delete(source.id); }
      while (guideBytes + weight > cacheBudget && guides.size) {
        const id = guides.keys().next().value; guideBytes -= guides.get(id).weight; guides.delete(id);
      }
      if (weight <= cacheBudget) { guides.set(source.id,{...result,weight}); guideBytes += weight; }
      return result;
    })();
    guidePending.set(source.id,task);
    return task;
  }
  const preview = (channel, type = TYPE) => ({
    id: channel.id, type, name: channel.name, posterShape: 'square',
    ...(channel.logo ? {poster: channel.logo} : {}),
    genres: channel.group ? [channel.group] : [],
    description: `${channel.name}${channel.group ? ` · ${channel.group}` : ''} — Live television`,
    behaviorHints: { defaultVideoId: channel.id, isLive: true }
  });
  const detailed = (channel, guide, date) => {
    let programmes = guide.programmes.get(channel.tvgId) || [];
    if (date) programmes = programmesForDay(programmes,date);
    return {...preview(channel,NATIVE_TYPE),behaviorHints:{isLive:true,defaultVideoId:channel.id,hasScheduledVideos:true},
      videos:programmes.map(p => ({...p,id:`${channel.id}:epg:${createHash('sha256').update(JSON.stringify([p.startTime,p.endTime,p.title])).digest('hex').slice(0,24)}`}))};
  };
  return {
    manifest(origin, profile = 'full') {
      const {idPrefix,catalogPrefix} = profileSettings(profile);
      const types = config.sources.some(s => s.epgUrl) ? [TYPE,NATIVE_TYPE] : [TYPE];
      return {
        id: `community.stremio.live-tv${profile === 'nfl' ? '.nfl' : ''}`, version: '1.3.0', name: `${config.name}${profile === 'nfl' ? ' — NFL' : ''}`,
        description: profile === 'nfl'
          ? 'Private NFL live channels, Game Pass, RedZone and Sunday Ticket in Discover. No VOD.'
          : 'Private live channels in Discover. Classic channel lists plus native programme guides when XMLTV is available.',
        logo: `${origin}/icon.svg`,
        types,
        resources: ['catalog', {name: 'meta', types, idPrefixes: [idPrefix]}, {name:'stream', types, idPrefixes:[idPrefix]}],
        catalogs: [...config.sources.map(s => ({
          type: TYPE, id: `${catalogPrefix}${s.id}`, name: s.name,
          extra: [{ name: 'genre', isRequired: true, options: ['All channels'] }, {name: 'skip'}, {name: 'search'}]
        })), ...config.sources.filter(s => s.epgUrl).map(s => ({
          type:NATIVE_TYPE,id:`guide:${catalogPrefix}${s.id}`,name:s.name,
          extra:[{name:'genre',isRequired:true,options:['All channels']},{name:'skip'},{name:'date'}]
        }))],
        behaviorHints: { configurable: true, configurationRequired: false, ...(config.sources.some(s => s.epgUrl) ? {epgProvider:true} : {}) }
      };
    },
    async catalog(id, extra = {}, type = TYPE, profile = 'full') {
      const {catalogPrefix,accept} = profileSettings(profile);
      // Stremio Home requests have no extras. Refuse them even if a client ignores the manifest requirement.
      const native = type === NATIVE_TYPE;
      const date = native && extra.date;
      const empty = () => date ? {metasDetailed:[]} : {metas:[]};
      if (extra.genre !== 'All channels' && !date) return empty();
      if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date)) return empty();
      const source = config.sources.find(s => `${native ? 'guide:' : ''}${catalogPrefix}${s.id}` === id && (!native || s.epgUrl));
      if (!source) return empty();
      const skip = Number(extra.skip || 0);
      if (!Number.isSafeInteger(skip) || skip < 0) return empty();
      const query = (extra.search || '').trim().toLocaleLowerCase();
      const {channels} = await load(source);
      // Filter only parsed live channels, before search and pagination; never change the shared cache.
      const matches = channels.filter(c => accept(c) && (!query || `${c.name} ${c.group}`.toLocaleLowerCase().includes(query)));
      const page = matches.slice(skip, skip + PAGE_SIZE).map(c => projectChannel(c,profile));
      if (date) {
        if (!page.length) return empty();
        // Guide cache is shared: retain the full live-channel allowlist even for an NFL request.
        const guide = await loadGuide(source,channels);
        return {metasDetailed:page.map(c => detailed(c,guide,date))};
      }
      return { metas: page.map(c => preview(c,type)) };
    },
    async channel(id, profile = 'full') {
      const {idPrefix,accept} = profileSettings(profile);
      const source = config.sources.find(s => id.startsWith(`${idPrefix}${s.id}:`));
      if (!source) return undefined;
      const canonicalId = `iptv:${id.slice(idPrefix.length)}`;
      const channel = (await load(source)).channels.find(c => c.id === canonicalId && accept(c));
      return channel && projectChannel(channel,profile);
    },
    async meta(id, type = TYPE, profile = 'full') {
      const c = await this.channel(id,profile);
      if (!c) return {meta:null};
      if (type === NATIVE_TYPE) {
        const source = config.sources.find(s => id.startsWith(`${profileSettings(profile).idPrefix}${s.id}:`));
        if (source.epgUrl) return {meta:detailed(c,await loadGuide(source,(await load(source)).channels))};
      }
      return {meta:preview(c,type)};
    },
    async stream(id, type = TYPE, profile = 'full') {
      const c = await this.channel(id,profile);
      if (!c) return { streams: [] };
      const source = config.sources.find(s => id.startsWith(`${profileSettings(profile).idPrefix}${s.id}:`));
      return {streams:streamChoices(c,source,{name:profile === 'nfl' ? 'NFL' : 'Live TV'})};
    },
    async status(sourceId) {
      // Limit concurrent provider requests, including on a large multi-playlist install.
      const results = [];
      const sources = sourceId ? config.sources.filter(s => s.id === sourceId) : config.sources;
      for (let i = 0; i < sources.length; i += 4) {
        results.push(...await Promise.all(sources.slice(i, i + 4).map(async source => {
          try {
            const data = await load(source);
            const guide = await loadGuide(source,data.channels);
            return {id:source.id, name:source.name, state:'ready', stats:data.stats, updatedAt:new Date(data.loadedAt).toISOString(),
              guide:{state:guide.state,programmes:guide.count,matchedChannels:guide.programmes.size}};
          } catch { return {id:source.id, name:source.name, state:'error', error:errors.get(source.id)}; }
        })));
      }
      return {sources:results};
    },
    refresh() { cache.clear(); cacheBytes = 0; guides.clear(); guideBytes = 0; }
  };
}
