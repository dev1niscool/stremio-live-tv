import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPlaylists, normalizePlaylistUrl, sourceFromUrl } from '../public/importer.mjs';

const account = 'https://provider.example.test:8443/service/get.php?username=demo_user&password=synthetic_pass&type=m3u_plus&output=ts';

test('extracts a complete Xtream account from prose with exact username and sibling XMLTV URL', () => {
  const result = extractPlaylists(`My authorized playlist:\n${account}\nDone.`);
  assert.equal(result.sources.length, 1);
  const [source] = result.sources;
  assert.equal(source.name, 'demo_user');
  assert.equal(source.url, account);
  assert.equal(source.epgUrl,
    'https://provider.example.test:8443/service/xmltv.php?username=demo_user&password=synthetic_pass');
  assert.match(source.id, /^pl_[0-9a-f]{32}$/);
  assert.doesNotMatch(source.id, /demo_user|synthetic_pass|provider/);
  assert.equal(result.rejectedCount, 0);
});

test('supports Markdown, HTML ampersands, escaped slashes/ampersands and terminal punctuation', () => {
  const escaped = String.raw`https:\/\/other.example.test\/get.php?username=demo_user\&password=synthetic_pass\&type=m3u_plus`;
  const result = extractPlaylists(`[Account label](${account.replaceAll('&', '&amp;')}).\n`
    + `[Local channels](https://lists.example.test/channels.m3u?region=us),\n${escaped}\n`
    + 'A list: <https://lists.example.test/tv.m3u8>!');
  assert.equal(result.sources.length, 4);
  assert.deepEqual(result.sources.map(({ name }) => name), ['demo_user', 'Local channels', 'demo_user', 'lists.example.test']);
  assert.equal(result.sources[0].url, account);
  assert.equal(result.sources[1].url, 'https://lists.example.test/channels.m3u?region=us');
  assert.equal(result.sources[2].url,
    'https://other.example.test/get.php?username=demo_user&password=synthetic_pass&type=m3u_plus');
  assert.equal(result.rejectedCount, 0);
});

test('account naming preserves the exact decoded username and explicit overrides stay possible', () => {
  const source = sourceFromUrl(account.replace('demo_user', 'Demo_User%2BWest'));
  assert.equal(source.name, 'Demo_User+West');
  assert.equal(sourceFromUrl(account, '  Family TV  ').name, 'Family TV');
  assert.equal(sourceFromUrl(account, '').name, 'demo_user');
  assert.equal(sourceFromUrl('https://lists.example.test/eu.m3u?username=demo_user').name, 'demo_user');
});

test('deduplicates account format/password variants but preserves providers, base paths, accounts and selectors', () => {
  const links = [account,
    account.replace('output=ts', 'output=m3u8').replace('type=m3u_plus', 'type=m3u'),
    account.replace('synthetic_pass', 'rotated_synthetic_pass'),
    account.replace('provider.example.test', 'other.example.test'),
    account.replace('/service/', '/another/'),
    account.replace('demo_user', 'demo_user_two'),
    `${account}&category_id=1`, `${account}&category_id=2`,
  ];
  const result = extractPlaylists(links.join('\n'));
  assert.equal(result.sources.length, 6);
  assert.equal(result.duplicateCount, 2);
  assert.equal(new Set(result.sources.map(({ id }) => id)).size, 6);
  assert.equal(sourceFromUrl(account).id, sourceFromUrl(links[1]).id);
  assert.equal(sourceFromUrl(account).id, sourceFromUrl(links[2]).id);
  assert.equal(result.sources[0].url, account, 'first occurrence is retained');
});

test('generic canonical duplicates ignore query order, equivalent escaping and fragments but preserve different lists', () => {
  const result = extractPlaylists('https://LISTS.example.test:443/channels.m3u?region=us&token=a%20b#copy\n'
    + 'https://lists.example.test/channels.m3u?token=a+b&region=us\n'
    + 'https://lists.example.test/channels.m3u?region=eu&token=a%20b\n'
    + 'https://lists.example.test/other.m3u?region=us&token=a%20b\n');
  assert.equal(result.sources.length, 3);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.sources[0].url, 'https://lists.example.test/channels.m3u?region=us&token=a%20b');
  assert.equal(new Set(result.sources.map(({ id }) => id)).size, 3);
});

test('ordinary M3U channel repository files are allowed inside a streams directory', () => {
  const source = sourceFromUrl('https://lists.example.test/repository/streams/us.m3u');
  assert.equal(source.name, 'lists.example.test');
  assert.equal(source.url, 'https://lists.example.test/repository/streams/us.m3u');
  assert.equal(source.epgUrl, undefined);
});

