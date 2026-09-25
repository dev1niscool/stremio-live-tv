import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddon, PAGE_SIZE, TYPE } from '../src/addon.mjs';
import { readConfig } from '../src/config.mjs';
import { parsePlaylist } from '../src/playlist.mjs';

const TOKEN = 'a'.repeat(48);
const privatePlaylist = 'https://provider.example.test/get.php?username=PRIVATE_NAME&password=PRIVATE_PASSWORD';
const baseSource = { id: 'main', name: 'My television', url: privatePlaylist };
const entry = (name, options = {}) => `#EXTINF:${options.duration ?? -1} tvg-id="${options.id ?? name}" group-title="${options.group ?? 'News'}",${name}\n${options.url ?? `https://stream.example.test/live/${encodeURIComponent(name)}.m3u8`}\n`;
const playlist = (...entries) => `#EXTM3U\n${entries.join('')}`;
const settings = (overrides = {}) => ({ sources: [baseSource], name: 'Stremio Live TV', ttlMs: 1000, ...overrides });
const envWith = (sources = [baseSource], overrides = {}) => ({ PLAYLISTS_JSON: JSON.stringify(sources), ADDON_TOKEN: TOKEN, ...overrides });

test('manifest exposes each playlist under Live TV with a required Discover genre', () => {
  let calls = 0;
  const sources = [baseSource, { ...baseSource, id: 'second', name: 'Second list' }];
  const addon = createAddon(settings({ sources }), async () => { calls += 1; return playlist(); });
  const manifest = addon.manifest('https://addon.example.test');
  assert.equal(TYPE, 'Live TV');
  assert.deepEqual(manifest.types, ['Live TV']);
  assert.deepEqual(manifest.catalogs.map(({ id, name, type }) => ({ id, name, type })),
    sources.map(({ id, name }) => ({ id, name, type: 'Live TV' })));
  for (const catalog of manifest.catalogs) {
    assert.deepEqual(catalog.extra.find((extra) => extra.name === 'genre'),
      { name: 'genre', isRequired: true, options: ['All channels'] });
    assert.ok(catalog.extra.some((extra) => extra.name === 'skip'));
    assert.ok(catalog.extra.some((extra) => extra.name === 'search'));
  }
  assert.ok(manifest.resources.some((resource) => resource.name === 'meta' && resource.idPrefixes.includes('iptv:')));
  assert.ok(manifest.resources.some((resource) => resource.name === 'stream' && resource.idPrefixes.includes('iptv:')));
  assert.doesNotMatch(JSON.stringify(manifest), /PRIVATE_NAME|PRIVATE_PASSWORD|provider\.example\.test/);
  assert.equal(calls, 0, 'building a manifest must never fetch provider playlists');
});

test('Home, unsupported genre, unknown playlist and invalid pagination requests never fetch', async () => {
  let calls = 0;
  const addon = createAddon(settings(), async () => { calls += 1; return playlist(entry('News')); });
  for (const [id, extra] of [
    ['main', undefined], ['main', {}], ['main', { search: 'News' }], ['main', { genre: 'News' }],
    ['missing', { genre: 'All channels' }], ['main', { genre: 'All channels', skip: '-1' }],
    ['main', { genre: 'All channels', skip: '1.5' }], ['main', { genre: 'All channels', skip: 'NaN' }],
    ['main', { genre: 'All channels', skip: '9007199254740992' }],
  ]) assert.deepEqual(await addon.catalog(id, extra), { metas: [] });
  assert.equal(calls, 0);
});

