import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createAddon, TYPE, NATIVE_TYPE } from '../src/addon.mjs';
import { readConfig } from '../src/config.mjs';
import { parsePlaylist } from '../src/playlist.mjs';
import { createServer } from '../src/server.mjs';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const TOKEN = 'n'.repeat(48);
const SOURCE = {
  id: 'main', name: 'My live channels', url: 'https://provider.example/list.m3u',
  epgUrl: 'https://provider.example/guide.xml',
};
const settings = (sources = [SOURCE]) => readConfig({
  PLAYLISTS_JSON: JSON.stringify(sources), ADDON_TOKEN: TOKEN,
  PUBLIC_URL: 'https://addon.example', CACHE_TTL_SECONDS: '900',
});
const entry = (id, name = id, options = {}) =>
  `#EXTINF:${options.duration ?? -1} tvg-id="${id}" group-title="${options.group ?? 'News'}",${name}\n`
  + `${options.url ?? `https://stream.example/live/${encodeURIComponent(id)}.m3u8`}\n`;
const playlist = (...entries) => `#EXTM3U\n${entries.join('')}`;
const programme = (channel, title, start = '20260923110000 +0000', stop = '20260923130000 +0000') =>
  `<programme channel="${channel}" start="${start}" stop="${stop}"><title>${title}</title><desc>Real provider synopsis</desc></programme>`;
const xml = (...programmes) => `<?xml version="1.0"?><tv>${programmes.join('')}</tv>`;
const channelPlaylist = playlist(entry('news.1', 'News One'));
const currentGuide = xml(programme('news.1', 'Midday bulletin'));

test('one fast manifest preserves legacy lists and exposes only configured native guides', () => {
  const config = settings([
    SOURCE,
    { id: 'xtream', name: 'Xtream', url: 'https://panel.example/path/get.php?username=test-user&password=test-secret&type=m3u_plus' },
    { id: 'plain', name: 'Plain', url: 'https://plain.example/list.m3u' },
    { id: 'disabled', name: 'Disabled', url: 'https://panel.example/get.php?username=user&password=secret', epgUrl: false },
  ]);
  let playlistCalls = 0, guideCalls = 0;
  const addon = createAddon(config,
    async () => { playlistCalls++; throw new Error('Manifest must not fetch playlists'); },
    () => NOW,
    async () => { guideCalls++; throw new Error('Manifest must not fetch guides'); });
  const manifest = addon.manifest(config.publicUrl);
  assert.equal(typeof manifest.then, 'undefined', 'manifest generation remains synchronous');
  assert.equal(playlistCalls, 0);
  assert.equal(guideCalls, 0);
  assert.equal(manifest.behaviorHints.epgProvider, true);
  assert.deepEqual(manifest.types, [TYPE, NATIVE_TYPE]);
  assert.deepEqual(manifest.catalogs.filter(c => c.type === TYPE).map(c => c.id), ['main', 'xtream', 'plain', 'disabled']);
  assert.deepEqual(manifest.catalogs.filter(c => c.type === NATIVE_TYPE).map(c => c.id), ['guide:main', 'guide:xtream']);
  assert.equal(new Set(manifest.catalogs.map(c => c.id)).size, manifest.catalogs.length);
  for (const catalog of manifest.catalogs) {
    assert.deepEqual(catalog.extra.find(e => e.name === 'genre'),
      { name: 'genre', isRequired: true, options: ['All channels'] });
    const date = catalog.extra.find(e => e.name === 'date');
    if (catalog.type === TYPE) assert.equal(date, undefined);
    else { assert.ok(date); assert.notEqual(date.isRequired, true); }
  }
  const derived = new URL(config.sources.find(s => s.id === 'xtream').epgUrl);
  assert.equal(derived.pathname, '/path/xmltv.php');
  assert.deepEqual([...derived.searchParams], [['username', 'test-user'], ['password', 'test-secret']]);
  assert.doesNotMatch(JSON.stringify(manifest), /test-secret|test-user|panel\.example|guide\.xml/);
});

test('playlist-only installs do not claim EPG, including M3U-header-only hints', async () => {
  const config = settings([{ ...SOURCE, epgUrl: false }]);
  let guideCalls = 0;
  const addon = createAddon(config,
    async () => channelPlaylist.replace('#EXTM3U', '#EXTM3U x-tvg-url="https://provider.example/discovered.xml"'),
    () => NOW, async () => { guideCalls++; return currentGuide; });
  const before = addon.manifest(config.publicUrl);
  assert.notEqual(before.behaviorHints.epgProvider, true);
  assert.ok(before.catalogs.every(c => c.type === TYPE && c.extra.every(e => e.name !== 'date')));
  await addon.catalog('main', { genre: 'All channels' });
  assert.deepEqual(addon.manifest(config.publicUrl), before, 'warming a playlist must not silently alter installed capabilities');
  assert.equal(guideCalls, 0);
});

