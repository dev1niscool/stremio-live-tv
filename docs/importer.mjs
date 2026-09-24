// Pure local text parsing. This module never fetches, checks, stores or logs URLs.
// A URL-shaped candidate is counted as rejected when it is not a supported list.
// Ordinary prose that contains no URL-shaped candidate is not a rejection.
const MAX_URL_LENGTH = 16384;
const CONTROL = /[\u0000-\u001f\u007f]/;
const STREAM_PATH = /(?:^|\/)(?:live|movie|movies|series|hls|stream|streams)(?:\/|$)/i;
const STREAM_FILE = /(?:^|\/)(?:\d+|index|master|manifest|stream|chunklist(?:_[^/]*)?)\.m3u8$/i;

function unescapeText(text) {
  return text.replace(/\\([/&])/g, '$1')
    .replace(/\\u00(?:26|2f)/gi, (value) => value.slice(-2).toLowerCase() === '26' ? '&' : '/')
    .replace(/&(?:amp|#0*38|#x0*26);/gi, '&')
    .replace(/&(?:quot|#0*34|#x0*22);/gi, '"')
    .replace(/&(?:apos|#0*39|#x0*27);/gi, "'");
}

function trimWrapping(value) {
  let result = value.trim().replace(/^[<"'`]+|[>"'`]+$/g, '');
  // Closing prose/Markdown delimiters are removed only when unmatched in the URL.
  // A literal terminal period/comma/semicolon is ambiguous in pasted prose;
  // encode it (%2E/%2C/%3B) when it is part of an actual credential.
  let previous;
  do {
    previous = result;
    result = result.replace(/[.,;]+$/, '');
    for (const [opening, closing] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (result.endsWith(closing)
        && result.split(closing).length > result.split(opening).length) result = result.slice(0, -1);
    }
    result = result.replace(/[>"'`]+$/, '');
  } while (result !== previous);
  return result;
}

function decoded(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function xtreamAccount(url) {
  if (!/\/get\.php$/i.test(url.pathname)) return null;
  const users = url.searchParams.getAll('username');
  const passwords = url.searchParams.getAll('password');
  if (users.length !== 1 || passwords.length !== 1 || !users[0] || !passwords[0]
      || CONTROL.test(users[0]) || CONTROL.test(passwords[0])) return null;
  const types = url.searchParams.getAll('type');
  if (types.length > 1 || (types.length && !/^m3u(?:_plus)?$/i.test(types[0]))) return null;
  return { username: users[0], password: passwords[0] };
}

function supported(url) {
  if (/\/(?:player_api|xmltv)\.php$/i.test(url.pathname)) return false;
  if (/\/get\.php$/i.test(url.pathname)) return Boolean(xtreamAccount(url));
  const path = decoded(url.pathname);
  // Public channel repositories commonly put .m3u lists in a /streams/ folder.
  // The stronger HLS-stream heuristics therefore apply only to .m3u8 files.
  if (/\.m3u$/i.test(path)) return true;
  return /\.m3u8$/i.test(path) && !STREAM_PATH.test(path) && !STREAM_FILE.test(path);
}

/** Normalize a supported HTTP(S) playlist URL, or return null. No network validation. */
export function normalizePlaylistUrl(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH || CONTROL.test(raw.trim())) return null;
  // Manual URLs are exact input: terminal punctuation may belong to a password.
  const value = unescapeText(raw).trim();
  if (!/^https?:\/\/[^/\s]/i.test(value) || /\s/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.hostname === '.') return null;
  if (!supported(url)) return null;
  url.hash = '';
  // Preserve the original query ordering/encoding: signed list URLs can depend on it.
  return url.href;
}

function canonicalQuery(url, omitted = new Set()) {
  return [...url.searchParams].filter(([key]) => !omitted.has(key.toLowerCase()))
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry[0] < b.entry[0] ? -1 : a.entry[0] > b.entry[0] ? 1 : a.index - b.index)
    .map(({ entry }) => entry);
}

function identityFor(url) {
  const account = xtreamAccount(url);
  if (account) {
    return JSON.stringify(['xtream', url.origin, url.pathname.replace(/get\.php$/i, ''), account.username,
      canonicalQuery(url, new Set(['username', 'password', 'type', 'output']))]);
  }
  // A generic token may distinguish separate lists, so generic identities retain
  // the full URL query. Only known Xtream account identities ignore passwords.
  return JSON.stringify(['playlist', url.origin, url.username, url.password, url.pathname, canonicalQuery(url)]);
}

function opaqueId(value) {
  // Four independently mixed 32-bit words provide a compact deterministic routing
  // identifier in browsers and Node. This hash is not a credential protection API.
  let a = 0x9e3779b9;
  let b = 0x85ebca6b;
  let c = 0xc2b2ae35;
  let d = 0x27d4eb2f;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    a = Math.imul(a ^ code, 0x85ebca6b);
    b = Math.imul(b ^ code, 0xc2b2ae35);
    c = Math.imul(c ^ code, 0x27d4eb2f);
    d = Math.imul(d ^ code, 0x165667b1);
    a ^= a >>> 13; b ^= b >>> 15; c ^= c >>> 16; d ^= d >>> 13;
  }
  return `pl_${[a, b, c, d].map((word) => (word >>> 0).toString(16).padStart(8, '0')).join('')}`;
}

/**
 * Build a config-ready source or return null. Xtream names default to the exact
 * decoded username, preserving spelling and case; generic lists use hostname.
 * An explicit nonempty nameOverride replaces either default.
 */
export function sourceFromUrl(raw, nameOverride) {
  const normalized = normalizePlaylistUrl(raw);
  if (!normalized) return null;
  const url = new URL(normalized);
  const account = xtreamAccount(url);
  const username = url.searchParams.get('username');
  if (username && CONTROL.test(username)) return null;
  let name = account?.username || username || url.hostname;
  if (nameOverride !== undefined) {
    if (typeof nameOverride !== 'string' || CONTROL.test(nameOverride)) return null;
    if (nameOverride.trim()) name = nameOverride.trim();
  }
  const source = { id: opaqueId(identityFor(url)), name, url: normalized };
  if (account) {
    const epg = new URL(url.href);
    epg.pathname = epg.pathname.replace(/get\.php$/i, 'xmltv.php');
    epg.search = '';
    epg.searchParams.set('username', account.username);
    epg.searchParams.set('password', account.password);
    source.epgUrl = epg.href;
  }
  return source;
}

/**
 * Extract supported playlist URLs from pasted text, local .txt contents,
 * Markdown links or escaped log snippets. No provider requests are made.
 * Repeated Xtream accounts ignore type/output/password differences, retaining
 * the first URL; selectors such as category_id preserve distinct playlists.
 * Generic URLs deduplicate query order/encoding equivalents, not different tokens.
 */
export function extractPlaylists(text) {
  const result = { sources: [], rejectedCount: 0, duplicateCount: 0 };
  if (typeof text !== 'string' || !text.trim()) return result;
  const input = unescapeText(text).replace(/([,;])(?=[a-z][a-z\d+.-]*:\/\/)/gi, '$1 ');
  const seen = new Set();
  const candidatePattern = /\b[a-z][a-z\d+.-]{1,20}:\/{1,2}[^\s<>"'`]+/gi;
  for (const match of input.matchAll(candidatePattern)) {
    const normalized = normalizePlaylistUrl(trimWrapping(match[0]));
    if (!normalized) { result.rejectedCount += 1; continue; }
    const url = new URL(normalized);
    const label = input.slice(Math.max(0, match.index - 200), match.index)
      .match(/\[([^\]\n]{1,160})\]\(\s*<?$/)?.[1];
    // A descriptive Markdown label is useful for generic files, while an account
    // playlist keeps the user's exact username as requested.
    const source = sourceFromUrl(normalized, url.searchParams.get('username') ? undefined : label);
    if (!source) { result.rejectedCount += 1; continue; }
    const identity = identityFor(url);
    if (seen.has(identity)) { result.duplicateCount += 1; continue; }
    seen.add(identity);
    result.sources.push(source);
  }
  return result;
}