test('catalog pagination happens after case-insensitive name/group search and live-only filtering', async () => {
  const lines = [];
  for (let index = 0; index < 205; index += 1) {
    lines.push(entry(`Target ${index}`));
    if (index % 10 === 0) {
      lines.push(entry(`Target movie ${index}`, { group: 'Movies', url: `https://stream.example.test/movie/${index}` }));
      lines.push(entry(`Other ${index}`, { group: 'Sports' }));
    }
  }
  const addon = createAddon(settings(), async () => playlist(...lines));
  assert.equal(PAGE_SIZE, 100);
  const first = await addon.catalog('main', { genre: 'All channels', search: ' tArGeT ' });
  const second = await addon.catalog('main', { genre: 'All channels', search: 'TARGET', skip: '100' });
  const third = await addon.catalog('main', { genre: 'All channels', search: 'target', skip: '200' });
  assert.deepEqual(first.metas.map(({ name }) => name), Array.from({ length: 100 }, (_, i) => `Target ${i}`));
  assert.deepEqual(second.metas.map(({ name }) => name), Array.from({ length: 100 }, (_, i) => `Target ${i + 100}`));
  assert.deepEqual(third.metas.map(({ name }) => name), Array.from({ length: 5 }, (_, i) => `Target ${i + 200}`));
  assert.deepEqual(await addon.catalog('main', { genre: 'All channels', search: 'target', skip: '205' }), { metas: [] });
  const byGroup = await addon.catalog('main', { genre: 'All channels', search: 'SPORTS' });
  assert.equal(byGroup.metas.length, 21);
  assert.ok(byGroup.metas.every(({ name }) => name.startsWith('Other')));
});

test('catalog, meta and streams resolve the same identity and preserve provider playback headers', async () => {
  const body = playlist(entry('News', {
    url: 'https://stream.example.test/live/news.m3u8|User-Agent=TV%20Player&Referer=https%3A%2F%2Fplayer.example.test',
  }));
  const addon = createAddon(settings(), async () => body);
  const { metas } = await addon.catalog('main', { genre: 'All channels' });
  assert.equal(metas.length, 1);
  const { meta } = await addon.meta(metas[0].id);
  assert.deepEqual(meta, metas[0]);
  assert.equal(meta.type, 'Live TV');
  assert.equal(meta.behaviorHints.defaultVideoId, meta.id);
  assert.equal(meta.behaviorHints.isLive, true);
  assert.doesNotMatch(JSON.stringify(meta), /PRIVATE_NAME|PRIVATE_PASSWORD|provider\.example\.test/);
  const { streams } = await addon.stream(meta.id);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://stream.example.test/live/news.m3u8');
  assert.deepEqual(streams[0].behaviorHints.proxyHeaders.request,
    { 'User-Agent': 'TV Player', Referer: 'https://player.example.test' });
  assert.equal(streams[0].behaviorHints.notWebReady, true);
});

test('filtered VOD IDs cannot be opened through meta or stream endpoints', async () => {
  const vod = entry('Recorded news', { duration: 3600 });
  const hypotheticalLive = entry('Recorded news');
  const hiddenId = parsePlaylist(playlist(hypotheticalLive), baseSource).channels[0].id;
  let calls = 0;
  const addon = createAddon(settings(), async () => { calls += 1; return playlist(vod, entry('Actual live')); });
  const { metas } = await addon.catalog('main', { genre: 'All channels' });
  assert.deepEqual(metas.map(({ name }) => name), ['Actual live']);
  assert.deepEqual(await addon.meta(hiddenId), { meta: null });
  assert.deepEqual(await addon.stream(hiddenId), { streams: [] });
  assert.deepEqual(await addon.meta('iptv:main:unknown'), { meta: null });
  assert.deepEqual(await addon.stream('iptv:unconfigured:unknown'), { streams: [] });
  assert.equal(calls, 1);
});

test('redirected playlist URL supplies the base for relative stream and logo addresses', async () => {
  const addon = createAddon(settings(), async () => ({
    url: 'https://cdn.example.test/provider/channels/list.m3u',
    text: '#EXTM3U\n#EXTINF:-1 tvg-id="one" tvg-logo="../logos/news.png" group-title="Live TV",One\n../streams/one.m3u8\n',
  }));
  const { metas } = await addon.catalog('main', { genre: 'All channels' });
  assert.equal(metas[0].poster, 'https://cdn.example.test/provider/logos/news.png');
  assert.equal((await addon.stream(metas[0].id)).streams[0].url,
    'https://cdn.example.test/provider/streams/one.m3u8');
});

test('unknown source IDs do not fetch any playlists', async () => {
  let calls = 0;
  const addon = createAddon(settings(), async () => { calls += 1; return playlist(entry('News')); });
  assert.deepEqual(await addon.meta('tt123456'), { meta: null });
  assert.deepEqual(await addon.stream('iptv:not-configured:abc'), { streams: [] });
  assert.equal(calls, 0);
});

