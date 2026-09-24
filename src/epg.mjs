import { createHash } from 'node:crypto';
import { SaxesParser } from 'saxes';

const DAY_MS = 86400000;
const MAX_XML_BYTES = 64 * 1024 * 1024;
const MAX_PROGRAMMES = 100000;
const MAX_SCANNED_PROGRAMMES = 1000000;
const MAX_CHANNELS = 50000;
const MAX_RETAINED_BYTES = 32 * 1024 * 1024;

export class XmltvError extends Error {
  constructor(code = 'INVALID_XML') {
    const messages = {
      INVALID_XML: 'The programme guide is not valid XMLTV.',
      UNSAFE_DTD: 'The programme guide contains an unsupported document type or entity declaration.',
      TOO_LARGE: 'The programme guide exceeds the supported size limit.',
      INVALID_OPTIONS: 'The programme guide settings are invalid.',
    };
    super(messages[code] || messages.INVALID_XML);
    this.name = 'XmltvError';
    this.code = code;
  }
}

function utcTime(year, month, day, hour = 0, minute = 0, second = 0) {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31
    || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  // setUTCFullYear avoids Date.UTC's special treatment of years 00 through 99.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.getTime();
}

function xmltvTime(input) {
  if (typeof input !== 'string') return null;
  // XMLTV specifies UTC when the zone is absent. Incomplete dates cannot
  // describe a reliable schedule slot, so require at least minute precision.
  const match = input.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*(Z|UTC|GMT|[+-]\d{4}))?$/);
  if (!match) return null;
  const local = utcTime(...match.slice(1, 6).map(Number), Number(match[6] || 0));
  if (local === null) return null;
  const zone = match[7];
  if (!zone || zone === 'Z' || zone === 'UTC' || zone === 'GMT') return local;
  const hours = Number(zone.slice(1, 3)), minutes = Number(zone.slice(3, 5));
  if (hours > 23 || minutes > 59) return null;
  const offset = (hours * 60 + minutes) * 60000 * (zone[0] === '+' ? 1 : -1);
  return local - offset;
}

/**
 * Parse schedules only for exact, explicitly allowed live-channel tvg-id values.
 * Keeps programmes overlapping whole UTC days from today-pastDays through
 * today+futureDays inclusive. Missing/invalid stop times are never invented.
 */
