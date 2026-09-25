const CONTROL = /[\u0000-\u001f\u007f]/;
const ACCOUNT_PARAMS = new Set(['username', 'password', 'type', 'output']);

function xtreamAccount(source) {
  let url;
  try { url = new URL(source?.url); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || !/\/get\.php$/i.test(url.pathname)) return null;
  for (const key of url.searchParams.keys()) {
    if (!ACCOUNT_PARAMS.has(key) || url.searchParams.getAll(key).length !== 1) return null;
  }
  const username = url.searchParams.get('username'), password = url.searchParams.get('password');
  if (!username || !password || CONTROL.test(username) || CONTROL.test(password)
    || username.length > 1024 || password.length > 1024) return null;
  const type = url.searchParams.get('type'), output = url.searchParams.get('output');
  if (type !== null && !/^(?:m3u|m3u_plus)$/i.test(type)) return null;
  if (output !== null && !/^(?:ts|m3u8)$/i.test(output)) return null;
  return { url, username, password };
}

function xtreamAlternates(channel, source) {
  const account = xtreamAccount(source);
  if (!account || typeof channel.url !== 'string') return null;
  let current;
  try { current = new URL(channel.url); } catch { return null; }
  if (current.origin !== account.url.origin || current.search || current.hash) return null;
  const match = /\/([1-9]\d{0,14})\.(ts|m3u8)$/.exec(current.pathname);
  if (!match) return null;

  const path = `live/${encodeURIComponent(account.username)}/${encodeURIComponent(account.password)}/${match[1]}`;
  const expectedPath = account.url.pathname.slice(0, account.url.pathname.lastIndexOf('/') + 1) + path;
  const makeUrl = extension => {
    const url = new URL(`${path}.${extension}`, account.url);
    url.search = ''; url.hash = '';
    // Credentials containing dot segments must never normalize into a
    // different endpoint. The channel must match the exact generated path.
    return url.pathname === `${expectedPath}.${extension}` ? url.href : null;
  };
  const original = makeUrl(match[2]);
  if (original !== channel.url) return null;
  return { hls: makeUrl('m3u8'), ts: makeUrl('ts'), originalExtension: match[2] };
}

/** Offer formats only for already-approved live channels with an exact Xtream account path. */
export function streamChoices(channel, source, { name = 'Live TV' } = {}) {
  const behaviorHints = {
    notWebReady: true,
    ...(Object.keys(channel.headers || {}).length ? { proxyHeaders: { request: channel.headers } } : {}),
  };
  const choices = xtreamAlternates(channel, source);
  if (!choices) return [{ name, title: channel.name, url: channel.url, behaviorHints }];
  return [
    { name: `${name} · HLS`, title: `${channel.name}\nHLS · try on Android TV`, url: choices.hls, behaviorHints },
    { name: `${name} · MPEG-TS`,
      title: `${channel.name}\nMPEG-TS · ${choices.originalExtension === 'ts' ? 'original' : 'alternate'} format`,
      url: choices.ts, behaviorHints },
  ];
}