test('both Home paths stay empty; old Discover and native no-date requests remain channel lists', async () => {
  let playlistCalls = 0, guideCalls = 0;
  const addon = createAddon(settings(), async () => { playlistCalls++; return channelPlaylist; }, () => NOW,
    async () => { guideCalls++; return currentGuide; });
  assert.deepEqual(await addon.catalog('main', {}, TYPE), { metas: [] });
  assert.deepEqual(await addon.catalog('guide:main', {}, NATIVE_TYPE), { metas: [] });
  assert.equal(playlistCalls, 0);
  const classic = await addon.catalog('main', { genre: 'All channels' }, TYPE);
  const native = await addon.catalog('guide:main', { genre: 'All channels' }, NATIVE_TYPE);
  assert.equal(classic.metas[0].type, TYPE);
  assert.equal(native.metas[0].type, NATIVE_TYPE);
  assert.equal(classic.metas[0].id, native.metas[0].id);
  for (const meta of [classic.metas[0], native.metas[0], (await addon.meta(classic.metas[0].id, TYPE)).meta]) {
    assert.equal(meta.videos, undefined);
    assert.equal(meta.behaviorHints.hasScheduledVideos, undefined);
  }
  assert.equal(guideCalls, 0, 'legacy and fallback channel lists need no XMLTV fetch');
});

test('dated guides use actual UTC overlaps and stable programme IDs across adjacent days', async () => {
  const guide = xml(
    programme('news.1', 'Ends at boundary', '20260922230000 +0000', '20260923000000 +0000'),
    programme('news.1', 'Crosses into day', '20260922233000 +0000', '20260923003000 +0000'),
    programme('news.1', 'Morning', '20260923100000 +0000', '20260923110000 +0000'),
    programme('news.1', 'Crosses out of day', '20260923233000 +0000', '20260924003000 +0000'),
    programme('news.1', 'Next day', '20260924003000 +0000', '20260924010000 +0000'),
  );
  const addon = createAddon(settings(), async () => channelPlaylist, () => NOW, async () => guide);
  const first = await addon.catalog('guide:main', { genre: 'All channels', date: '2026-09-23' }, NATIVE_TYPE);
  const next = await addon.catalog('guide:main', { date: '2026-09-24' }, NATIVE_TYPE);
  assert.equal(first.metas, undefined);
  assert.deepEqual(first.metasDetailed[0].videos.map(p => p.title), ['Crosses into day', 'Morning', 'Crosses out of day']);
  assert.deepEqual(next.metasDetailed[0].videos.map(p => p.title), ['Crosses out of day', 'Next day']);
  const midnight = first.metasDetailed[0].videos.find(p => p.title === 'Crosses out of day');
  assert.equal(midnight.id, next.metasDetailed[0].videos[0].id,
    'the same broadcast is merged by ID when Stremio requests two UTC dates');
  for (const channel of [first.metasDetailed[0], next.metasDetailed[0]]) {
    assert.equal(channel.type, NATIVE_TYPE);
    assert.equal(channel.behaviorHints.isLive, true);
    assert.equal(channel.behaviorHints.hasScheduledVideos, true);
    assert.equal(channel.behaviorHints.defaultVideoId, channel.id);
    for (const p of channel.videos) {
      assert.ok(p.id.startsWith(`${channel.id}:epg:`));
      assert.equal(p.released, p.startTime);
      assert.ok(Date.parse(p.endTime) > Date.parse(p.startTime));
    }
  }
});

test('native guide pages retain all live channels and end with an empty detailed page', async () => {
  const body = playlist(...Array.from({ length: 205 }, (_, i) => entry(`ch.${i}`, `Live ${i}`)),
    entry('vod', 'A recording', { duration: 1200 }));
  const guide = xml(programme('ch.0', 'First bulletin'), programme('ch.204', 'Last bulletin'), programme('vod', 'Excluded recording'));
  let guideCalls = 0;
  const addon = createAddon(settings(), async () => body, () => NOW, async () => { guideCalls++; return guide; });
  const pages = [];
  for (const skip of [0, 100, 200, 205]) {
    pages.push(await addon.catalog('guide:main', { date: '2026-09-23', skip: String(skip) }, NATIVE_TYPE));
  }
  assert.deepEqual(pages.map(p => p.metasDetailed.length), [100, 100, 5, 0]);
  const channels = pages.flatMap(p => p.metasDetailed);
  assert.equal(new Set(channels.map(c => c.id)).size, 205);
  assert.equal(channels[0].videos[0].title, 'First bulletin');
  assert.deepEqual(channels[1].videos, [], 'a missing schedule does not hide the live channel');
  assert.equal(channels[204].videos[0].title, 'Last bulletin');
  assert.equal(guideCalls, 1);
});