export function parseXmltv(text, {
  channelIds = new Set(), nowMs = Date.now(), pastDays = 1, futureDays = 7,
} = {}) {
  if (typeof text !== 'string') throw new XmltvError();
  if (Buffer.byteLength(text, 'utf8') > MAX_XML_BYTES) throw new XmltvError('TOO_LARGE');
  if (!(channelIds instanceof Set) || channelIds.size > MAX_CHANNELS
    || [...channelIds].some(id => typeof id !== 'string' || !id || id.length > 512)
    || !Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())
    || !Number.isInteger(pastDays) || pastDays < 0 || pastDays > 31
    || !Number.isInteger(futureDays) || futureDays < 0 || futureDays > 31) throw new XmltvError('INVALID_OPTIONS');
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const first = today - pastDays * DAY_MS;
  const last = today + (futureDays + 1) * DAY_MS;
  const programmes = new Map();
  const identities = new Set();
  const stack = [];
  let programme = null;
  let capture = null;
  let count = 0;
  let scanned = 0;
  let retainedBytes = 0;
  let rootSeen = false;
  const parser = new SaxesParser({ xmlns: true });
  const attribute = (tag, name) => tag.attributes[name]?.value;

  parser.on('error', () => { throw new XmltvError(); });
  parser.on('doctype', value => {
    // A normal external XMLTV declaration is metadata only: saxes never
    // resolves it, and this module never fetches DTDs or registers entities.
    // Internal subsets (even empty ones) and every other DTD form are rejected.
    if (!/^\s*tv\s+SYSTEM\s+(?:"[^"<>\[\]]+"|'[^'<>\[\]]+')\s*$/.test(value)) {
      throw new XmltvError('UNSAFE_DTD');
    }
  });
  parser.on('opentag', tag => {
    if (stack.length >= 32) throw new XmltvError('TOO_LARGE');
    stack.push(tag.name);
    const depth = stack.length;
    if (depth === 1) {
      if (tag.name !== 'tv' || tag.uri) throw new XmltvError();
      rootSeen = true;
    }
    if (capture && depth > capture.depth) throw new XmltvError();
    if (tag.name === 'programme') {
      if (depth !== 2 || tag.uri) throw new XmltvError();
      if (++scanned > MAX_SCANNED_PROGRAMMES) throw new XmltvError('TOO_LARGE');
      programme = null;
      const channel = attribute(tag, 'channel');
      if (!channelIds.has(channel)) return;
      const start = xmltvTime(attribute(tag, 'start'));
      const end = xmltvTime(attribute(tag, 'stop'));
      if (start === null || end === null || end <= start || end <= first || start >= last) return;
      programme = { channel, start, end, title: '', overview: '' };
    } else if (programme && depth === 3 && !tag.uri && ['title', 'desc'].includes(tag.name)) {
      const field = tag.name === 'title' ? 'title' : 'overview';
      if (!programme[field]) capture = { field, depth, text: '', limit: field === 'title' ? 2048 : 16384 };
    }
  });
  const onText = value => {
    if (!capture) return;
    if (capture.text.length + value.length > capture.limit) throw new XmltvError('TOO_LARGE');
    capture.text += value;
  };
  parser.on('text', onText);
  parser.on('cdata', onText);
  parser.on('closetag', tag => {
    const depth = stack.length;
    if (capture && depth === capture.depth) {
      programme[capture.field] = capture.text.replace(/\s+/gu, ' ').trim();
      capture = null;
    }
    if (depth === 2 && tag.name === 'programme' && programme) {
      if (programme.title) {
        const { channel, start, end, title, overview } = programme;
        const identity = createHash('sha256').update(JSON.stringify([channel, start, end, title])).digest('hex');
        if (!identities.has(identity)) {
          retainedBytes += 512 + 2 * (channel.length + title.length + overview.length);
          if (count >= MAX_PROGRAMMES || retainedBytes > MAX_RETAINED_BYTES) throw new XmltvError('TOO_LARGE');
          identities.add(identity);
          const startTime = new Date(start).toISOString();
          const item = { title, ...(overview ? { overview } : {}), startTime, endTime: new Date(end).toISOString(), released: startTime };
          if (!programmes.has(channel)) programmes.set(channel, []);
          programmes.get(channel).push(item);
          count++;
        }
      }
      programme = null;
    }
    stack.pop();
  });
  try {
    parser.write(text).close();
    if (!rootSeen) throw new XmltvError();
  } catch (error) {
    // Parser diagnostics can quote private provider data. Never expose them,
    // retain their cause, or return partially parsed programme collections.
    if (error instanceof XmltvError) throw error;
    throw new XmltvError();
  }
  for (const list of programmes.values()) {
    list.sort((a, b) => a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime) || a.title.localeCompare(b.title));
  }
  return { programmes, count };
}

/** Return actual programme intervals overlapping a validated UTC calendar day. */
export function programmesForDay(programmes, date) {
  const match = typeof date === 'string' && date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const start = match ? utcTime(...match.slice(1).map(Number)) : null;
  if (start === null || !Array.isArray(programmes)) throw new XmltvError('INVALID_OPTIONS');
  const end = start + DAY_MS;
  return programmes.filter(programme => {
    const from = Date.parse(programme.startTime), to = Date.parse(programme.endTime);
    return Number.isFinite(from) && Number.isFinite(to) && to > from && from < end && to > start;
  });
}

/** Discover at most five HTTP(S) XMLTV sources from the first M3U header only. */
export function playlistEpgUrls(text, baseUrl) {
  if (typeof text !== 'string') return [];
  const header = text.slice(0, 65536).replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0].trim();
  if (!/^#EXTM3U(?:\s|$)/i.test(header)) return [];
  const urls = new Set();
  const attributes = /(?:^|\s)([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  for (const match of header.matchAll(attributes)) {
    if (!['x-tvg-url', 'url-tvg'].includes(match[1].toLowerCase())) continue;
    for (const value of (match[2] ?? match[3] ?? match[4]).split(',')) {
      if (!value.trim() || value.length > 16384) continue;
      try {
        const url = new URL(value.trim(), baseUrl);
        if (!['http:', 'https:'].includes(url.protocol)) continue;
        url.hash = '';
        urls.add(url.href);
        if (urls.size >= 5) return [...urls];
      } catch { /* Ignore invalid discovery hints; the safe fetcher validates addresses. */ }
    }
  }
  return [...urls];
}
