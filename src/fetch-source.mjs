import { fetchPlaylist } from './fetch-playlist.mjs';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_RECORDS = 100000;
const CONTROL = /[\u0000-\u001f\u007f]/;
const VOD_FILE = /\.(?:mp4|mkv|avi|mov|wmv|webm|mpg|mpeg|m4v|flv|3gp|vob|iso|divx|f4v)(?:$|[/?#])/i;
const VOD_PATH = /(?:^|\/)(?:vods?|movies?|films?|series|episodes?|seasons?|catch-?up|replay|recordings?)(?:\/|\.(?:php|aspx?|json)(?:\/|$)|$)/i;
const VOD_EXTENSION = /^(?:mp4|mkv|avi|mov|wmv|webm|mpg|mpeg|m4v|flv|3gp|vob|iso|divx|f4v)$/i;

export class SourceFetchError extends Error {
  constructor() {
    super('The live playlist could not be downloaded.');
    this.name = 'SourceFetchError';
    this.code = 'FETCH_FAILED';
  }
}

function xtreamSource(source) {
  let url;
  try { url = new URL(source?.url); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || !/\/get\.php$/i.test(url.pathname)) return null;
  const allowed = new Set(['username', 'password', 'type', 'output']);
  for (const key of url.searchParams.keys()) {
    // Unknown filters/selectors must retain the original playlist's exact scope.
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return null;
  }
  const username = url.searchParams.get('username'), password = url.searchParams.get('password');
  if (!username || !password || CONTROL.test(username) || CONTROL.test(password)
    || username.length > 1024 || password.length > 1024) return null;
  const type = url.searchParams.get('type');
  if (type !== null && !/^(?:m3u|m3u_plus)$/i.test(type)) return null;
  const output = url.searchParams.get('output');
  if (output !== null && !/^(?:ts|m3u8)$/i.test(output)) return null;
  return { url, username, password, extension: output?.toLowerCase() || 'ts' };
}

function bodyText(result) {
  const body = typeof result === 'string' || Buffer.isBuffer(result) ? result : result?.text;
  if ((typeof body !== 'string' && !Buffer.isBuffer(body)) || Buffer.byteLength(body) > MAX_BYTES) throw new SourceFetchError();
  return Buffer.isBuffer(body) ? body.toString('utf8') : body;
}

function field(value, limit = 1024) {
  if (typeof value !== 'string' || value.length > limit) return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

function quoted(value) {
  // The M3U parser supports escaped quotes. Backslashes in display metadata
  // cannot be allowed to escape the attribute's closing quote.
  return `"${value.replace(/\\/g, ' ').replace(/"/g, '\\"')}"`;
}

function identifier(value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && /^[1-9]\d{0,14}$/.test(text) ? text : null;
}

function apiUrl(account, action) {
  const url = new URL('player_api.php', account.url);
  url.hash = '';
  url.search = new URLSearchParams({ username: account.username, password: account.password, action }).toString();
  return url.href;
}

function directVodEvidence(value, base) {
  if (typeof value !== 'string' || !value) return false;
  let url;
  try { url = new URL(value, base); } catch { return true; }
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { /* The literal path remains inspectable. */ }
  if (VOD_PATH.test(path) || VOD_FILE.test(path)) return true;
  return [...url.searchParams].some(([key, content]) =>
    /^(?:type|content[_-]?type|content|category|stream[_-]?type|media[_-]?type|action|mode)$/i.test(key)
      && /(?:vod|movie|series|catch-?up|replay|recording)/i.test(content));
}

function synthesize(records, categories, account) {
  const lines = ['#EXTM3U'];
  let bytes = 8;
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.stream_type !== 'live') continue;
    const id = identifier(record.stream_id);
    const name = field(record.name);
    if (!id || !name || VOD_EXTENSION.test(String(record.container_extension || '').trim())
      || directVodEvidence(record.direct_source, account.url)) continue;
    const group = categories.get(String(record.category_id)) || field(record.category_name || record.group_title);
    const rawTvgId = record.epg_channel_id;
    const tvgId = typeof rawTvgId === 'string' && !CONTROL.test(rawTvgId) && !rawTvgId.includes('\\') && rawTvgId.length <= 512 ? rawTvgId : '';
    const logo = field(record.stream_icon, 16384);
    const attributes = [
      'stream-type="live"', `xtream-id="${id}"`, `tvg-id=${quoted(tvgId)}`, `group-title=${quoted(group)}`,
      ...(logo && !/[\s\\|]/.test(logo) ? [`tvg-logo=${quoted(logo)}`] : []),
    ];
    // Keep conflicting provider metadata visible to the existing live-only
    // parser, where explicit VOD evidence wins over this API's live label.
    let invalidMetadata = false;
    for (const [input, output] of [['type', 'type'], ['content_type', 'content-type'], ['media_type', 'media-type']]) {
      if (record[input] !== undefined) {
        if (typeof record[input] !== 'string' || record[input].length > 128) { invalidMetadata = true; break; }
        const value = field(record[input], 128);
        attributes.push(`${output}=${quoted(value || 'unknown')}`);
      }
    }
    if (invalidMetadata) continue;
    const stream = new URL(`live/${encodeURIComponent(account.username)}/${encodeURIComponent(account.password)}/${id}.${account.extension}`, account.url);
    stream.search = ''; stream.hash = '';
    const entry = `#EXTINF:-1 ${attributes.join(' ')},${name}\n${stream.href}`;
    bytes += Buffer.byteLength(entry) + 1;
    if (bytes > MAX_BYTES) throw new SourceFetchError();
    lines.push(entry);
  }
  return { text: lines.join('\n') + '\n', url: account.url.href };
}

/**
 * Prefer the bounded live-only Xtream API for unfiltered account playlists.
 * Other M3U URLs retain their original fetch path. No VOD, series, catch-up,
 * stream, or logo requests are made. The optional fetcher is used by tests.
 */
export async function fetchSource(source, fetcher = fetchPlaylist) {
  const account = xtreamSource(source);
  if (account) {
    try {
      const result = await fetcher({ url: apiUrl(account, 'get_live_streams'), headers: source.headers }, {
        includeFinalUrl: true, maxBytes: MAX_BYTES, timeoutMs: 20000,
      });
      const records = JSON.parse(bodyText(result));
      if (!Array.isArray(records) || records.length > MAX_RECORDS) throw new SourceFetchError();
      const categories = new Map();
      try {
        const categoryResult = await fetcher({ url: apiUrl(account, 'get_live_categories'), headers: source.headers }, {
          includeFinalUrl: true, maxBytes: MAX_BYTES, timeoutMs: 5000,
        });
        const rows = JSON.parse(bodyText(categoryResult));
        if (!Array.isArray(rows) || rows.length > 50000) throw new SourceFetchError();
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue;
          const id = String(row.category_id ?? '');
          const name = field(row.category_name);
          if (id && id.length <= 128 && name) categories.set(id, name);
        }
      } catch {
        // Named group exclusions cannot be enforced without the category map.
        // Preserve that request's original M3U rather than broadening its scope.
        if (source.excludeGroups?.length) throw new SourceFetchError();
      }
      return synthesize(records, categories, account);
    } catch { /* API unsupported/unavailable: try the original bounded M3U once. */ }
  }
  try {
    const result = await fetcher(source, { includeFinalUrl: true, maxBytes: MAX_BYTES, timeoutMs: 20000 });
    const text = bodyText(result);
    return { text, url: typeof result === 'object' && result?.url ? result.url : source.url };
  } catch {
    // Discard all upstream messages/causes, which can contain account URLs.
    throw new SourceFetchError();
  }
}