test('ignores websites, API/EPG endpoints and obvious raw streams, counting URL-shaped rejects', () => {
  const unsupported = [
    'https://example.test',
    'https://example.test/player_api.php?username=demo_user&password=synthetic_pass',
    'https://example.test/xmltv.php?username=demo_user&password=synthetic_pass',
    'https://example.test/live/demo_user/synthetic_pass/123.m3u8',
    'https://example.test/movie/demo_user/synthetic_pass/123.mp4',
    'https://example.test/hls/channel/master.m3u8',
    'https://example.test/123.m3u8',
    'https://example.test/index.m3u8',
    'https://example.test/channel.ts',
    'ftp://example.test/channels.m3u',
    'https:/example.test/channels.m3u',
    'https://example.test/get.php?username=demo_user',
    'https://example.test/get.php?username=demo_user&password=synthetic_pass&type=vod',
  ];
  const result = extractPlaylists(`General text that is not a link.\n${unsupported.join('\n')}\n${account}`);
  assert.equal(result.sources.length, 1);
  assert.equal(result.rejectedCount, unsupported.length);
  assert.equal(result.duplicateCount, 0);
});

test('malformed, ambiguous or control-bearing input returns null without disclosing raw input in errors', () => {
  for (const value of [null, {}, '', 'not a URL', 'javascript:example',
    'https://[broken/channels.m3u', 'https://example.test/has space.m3u',
    account.replace('demo_user', 'demo%0Auser'),
    `${account}&username=second_user`, `${account}&password=second_pass`,
    `https://example.test/${'x'.repeat(17000)}.m3u`]) {
    assert.equal(normalizePlaylistUrl(value), null);
    assert.equal(sourceFromUrl(value), null);
  }
  assert.equal(sourceFromUrl(account, 'Name\nInjected'), null);
  assert.deepEqual(extractPlaylists(null), { sources: [], rejectedCount: 0, duplicateCount: 0 });
});

test('HTML numeric entities, JSON unicode escapes and adjacent comma-separated lists normalize locally', () => {
  const result = extractPlaylists('https://one.example.test/get.php?username=demo_user&#38;password=synthetic_pass,'
    + String.raw`https:\/\/two.example.test\/get.php?username=demo_user\u0026password=synthetic_pass`);
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].name, 'demo_user');
  assert.equal(result.sources[1].epgUrl,
    'https://two.example.test/xmltv.php?username=demo_user&password=synthetic_pass');
});

test('preserves signed query serialization and encoded credential punctuation', () => {
  const signed = 'https://lists.example.test/channels.m3u?z=~%20%2F&a=first';
  assert.equal(normalizePlaylistUrl(signed), signed);
  const source = sourceFromUrl('https://example.test/get.php?username=demo_user&password=synthetic%2E%3B%2C');
  assert.equal(new URL(source.epgUrl).searchParams.get('password'), 'synthetic.;,');
  assert.equal(normalizePlaylistUrl('https://example.test/channel(list).m3u'), 'https://example.test/channel(list).m3u');
});

test('manual URL helpers preserve literal terminal credential punctuation exactly', () => {
  for (const password of ['synthetic_pass.', 'synthetic_pass;', 'synthetic_pass,', 'synthetic_pass)', 'synthetic_pass]']) {
    const url = `https://example.test/get.php?username=demo_user&password=${password}`;
    assert.equal(normalizePlaylistUrl(url), url);
    const source = sourceFromUrl(url);
    assert.equal(source.url, url);
    assert.equal(new URL(source.epgUrl).searchParams.get('password'), password);
  }
});

test('encoded reserved characters stay exact across playlist extraction, titles and derived EPG credentials', () => {
  const username = 'demo_user+West/Unit=2';
  const password = 'synthetic+pass&extra=value/%end.;,)';
  const url = `https://example.test/get.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&type=m3u_plus`;
  const { sources } = extractPlaylists(`Account: [my link](${url})`);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].name, username);
  assert.equal(sources[0].url, url);
  const epg = new URL(sources[0].epgUrl);
  assert.equal(epg.searchParams.get('username'), username);
  assert.equal(epg.searchParams.get('password'), password);
  assert.deepEqual([...epg.searchParams.keys()], ['username', 'password']);
  const spaceName = sourceFromUrl('https://example.test/get.php?username=demo+user&password=synthetic_pass');
  assert.equal(spaceName.name, 'demo user', 'query plus signs represent spaces unless encoded as %2B');
});

test('extractor never evaluates markup or performs network requests', () => {
  const before = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Unexpected network call'); };
  try {
    const result = extractPlaylists('[<img onerror=example>](https://lists.example.test/list.m3u)');
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].name, '<img onerror=example>');
  } finally { globalThis.fetch = before; }
});