test('verified Xtream live channels expose HLS and original TS through both addon profiles', async () => {
  const url = 'https://provider.example.test/live/PRIVATE_NAME/PRIVATE_PASSWORD/123.ts';
  const addon = createAddon(settings(), async () => playlist(entry('NFL Network', {url,group:'NFL'}),
    entry('NFL Recording', {duration:300,url:'https://provider.example.test/movie/PRIVATE_NAME/PRIVATE_PASSWORD/124.mp4'})));
  for (const profile of ['full','nfl']) {
    const {metas} = await addon.catalog(profile === 'full' ? 'main' : 'nfl:main',{genre:'All channels'},TYPE,profile);
    assert.equal(metas.length,1);
    const {streams} = await addon.stream(metas[0].id,TYPE,profile);
    assert.deepEqual(streams.map(s => s.url),[url.replace(/\.ts$/,'.m3u8'),url]);
    assert.ok(streams.every(s => s.behaviorHints.notWebReady));
    assert.match(streams[0].name,/HLS/);
    assert.match(streams[1].name,/MPEG-TS/);
  }
});

test('concurrent catalog and status requests share one fetch; TTL and refresh invalidate cached data', async () => {
  let now = 10000;
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const addon = createAddon(settings(), async () => {
    calls += 1;
    if (calls === 1) await gate;
    return playlist(entry(`News ${calls}`));
  }, () => now);
  const first = addon.catalog('main', { genre: 'All channels' });
  const second = addon.catalog('main', { genre: 'All channels' });
  const status = addon.status();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  const [one, two, loaded] = await Promise.all([first, second, status]);
  assert.deepEqual(one, two);
  assert.equal(loaded.sources[0].state, 'ready');
  now += 999;
  assert.equal((await addon.catalog('main', { genre: 'All channels' })).metas[0].name, 'News 1');
  assert.equal(calls, 1);
  now += 1;
  assert.equal((await addon.catalog('main', { genre: 'All channels' })).metas[0].name, 'News 2');
  assert.equal(calls, 2);
  addon.refresh();
  await addon.catalog('main', { genre: 'All channels' });
  assert.equal(calls, 3);
});

test('source failure is isolated, sanitized and retried while successful sources remain cached', async () => {
  const sources = [baseSource, { ...baseSource, id: 'working', name: 'Working list' }];
  let brokenCalls = 0;
  let workingCalls = 0;
  const addon = createAddon(settings({ sources }), async (source) => {
    if (source.id === 'main' && ++brokenCalls === 1) throw new Error(`Could not fetch ${privatePlaylist}`);
    if (source.id === 'working') workingCalls += 1;
    return playlist(entry('News'));
  });
  const first = await addon.status();
  assert.deepEqual(first.sources.map(({ state }) => state), ['error', 'ready']);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_NAME|PRIVATE_PASSWORD|provider\.example\.test/);
  assert.equal(first.sources[1].stats.accepted, 1);
  assert.equal((await addon.catalog('working', { genre: 'All channels' })).metas.length, 1);
  const recovered = await addon.status();
  assert.deepEqual(recovered.sources.map(({ state }) => state), ['ready', 'ready']);
  assert.equal(workingCalls, 1);
});

test('a synchronous fetcher failure clears pending work and permits a later retry', async () => {
  let calls = 0;
  const addon = createAddon(settings(), () => {
    if (++calls === 1) throw new Error(`Provider denied ${privatePlaylist}`);
    return playlist(entry('Recovered channel'));
  });
  await assert.rejects(addon.catalog('main', { genre: 'All channels' }), (error) => {
    assert.doesNotMatch(error.message, /PRIVATE_NAME|PRIVATE_PASSWORD|provider\.example\.test/);
    return true;
  });
  assert.equal((await addon.catalog('main', { genre: 'All channels' })).metas[0].name, 'Recovered channel');
  assert.equal(calls, 2);
});

test('status limits provider concurrency and rejects HLS or non-playlist responses per source', async () => {
  const sources = Array.from({ length: 9 }, (_, index) => ({ ...baseSource, id: `s${index}`, name: `List ${index}` }));
  let active = 0;
  let maximum = 0;
  const addon = createAddon(settings({ sources }), async (source) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    if (source.id === 's0') return '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nsegment.ts';
    if (source.id === 's1') return '<html>Access denied</html>';
    return playlist(entry('News'));
  });
  const result = await addon.status();
  assert.equal(maximum, 2);
  assert.equal(result.sources.length, 9);
  assert.deepEqual(result.sources.map(({ state }) => state), ['error', 'error', ...Array(7).fill('ready')]);
});