test('only exact tvg-id matches of approved live channels acquire programme data', async () => {
  const body = playlist(entry('news.1', 'News One'), entry('', 'news.1'),
    entry('recorded', 'Recorded', { duration: 600 }),
    entry('unknown', 'Ambiguous', { group: 'USA', url: 'https://stream.example/unknown.m3u8' }));
  const guide = xml(programme('news.1', 'Approved news'), programme('NEWS.1', 'Wrong case'),
    programme('recorded', 'VOD programme'), programme('unknown', 'Unapproved programme'),
    programme('News One', 'Name-only match'), programme('missing', 'Missing channel'));
  const addon = createAddon(settings(), async () => body, () => NOW, async () => guide);
  const { metasDetailed } = await addon.catalog('guide:main', { date: '2026-09-23' }, NATIVE_TYPE);
  assert.deepEqual(metasDetailed.map(c => c.name), ['News One', 'news.1']);
  assert.deepEqual(metasDetailed[0].videos.map(p => p.title), ['Approved news']);
  assert.deepEqual(metasDetailed[1].videos, [], 'channel names must not stand in for missing tvg-id');
  const hiddenId = parsePlaylist(playlist(entry('recorded', 'Recorded')), SOURCE).channels[0].id;
  assert.deepEqual(await addon.meta(hiddenId, NATIVE_TYPE), { meta: null });
  assert.deepEqual(await addon.stream(hiddenId, NATIVE_TYPE), { streams: [] });
  const status = await addon.status('main');
  assert.equal(status.sources[0].stats.excludedVod, 1);
  assert.equal(status.sources[0].guide.programmes, 1);
  assert.equal(status.sources[0].guide.matchedChannels, 1);
});

test('native metadata includes a schedule but playback identity remains the channel', async () => {
  const addon = createAddon(settings(), async () => channelPlaylist, () => NOW,
    async () => gzipSync(currentGuide));
  const channelId = (await addon.catalog('main', { genre: 'All channels' })).metas[0].id;
  const { meta } = await addon.meta(channelId, NATIVE_TYPE);
  assert.equal(meta.type, NATIVE_TYPE);
  assert.equal(meta.videos[0].title, 'Midday bulletin');
  assert.equal(meta.behaviorHints.defaultVideoId, channelId);
  assert.equal((await addon.stream(channelId, NATIVE_TYPE)).streams[0].url,
    'https://stream.example/live/news.1.m3u8');
  assert.deepEqual(await addon.stream(meta.videos[0].id, NATIVE_TYPE), { streams: [] },
    'programme IDs do not become alternate video or VOD streams');
  assert.equal((await addon.meta(channelId, TYPE)).meta.videos, undefined);
});

test('expired or malformed guide data leaves channels playable without invented programmes', async () => {
  for (const body of [xml(programme('news.1', 'Long expired', '20260101000000 +0000', '20260101010000 +0000')),
    '<html>PRIVATE_PROVIDER_ERROR</html>']) {
    const addon = createAddon(settings(), async () => channelPlaylist, () => NOW, async () => body);
    const response = await addon.catalog('guide:main', { date: '2026-09-23' }, NATIVE_TYPE);
    assert.equal(response.metasDetailed.length, 1);
    assert.deepEqual(response.metasDetailed[0].videos, []);
    assert.equal((await addon.stream(response.metasDetailed[0].id)).streams.length, 1);
    assert.doesNotMatch(JSON.stringify(await addon.status()), /PRIVATE_PROVIDER_ERROR/);
  }
});

