import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

const MESSAGES = {
  INVALID_SOURCE: 'The playlist URL or request headers are invalid.',
  BLOCKED_ADDRESS: 'Playlist URLs must resolve only to public internet addresses.',
  FETCH_FAILED: 'The playlist could not be downloaded.',
  HTTP_ERROR: 'The playlist server returned an unsuccessful response.',
  INSECURE_REDIRECT: 'The playlist server attempted an insecure redirect.',
  TOO_MANY_REDIRECTS: 'The playlist server redirected too many times.',
  TOO_LARGE: 'The playlist exceeds the download size limit.',
  TIMEOUT: 'The playlist download timed out.',
  UNSUPPORTED_ENCODING: 'The playlist server used an unsupported content encoding.',
};

export class FetchPlaylistError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.FETCH_FAILED);
    this.name = 'FetchPlaylistError';
    this.code = code;
  }
}

function fail(code) {
  return new FetchPlaylistError(code);
}

function publicIPv4(address) {
  const octets = address.split('.').map(Number);
  const [a, b, c] = octets;
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113));
}

function ipv6Words(address) {
  // Normalize dotted tails before expanding compressed IPv6 words.
  const normalized = address.replace(/(\d+\.\d+\.\d+\.\d+)$/, (tail) => {
    const [a, b, c, d] = tail.split('.').map(Number);
    return `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  });
  const halves = normalized.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return words.map((word) => Number.parseInt(word, 16));
}

/** Conservative global-unicast check, including IPv4-mapped IPv6 addresses. */
export function isPublicAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const version = isIP(address);
  if (version === 4) return publicIPv4(address);
  if (version !== 6) return false;
  const words = ipv6Words(address);
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return publicIPv4(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  }
  // Only native global unicast is accepted. This excludes local, multicast,
  // NAT64, compatible IPv4, and other special-purpose address mechanisms.
  if ((words[0] & 0xe000) !== 0x2000) return false;
  if (words[0] === 0x2001 && words[1] <= 0x01ff) return false;
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false;
  if (words[0] === 0x2002) return false; // 6to4 can embed private IPv4.
  if (words[0] === 0x3fff && words[1] <= 0x0fff) return false;
  return true;
}

function parseUrl(value, base) {
  if (typeof value !== 'string' || value.length > 16384) throw fail('INVALID_SOURCE');
  let url;
  try { url = new URL(value, base); } catch { throw fail('INVALID_SOURCE'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw fail('INVALID_SOURCE');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname.endsWith('.local') || hostname === 'metadata.google.internal') {
    throw fail('BLOCKED_ADDRESS');
  }
  return url;
}

function prepareHeaders(input) {
  const headers = {
    'user-agent': 'Stremio-Live-TV/1.0',
    accept: 'application/vnd.apple.mpegurl, audio/mpegurl, text/plain, */*',
    'accept-encoding': 'gzip, deflate, br',
  };
  if (input === undefined) return headers;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('INVALID_SOURCE');
  const allowed = new Set(['user-agent', 'referer', 'authorization', 'accept', 'accept-language']);
  for (const [key, value] of Object.entries(input)) {
    const name = key.toLowerCase();
    if (!allowed.has(name) || typeof value !== 'string' || value.length > 8192
      || /[\x00-\x1f\x7f]/.test(value)) throw fail('INVALID_SOURCE');
    headers[name] = value;
  }
  return headers;
}

function untilAborted(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

async function publicEndpoint(url, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await untilAborted(dns.lookup(hostname, { all: true, verbatim: true }), signal);
  // Reject mixed public/private DNS answers, not just the selected address.
  if (!addresses.length || addresses.some(({ address, family }) =>
    !isPublicAddress(address) || family !== isIP(address))) throw fail('BLOCKED_ADDRESS');
  return addresses.find(({ family }) => family === 4) || addresses[0];
}

async function request(url, headers, signal) {
  const endpoint = await publicEndpoint(url, signal);
  signal.throwIfAborted();
  const options = {
    protocol: url.protocol,
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers,
    agent: false,
    signal,
    family: endpoint.family,
    autoSelectFamily: false,
    // Pin the validated result: the HTTP transport must never resolve it again.
    lookup(_hostname, lookupOptions, callback) {
      if (lookupOptions.all) callback(null, [endpoint]);
      else callback(null, endpoint.address, endpoint.family);
    },
  };
  if (url.username || url.password) {
    try { options.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`; }
    catch { throw fail('INVALID_SOURCE'); }
  }
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(options, resolve);
    req.once('error', reject);
    req.end();
  });
}