test('configuration allows an empty setup and requires a strong install key for private playlists', () => {
  assert.deepEqual(readConfig({}).sources, []);
  assert.throws(() => readConfig(envWith(undefined, { ADDON_TOKEN: '' })), /Set ADDON_TOKEN/);
  for (const token of ['short', 'contains spaces'.repeat(4), 'a'.repeat(257)]) {
    assert.throws(() => readConfig(envWith(undefined, { ADDON_TOKEN: token })), /ADDON_TOKEN/);
  }
  const result = readConfig(envWith());
  assert.equal(result.sources.length, 1);
  assert.equal(result.token, TOKEN);
  assert.equal(result.port, 7860);
  assert.equal(result.ttlMs, 900000);
});

test('configuration validates malformed records, duplicate IDs, groups, headers and URL schemes', () => {
  for (const raw of ['not json', '{}', 'null']) {
    assert.throws(() => readConfig({ PLAYLISTS_JSON: raw }), /JSON array|array of at most/);
  }
  const invalidLists = [
    [null], [[]], [{ ...baseSource, name: '' }], [{ ...baseSource, name: 'x'.repeat(81) }],
    [{ ...baseSource, url: 'not-a-url' }], [{ ...baseSource, url: 'file:///private/example' }],
    [{ ...baseSource, id: '../bad' }], [baseSource, baseSource],
    [{ ...baseSource, includeGroups: 'News' }], [{ ...baseSource, excludeGroups: [''] }],
    [{ ...baseSource, headers: { Host: 'elsewhere.example.test' } }],
    [{ ...baseSource, headers: { 'User-Agent': 'OK\r\nInjected: bad' } }],
    [{ ...baseSource, headers: { Accept: 1 } }],
  ];
  for (const list of invalidLists) assert.throws(() => readConfig(envWith(list)));
  assert.throws(() => readConfig(envWith(Array.from({ length: 51 }, (_, i) => ({ ...baseSource, id: `id${i}` })))), /at most 50/);
});

test('configuration normalizes names/groups and derives stable URL-independent default IDs', () => {
  const input = [{ name: '  My list  ', url: privatePlaylist, includeGroups: ['  USA '], excludeGroups: [' Movies '],
    headers: { Authorization: 'Bearer synthetic-test-value', 'User-Agent': 'Example Player' } }];
  const first = readConfig(envWith(input));
  const second = readConfig(envWith([{ ...input[0], url: 'https://other.example.test/list.m3u' }]));
  assert.equal(first.sources[0].name, 'My list');
  assert.deepEqual(first.sources[0].includeGroups, ['USA']);
  assert.deepEqual(first.sources[0].excludeGroups, ['Movies']);
  assert.equal(first.sources[0].id, second.sources[0].id);
  assert.equal(first.sources[0].headers.Authorization, 'Bearer synthetic-test-value');
});

test('configuration enforces public origins, cache TTL and port ranges without URL leakage in errors', () => {
  for (const PUBLIC_URL of ['https://example.test/path', 'https://name:PRIVATE_PASSWORD@example.test/',
    'https://example.test/?token=PRIVATE_PASSWORD', 'ftp://example.test']) {
    assert.throws(() => readConfig(envWith(undefined, { PUBLIC_URL })), (error) => {
      assert.match(error.message, /PUBLIC_URL/);
      assert.doesNotMatch(error.message, /PRIVATE_PASSWORD|https:\/\//);
      return true;
    });
  }
  assert.equal(readConfig(envWith(undefined, { SPACE_HOST: 'sample-owner-app.hf.space' })).publicUrl,
    'https://sample-owner-app.hf.space');
  for (const CACHE_TTL_SECONDS of ['59', '86401', 'abc', '1.5']) {
    assert.throws(() => readConfig(envWith(undefined, { CACHE_TTL_SECONDS })), /CACHE_TTL_SECONDS/);
  }
  for (const PORT of ['0', '65536', 'abc', '1.5']) {
    assert.throws(() => readConfig(envWith(undefined, { PORT })), /PORT/);
  }
});
