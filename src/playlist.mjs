import { createHash } from 'node:crypto';

// A playlist is not proof that a stream is live. Reject on-demand evidence first,
// then require an affirmative signal. Duration -1/0, tvg-id, and .m3u8/.ts alone
// are not affirmative signals. An exact includeGroups match is the owner's
// confirmation that a group contains live channels; negative evidence still wins.
const VOD_GROUP = /(?:^|[^\p{L}\p{N}])(?:vods?|video\s*on\s*demand|on\s*demand|movies?|films?|cinema|cine|peliculas?|pelis|series?|serials?|seriale|seriados?|episod(?:e|es|ios)|seasons?|temporadas?|box\s*sets?|catch\s*up|replays?|recordings?|фильмы|фильм|сериалы|сериал|кино|filme|filmes|filmi|filmovi|filmy|diziler|dizi)(?=$|[^\p{L}\p{N}])/u;
const VOD_NON_LATIN = /电影|電影|电视剧|電視劇|點播|点播|영화|드라마|افلام|أفلام|مسلسلات|סרטים|סדרות/u;
const LIVE_GROUP = /(?:^|[^\p{L}\p{N}])(?:live|live\s*tv|tv|television|televisao|fernsehen|channels?|canales?|canais|chaines?|news|noticias|nachrichten|sports?|deportes|esportes|radio|ao\s*vivo|en\s*vivo|en\s*directo|canli)(?=$|[^\p{L}\p{N}])/u;
const LIVE_NON_LATIN = /直播|実況|생방송|مباشر|חדשות|новости|прямой\s*эфир/u;
const VOD_PATH = /(?:^|\/)(?:vod|vods|movies?|films?|series|episodes?|seasons?|catchup|catch-up|replay|recordings?)(?:\/|\.(?:php|aspx?|json)(?:\/|$)|$)/i;
const LIVE_PATH = /(?:^|\/)(?:live|livestream|live-stream|linear)(?:\/|$)/i;
const VOD_EXTENSION = /\.(?:mp4|mkv|avi|mov|wmv|webm|mpg|mpeg|m4v|flv|3gp|vob|iso|divx|f4v)(?:$|\/)/i;
const EPISODE_NAME = /(?:^|[^\p{L}\p{N}])(?:s\d{1,3}\s*[-._ ]?\s*e\d{1,4}|\d{1,3}x\d{1,4}|season\s*\d+|episode\s*\d+|ep\.?\s*\d+|temporada\s*\d+|episodio\s*\d+)(?=$|[^\p{L}\p{N}])/u;
const HEADER_NAMES = new Map([
  ['user-agent', 'User-Agent'],
  ['http-user-agent', 'User-Agent'],
  ['referer', 'Referer'],
  ['referrer', 'Referer'],
  ['http-referrer', 'Referer'],
  ['http-referer', 'Referer'],
  ['origin', 'Origin'],
  ['http-origin', 'Origin'],
]);