async function readBody(response, maxBytes, signal) {
  const contentLength = response.headers['content-length'];
  if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    response.destroy();
    throw fail('TOO_LARGE');
  }
  const encoding = String(response.headers['content-encoding'] || 'identity').trim().toLowerCase();
  const decoders = { gzip: createGunzip, 'x-gzip': createGunzip, deflate: createInflate, br: createBrotliDecompress };
  if (encoding !== 'identity' && !Object.hasOwn(decoders, encoding)) {
    response.destroy();
    throw fail('UNSUPPORTED_ENCODING');
  }
  let transferred = 0;
  let decoded = 0;
  const chunks = [];
  const limitInput = new Transform({
    transform(chunk, _encoding, callback) {
      transferred += chunk.length;
      callback(transferred > maxBytes ? fail('TOO_LARGE') : null, chunk);
    },
  });
  const collect = new Writable({
    write(chunk, _encoding, callback) {
      decoded += chunk.length;
      if (decoded > maxBytes) return callback(fail('TOO_LARGE'));
      chunks.push(chunk);
      callback();
    },
  });
  const streams = [response, limitInput];
  if (encoding !== 'identity') streams.push(decoders[encoding]());
  streams.push(collect);
  await pipeline(streams, { signal });
  return Buffer.concat(chunks, decoded);
}

/**
 * Download a playlist without exposing URLs, credentials, or response bodies in errors.
 * includeFinalUrl returns { text, url } for resolving relative playlist entries;
 * this successful result contains a sensitive URL and must not be logged.
 */
export async function fetchPlaylist(source, {
  timeoutMs = 20000, maxBytes = 25 * 1024 * 1024, includeFinalUrl = false, asBuffer = false,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647
    || !Number.isSafeInteger(maxBytes) || maxBytes <= 0
    || typeof includeFinalUrl !== 'boolean' || typeof asBuffer !== 'boolean') throw fail('INVALID_SOURCE');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(fail('TIMEOUT')), timeoutMs);
  try {
    let url = parseUrl(source?.url);
    const headers = prepareHeaders(source?.headers);
    for (let redirects = 0; ; redirects += 1) {
      const response = await request(url, headers, controller.signal);
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy();
        if (redirects >= 5) throw fail('TOO_MANY_REDIRECTS');
        const next = parseUrl(response.headers.location, url);
        if (url.protocol === 'https:' && next.protocol === 'http:') throw fail('INSECURE_REDIRECT');
        if (next.origin !== url.origin) {
          delete headers.authorization;
          delete headers.referer;
          next.username = '';
          next.password = '';
        }
        url = next;
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.destroy();
        throw fail('HTTP_ERROR');
      }
      const body = await readBody(response, maxBytes, controller.signal);
      const text = asBuffer ? body : body.toString('utf8');
      return includeFinalUrl ? { text, url: url.href } : text;
    }
  } catch (error) {
    if (controller.signal.aborted) throw fail('TIMEOUT');
    if (error instanceof FetchPlaylistError) throw error;
    // Deliberately discard upstream messages and causes: they can contain URLs.
    throw fail('FETCH_FAILED');
  } finally {
    clearTimeout(timer);
  }
}