test('guide refresh failure is isolated, briefly cached, and recovers without reinstalling', async () => {
  let now = NOW, calls = 0;
  const addon = createAddon(settings(), async () => channelPlaylist, () => now, async () => {
    calls++;
    if (calls === 2) throw new Error('https://provider.example/guide.xml?password=PRIVATE_TEST_SECRET');
    return currentGuide;
  });
  const manifest = addon.manifest('https://addon.example');
  const load = () => addon.catalog('guide:main', { date: '2026-09-23' }, NATIVE_TYPE);
  assert.equal((await load()).metasDetailed[0].videos.length, 1);
  now += 15 * 60000;
  const fallback = await load();
  assert.deepEqual(fallback.metasDetailed[0].videos, []);
  assert.equal((await addon.stream(fallback.metasDetailed[0].id)).streams.length, 1);
  const status = await addon.status();
  assert.equal(status.sources[0].state, 'ready');
  assert.equal(status.sources[0].guide.state, 'error');
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_TEST_SECRET|guide\.xml/);
  await load();
  assert.equal(calls, 2, 'a temporary outage must not trigger a fetch for every channel');
  assert.deepEqual(addon.manifest('https://addon.example'), manifest);
  now += 60000;
  assert.equal((await load()).metasDetailed[0].videos[0].title, 'Midday bulletin');
  assert.equal(calls, 3);
});

test('guide fetches forward authorization and referer only to the playlist origin', async () => {
  const headers = {
    Authorization: 'Bearer PRIVATE_TEST_TOKEN', Referer: 'https://provider.example/account/PRIVATE_TEST_TOKEN',
    'User-Agent': 'IPTV Test Player', Accept: 'application/xml',
  };
  for (const epgUrl of ['https://provider.example/guide.xml', 'https://other.example/guide.xml', 'http://provider.example/guide.xml']) {
    const seen = [];
    const addon = createAddon(settings([{ ...SOURCE, epgUrl, headers }]), async () => channelPlaylist, () => NOW,
      async source => { seen.push(source); return currentGuide; });
    await addon.catalog('guide:main', { date: '2026-09-23' }, NATIVE_TYPE);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, epgUrl);
    assert.deepEqual(seen[0].headers, epgUrl.startsWith('https://provider.example/')
      ? headers : { 'User-Agent': 'IPTV Test Player', Accept: 'application/xml' });
  }
});

test('invalid UTC dates and native IDs fail without fetching providers', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error('Unexpected provider request'); };
  const addon = createAddon(settings(), fetcher, () => NOW, fetcher);
  for (const date of ['2026-02-30', '2026-13-01', '2026-9-23', '2026-09-23T00:00:00Z', 'not-a-date']) {
    assert.deepEqual(await addon.catalog('guide:main', { date }, NATIVE_TYPE), { metasDetailed: [] });
  }
  assert.deepEqual(await addon.catalog('main', { date: '2026-09-23' }, NATIVE_TYPE), { metasDetailed: [] });
  assert.deepEqual(await addon.catalog('guide:unknown', { date: '2026-09-23' }, NATIVE_TYPE), { metasDetailed: [] });
  assert.equal(calls, 0);
});

test('HTTP native routes decode guide IDs and preserve authentication and the VOD boundary', async () => {
  const config = settings();
  const addon = createAddon(config, async () => playlist(entry('news.1', 'News One'),
    entry('recorded', 'Recorded', { duration: 600 })), () => NOW, async () => currentGuide);
  const server = createServer(config, addon);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const prefix = `${base}/addon/${TOKEN}`;
  const get = async path => {
    const response = await fetch(prefix + path);
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const response = await get('/catalog/tv/guide%3Amain/genre=All%20channels&date=2026-09-23.json');
    const channel = response.metasDetailed[0];
    const id = encodeURIComponent(channel.id);
    assert.equal(channel.type, NATIVE_TYPE);
    assert.equal(channel.videos[0].title, 'Midday bulletin');
    assert.equal((await get(`/meta/tv/${id}.json`)).meta.behaviorHints.defaultVideoId, channel.id);
    assert.equal((await get(`/stream/tv/${id}.json`)).streams.length, 1);
    assert.deepEqual((await get('/catalog/tv/guide%3Amain.json')).metas, []);
    assert.equal((await get('/catalog/tv/guide%3Amain/genre=All%20channels.json')).metas[0].videos, undefined);
    assert.deepEqual((await get('/catalog/movie/guide%3Amain/genre=All%20channels.json')).metas, []);
    assert.deepEqual((await get(`/meta/movie/${id}.json`)).meta, null);
    assert.deepEqual((await get(`/stream/movie/${id}.json`)).streams, []);
    assert.equal((await fetch(`${base}/addon/wrong/catalog/tv/guide%3Amain/date=2026-09-23.json`)).status, 404);
  } finally {
    server.closeIdleConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