function clean(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

function normalized(value) {
  return clean(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

function groupKey(value) {
  return clean(value).toLowerCase();
}

function hasVodLabel(value) {
  const label = normalized(value);
  return VOD_GROUP.test(label) || VOD_NON_LATIN.test(label);
}

function hasLiveLabel(value) {
  const label = normalized(value);
  return LIVE_GROUP.test(label) || LIVE_NON_LATIN.test(label);
}

function decoded(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function addHeader(headers, rawName, rawValue) {
  const name = HEADER_NAMES.get(rawName.trim().toLowerCase());
  // Never turn newlines into a different, apparently valid header value.
  if (!name || /[\r\n\u0000]/.test(rawValue) || rawValue.length > 4096) return;
  const value = clean(rawValue);
  if (value) headers[name] = value;
}

function streamUrl(raw, base, headers) {
  const separator = raw.indexOf('|');
  const address = (separator < 0 ? raw : raw.slice(0, separator)).trim();
  if (!address || /[\u0000-\u0020\u007f]/.test(address)) return null;
  let url;
  try { url = new URL(address, base); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
  url.hash = '';
  if (separator >= 0) {
    for (const [key, value] of new URLSearchParams(raw.slice(separator + 1))) {
      addHeader(headers, key, value);
    }
  }
  return url;
}

function imageUrl(raw, base) {
  if (!raw) return '';
  const url = streamUrl(raw, base, {});
  return url?.href ?? '';
}

function parseExtinf(line) {
  const body = line.replace(/^#EXTINF\s*:/i, '').trim();
  let comma = -1;
  let quote = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quote && char === '\\' && body[index + 1] === quote) { index += 1; continue; }
    if (quote) { if (char === quote) quote = ''; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === ',') { comma = index; break; }
  }
  const metadata = comma < 0 ? body : body.slice(0, comma);
  const durationMatch = metadata.match(/^([+-]?\d+(?:\.\d+)?)(?:\s|$)/);
  const duration = durationMatch ? Number(durationMatch[1]) : NaN;
  const attrs = {};
  const attributePattern = /([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s,]+))/g;
  for (const match of metadata.matchAll(attributePattern)) {
    attrs[match[1].toLowerCase()] = clean((match[2] ?? match[3] ?? match[4]).replace(/\\(["'])/g, '$1'));
  }
  return {
    duration,
    attrs,
    name: clean(comma < 0 ? attrs['tvg-name'] : body.slice(comma + 1)) || clean(attrs['tvg-name']),
    group: clean(attrs['group-title'] || attrs['tvg-group'] || attrs.group),
    headers: {},
  };
}

function classify(entry, url, confirmedGroup) {
  const path = decoded(url.pathname);
  const metadataTypes = ['type', 'tvg-type', 'media-type', 'content-type', 'stream-type']
    .map((key) => normalized(entry.attrs[key]));
  const query = [...url.searchParams].map(([key, value]) => [normalized(key), normalized(value)]);
  const vodQuery = query.some(([key, value]) => {
    if (/^(?:vod|movie|series|catchup|catch-up|replay)$/.test(key)) return !/^(?:0|false|no|off)$/.test(value);
    return /^(?:type|content[_-]?type|content|category|stream[_-]?type|media[_-]?type|action|mode)$/.test(key)
      && (hasVodLabel(value.replace(/_/g, ' ')) || /(?:^|_)get_(?:vod|series)|get_(?:vod|series)/.test(value));
  });
  if (entry.duration > 0 || hasVodLabel(entry.group) || metadataTypes.some(hasVodLabel)
      || VOD_PATH.test(path) || VOD_EXTENSION.test(path) || vodQuery
      || EPISODE_NAME.test(normalized(entry.name))) return 'vod';

  // Invalid duration is not trusted, even with an otherwise plausible label.
  if (!Number.isFinite(entry.duration) || entry.duration < -1) return 'unknown';
  const liveQuery = query.some(([key, value]) =>
    /^(?:type|content[_-]?type|stream[_-]?type|media[_-]?type|mode)$/.test(key)
      && /^(?:live|linear|itv|live_tv)$/.test(value));
  const liveMetadata = metadataTypes.some((value) => /^(?:live|linear|itv|live tv|live_tv)$/.test(value));
  if (confirmedGroup || LIVE_PATH.test(path) || liveQuery || liveMetadata || hasLiveLabel(entry.group)) return 'live';
  return 'unknown';
}

/**
 * Parse an extended M3U channel list without fetching any stream or logo.
 *
 * includeGroups/excludeGroups are exact, trimmed, case-insensitive group names.
 * A nonempty includeGroups is both a filter and owner confirmation of live
 * content. Missing groups match the displayed name "Ungrouped". Strong VOD
 * evidence always overrides it. This intentionally hides
 * ambiguous entries, but cannot verify a provider's truthful labeling.
 *
 * IDs with tvg-id are independent of rotating stream URLs: the identity is
 * tvg-id + channel name + group, scoped to source.id. Reused tvg-ids with different
 * names/groups remain distinct. Without tvg-id, the URL is part of the identity.
 * Duplicate identities or duplicate stream URLs keep the first accepted entry.
 */
export function parsePlaylist(text, source) {
  if (typeof text !== 'string') throw new TypeError('Playlist text must be a string');
  if (!source || typeof source.id !== 'string' || !source.id.trim()) throw new TypeError('Source id is required');
  const stats = {
    totalEntries: 0,
    accepted: 0,
    duplicates: 0,
    excludedVod: 0,
    excludedUnknown: 0,
    excludedGroups: 0,
    invalidUrls: 0,
    invalidPlaylist: false,
  };
  const channels = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).map((line) => line.trim());
  // #EXT-X-* denotes an HLS master/media playlist, not an IPTV channel list.
  if (lines.some((line) => /^#EXT-X-/i.test(line))) {
    stats.invalidPlaylist = true;
    return { channels, stats };
  }
  const includes = new Set((source.includeGroups ?? []).map(groupKey).filter(Boolean));
  const excludes = new Set((source.excludeGroups ?? []).map(groupKey).filter(Boolean));
  const identities = new Set();
  const addresses = new Set();
  let pending = null;
  let activeGroup = '';

  function finish(rawUrl) {
    if (!pending) return;
    const entry = pending;
    pending = null;
    if (!rawUrl) { stats.invalidUrls += 1; return; }
    const url = streamUrl(rawUrl, source.url, entry.headers);
    if (!url) { stats.invalidUrls += 1; return; }
    const group = groupKey(entry.group);
    const displayGroup = group || 'ungrouped';
    const confirmedGroup = includes.has(displayGroup);
    const classification = classify(entry, url, confirmedGroup);
    if (classification === 'vod') { stats.excludedVod += 1; return; }
    if (excludes.has(displayGroup) || (includes.size > 0 && !confirmedGroup)) { stats.excludedGroups += 1; return; }
    if (classification !== 'live' || !entry.name) { stats.excludedUnknown += 1; return; }
    const identity = JSON.stringify([
      clean(entry.attrs['tvg-id']), normalized(entry.name), group,
      entry.attrs['tvg-id'] ? '' : url.href,
    ]);
    if (identities.has(identity) || addresses.has(url.href)) { stats.duplicates += 1; return; }
    identities.add(identity);
    addresses.add(url.href);
    const hash = createHash('sha256').update(identity).digest('hex').slice(0, 24);
    channels.push({
      id: `iptv:${source.id}:${hash}`,
      tvgId: clean(entry.attrs['tvg-id']),
      name: entry.name,
      group: entry.group || 'Ungrouped',
      logo: imageUrl(entry.attrs['tvg-logo'], source.url),
      url: url.href,
      headers: entry.headers,
    });
  }

  for (const line of lines) {
    if (!line) continue;
    if (/^#EXTINF\s*:/i.test(line)) {
      if (pending) finish(null);
      stats.totalEntries += 1;
      pending = parseExtinf(line);
      if (!pending.group) pending.group = activeGroup;
    } else if (/^#EXTGRP\s*:/i.test(line)) {
      activeGroup = clean(line.replace(/^#EXTGRP\s*:/i, ''));
      if (pending && !pending.attrs['group-title'] && !pending.attrs['tvg-group'] && !pending.attrs.group) {
        pending.group = activeGroup;
      }
    } else if (/^#EXTVLCOPT\s*:/i.test(line) && pending) {
      const option = line.replace(/^#EXTVLCOPT\s*:/i, '');
      const equal = option.indexOf('=');
      if (equal >= 0) addHeader(pending.headers, option.slice(0, equal), option.slice(equal + 1));
    } else if (!line.startsWith('#') && pending) {
      finish(line);
    }
  }
  if (pending) finish(null);
  stats.accepted = channels.length;
  if (stats.totalEntries === 0) stats.invalidPlaylist = true;
  return { channels, stats };
}
