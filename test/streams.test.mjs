import test from 'node:test';
import assert from 'node:assert/strict';
import { streamChoices } from '../src/streams.mjs';

const source = { url: 'https://provider.invalid/panel/get.php?username=example-user&password=example-password&type=m3u_plus&output=ts' };
const channel = { name: 'Example NFL Network', url: 'https://provider.invalid/panel/live/example-user/example-password/123.ts', headers: {} };

function original(c = channel, s = source) {
  assert.deepEqual(streamChoices(c, s), [{ name: 'Live TV', title: c.name, url: c.url,
    behaviorHints: { notWebReady: true, ...(Object.keys(c.headers || {}).length ? { proxyHeaders: { request: c.headers } } : {}) } }]);
}

test('verified Xtream live paths offer HLS first and the original transport second', () => {
  assert.deepEqual(streamChoices(channel, source, { name: 'NFL' }), [
    { name: 'NFL · HLS', title: `${channel.name}\nHLS · try on Android TV`,
      url: 'https://provider.invalid/panel/live/example-user/example-password/123.m3u8', behaviorHints: { notWebReady: true } },
    { name: 'NFL · MPEG-TS', title: `${channel.name}\nMPEG-TS · original format`,
      url: channel.url, behaviorHints: { notWebReady: true } },
  ]);
});

test('an original HLS URL gets no duplicate and TS is clearly an alternate format', () => {
  const c = { ...channel, url: channel.url.replace('.ts', '.m3u8') };
  const choices = streamChoices(c, { url: source.url.replace('output=ts', 'output=m3u8') });
  assert.equal(choices.length, 2);
  assert.equal(choices[0].url, c.url);
  assert.equal(choices[1].url, channel.url);
  assert.equal(choices[1].title, `${channel.name}\nMPEG-TS · alternate format`);
});

test('both choices preserve playback headers without mutating the channel or source', () => {
  const headers = Object.freeze({ 'User-Agent': 'Example Player', Referer: 'https://provider.invalid/' });
  const c = Object.freeze({ ...channel, headers });
  const s = Object.freeze({ ...source, headers: { Authorization: 'unused playlist header' } });
  for (const stream of streamChoices(c, s)) {
    assert.deepEqual(stream.behaviorHints, { notWebReady: true, proxyHeaders: { request: headers } });
    assert.equal(stream.behaviorHints.proxyHeaders.request, headers);
  }
});

test('optional type and output parameters and recognized case variants match the loader', () => {
  for (const suffix of ['', '&type=m3u', '&type=M3U_PLUS&output=M3U8']) {
    const url = `https://provider.invalid/panel/GET.PHP?username=example-user&password=example-password${suffix}`;
    assert.equal(streamChoices(channel, { url }).length, 2, suffix);
  }
});

test('nested base paths, explicit ports and encoded credentials match exactly', () => {
  const url = new URL('http://provider.invalid:8080/a/b/get.php');
  const username = 'example user/@', password = 'example+/密码';
  url.search = new URLSearchParams({ username, password }).toString();
  const c = { name: 'Example', url: `http://provider.invalid:8080/a/b/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/999999999999999.ts` };
  assert.equal(streamChoices(c, { url: url.href }).length, 2);
  original({ ...c, url: c.url.replace('%2F', '%2f') }, { url: url.href });
});

test('unknown, duplicated, empty and unsupported source parameters never broaden scope', () => {
  for (const url of [
    source.url + '&category_id=42', source.url + '&action=get_vod_streams', source.url + '&custom=value',
    source.url + '&username=example-user', source.url + '&password=example-password',
    source.url + '&type=m3u_plus', source.url + '&output=ts',
    source.url.replace('type=m3u_plus', 'type=vod'), source.url.replace('output=ts', 'output=mp4'),
    source.url.replace('example-password', ''), source.url.replace('example-user', ''),
    source.url.replace('example-user', '%0Aexample-user'), source.url.replace('example-password', 'x'.repeat(1025)),
    source.url.replace('get.php', 'playlist.m3u'), source.url.replace('https:', 'ftp:'),
  ]) original(channel, { url });
  original(channel, {});
  original(channel, null);
});

test('other origins, account credentials and unfamiliar or VOD paths stay unchanged', () => {
  for (const url of [
    channel.url.replace('provider.invalid', 'cdn.invalid'), channel.url.replace('https:', 'http:'),
    channel.url.replace('/panel/', '/other/'), channel.url.replace('/live/', '/movie/'),
    channel.url.replace('/live/', '/series/'), channel.url.replace('/live/', '/'),
    channel.url.replace('example-user/', 'other-user/'), channel.url.replace('example-password/', 'other-password/'),
    channel.url.replace('https://', 'https://other:auth@'),
    '/panel/live/example-user/example-password/123.ts', '//provider.invalid/panel/live/example-user/example-password/123.ts',
  ]) original({ ...channel, url });
});

test('query strings, fragments and noncanonical spellings are never rewritten', () => {
  for (const url of [
    channel.url + '?token=example', channel.url + '?type=vod', channel.url + '?',
    channel.url + '#replay', channel.url + '#', channel.url + ' ', ' ' + channel.url,
    channel.url.replace('/123.ts', '/./123.ts'), channel.url.replace('/123.ts', '/%31%32%33.ts'),
    channel.url.replace('https://', 'HTTPS://'), channel.url.replace('.invalid/', '.invalid:443/'),
  ]) original({ ...channel, url });
});

test('only positive decimal stream IDs of at most 15 digits and exact live extensions match', () => {
  for (const tail of ['0.ts', '01.ts', '-1.ts', '1000000000000000.ts', '1.5.ts', 'abc.ts',
    '123.mp4', '123.mkv', '123.TS', '123.M3U8', '123.ts/replay', '123']) {
    original({ ...channel, url: channel.url.replace('123.ts', tail) });
  }
  assert.equal(streamChoices({ ...channel, url: channel.url.replace('123.ts', '1.ts') }, source).length, 2);
});

test('credential dot segments cannot normalize into a different live endpoint', () => {
  for (const value of ['.', '..']) {
    const s = { url: `https://provider.invalid/panel/get.php?username=${value}&password=example-password` };
    const c = { ...channel, url: new URL(`live/${value}/example-password/123.ts`, s.url).href };
    original(c, s);
  }
});

test('unmatched streams retain the existing exact shape including custom name and headers', () => {
  const c = { name: 'Example Channel', url: 'https://cdn.invalid/live.m3u8?token=example', headers: { 'User-Agent': 'Example Player' } };
  assert.deepEqual(streamChoices(c, source, { name: 'NFL' }), [{ name: 'NFL', title: c.name, url: c.url,
    behaviorHints: { notWebReady: true, proxyHeaders: { request: c.headers } } }]);
});
