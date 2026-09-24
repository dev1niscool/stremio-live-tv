import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddon, TYPE, NATIVE_TYPE, PAGE_SIZE } from '../src/addon.mjs';
import { readConfig } from '../src/config.mjs';
import { parsePlaylist } from '../src/playlist.mjs';
import { createServer } from '../src/server.mjs';
import { isNflChannel } from '../src/nfl.mjs';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const TOKEN = 'nfl-profile-test-key-'.repeat(3);
const SOURCE = { id: 'main', name: 'My channels', url: 'https://provider.example.test/channels.m3u' };
const GUIDE_SOURCE = { ...SOURCE, epgUrl: 'https://provider.example.test/guide.xml' };
const settings = (sources = [SOURCE]) => readConfig({
  PLAYLISTS_JSON: JSON.stringify(sources), ADDON_TOKEN: TOKEN,
  PUBLIC_URL: 'https://addon.example.test', CACHE_TTL_SECONDS: '900',
});
const entry = (name, options = {}) =>
  `#EXTINF:${options.duration ?? -1} tvg-id="${options.id ?? name}" group-title="${options.group ?? 'Live TV'}",${name}\n`
  + `${options.url ?? `https://stream.example.test/live/${encodeURIComponent(name)}.m3u8`}\n`;
const playlist = (...entries) => `#EXTM3U\n${entries.join('')}`;
const mixed = playlist(entry('NFL Network', { id: 'nfl.network' }), entry('NFL GamePass 01', { id: 'nfl.game' }),
  entry('Local News', { id: 'news' }), entry('ESPN', { id: 'espn' }),
  entry('NFL Recorded Game', { id: 'recorded', duration: 3600 }),
  entry('NFL Movie', { id: 'movie', url: 'https://stream.example.test/movie/1.mp4' }));
const extras = { genre: 'All channels' };
const nflId = id => id.replace(/^iptv:/, 'iptv-nfl:');
const programme = (channel, title) => `<programme channel="${channel}" start="20260923110000 +0000" stop="20260923130000 +0000"><title>${title}</title></programme>`;
const guide = `<tv>${programme('nfl.network', 'NFL pregame')}${programme('nfl.game', 'Live football')}${programme('news', 'Midday news')}${programme('recorded', 'Hidden recording')}</tv>`;

test('NFL channel matching uses explicit NFL names or groups without broad sports/football matches', () => {
  for (const channel of [
    { name: 'NFL Network', group: 'Sports' },
    { name: 'US | NFL GamePass 01', group: 'Sports' },
    { name: 'Game 02', group: 'US | NFL Sunday Ticket' },
    { name: 'nfl redzone', group: 'Live TV' },
  ]) assert.equal(isNflChannel(channel), true, channel.name);
  for (const channel of [
    { name: 'Local News', group: 'News' },
    { name: 'ESPN', group: 'Sports' },
    { name: 'FOX Sports', group: 'Live TV' },
    { name: 'College Football', group: 'Sports' },
    { name: 'Conflict Sports', group: 'Live TV' },
  ]) assert.equal(isNflChannel(channel), false, channel.name);
});

test('NFL manifest is distinct, private, synchronous and preserves both supported catalog protocols', () => {
  const config = settings([GUIDE_SOURCE, { ...SOURCE, id: 'second', name: 'Second account' }]);
  let calls = 0;
  const unexpected = () => { calls++; throw new Error('Manifest must not contact a provider'); };
  const addon = createAddon(config, unexpected, () => NOW, unexpected);
  const full = addon.manifest(config.publicUrl);
  const nfl = addon.manifest(config.publicUrl, 'nfl');
  assert.equal(nfl.id, 'community.stremio.live-tv.nfl');
  assert.equal(nfl.name, `${config.name} — NFL`);
  assert.equal(full.id, 'community.stremio.live-tv');
  assert.deepEqual(full.catalogs.map(c => c.id), ['main', 'second', 'guide:main']);
  assert.deepEqual(nfl.catalogs.map(c => c.id), ['nfl:main', 'nfl:second', 'guide:nfl:main']);
  assert.deepEqual(nfl.types, [TYPE, NATIVE_TYPE]);
  assert.equal(nfl.behaviorHints.epgProvider, true);
  assert.equal(typeof nfl.then, 'undefined');
  for (const name of ['meta', 'stream']) {
    assert.deepEqual(nfl.resources.find(r => r.name === name).idPrefixes, ['iptv-nfl:']);
    assert.deepEqual(full.resources.find(r => r.name === name).idPrefixes, ['iptv:']);
  }
  for (const catalog of nfl.catalogs) {
    assert.deepEqual(catalog.extra.find(e => e.name === 'genre'), { name: 'genre', isRequired: true, options: ['All channels'] });
    if (catalog.type === NATIVE_TYPE) assert.notEqual(catalog.extra.find(e => e.name === 'date').isRequired, true);
    else assert.equal(catalog.extra.find(e => e.name === 'date'), undefined);
  }
  assert.doesNotMatch(JSON.stringify(nfl), /provider\.example|channels\.m3u|guide\.xml/);
  assert.equal(calls, 0);
  const noGuide = createAddon(settings(), unexpected).manifest(config.publicUrl, 'nfl');
  assert.deepEqual(noGuide.types, [TYPE]);
  assert.notEqual(noGuide.behaviorHints.epgProvider, true);
});

test('NFL Home, foreign catalog IDs and invalid pagination return no channels without provider fetches', async () => {
  let calls = 0;
  const addon = createAddon(settings([GUIDE_SOURCE]), async () => { calls++; return mixed; });
  for (const [id, extra, type] of [
    ['nfl:main', {}, TYPE], ['nfl:main', { search: 'NFL' }, TYPE],
    ['nfl:main', { genre: 'Sports' }, TYPE], ['main', extras, TYPE],
    ['nfl:missing', extras, TYPE], ['nfl:main', { ...extras, skip: '-1' }, TYPE],
    ['nfl:main', { ...extras, skip: '1.5' }, TYPE], ['guide:nfl:main', {}, NATIVE_TYPE],
  ]) assert.deepEqual(await addon.catalog(id, extra, type, 'nfl'), { metas: [] });
  assert.deepEqual(await addon.catalog('guide:main', { date: '2026-09-23' }, NATIVE_TYPE, 'nfl'), { metasDetailed: [] });
  assert.deepEqual(await addon.catalog('guide:nfl:main', { date: '2026-02-30' }, NATIVE_TYPE, 'nfl'), { metasDetailed: [] });
  assert.deepEqual(await addon.catalog('nfl:main', extras), { metas: [] });
  assert.deepEqual(await addon.catalog('guide:nfl:main', { date: '2026-09-23' }, NATIVE_TYPE), { metasDetailed: [] });
  assert.equal(calls, 0);
});

test('NFL profile filters before search and pagination and never exposes labelled VOD', async () => {
  const entries = [];
  for (let i = 0; i < 205; i++) {
    entries.push(entry(`News ${i}`, { group: 'News' }));
    entries.push(entry(`GamePass ${i}`, { group: 'NFL Sunday Ticket' }));
    if (i % 10 === 0) entries.push(entry(`NFL Recorded ${i}`, { duration: 600 }));
  }
  const addon = createAddon(settings(), async () => playlist(...entries));
  const pages = [];
  for (const skip of [0, 100, 200, 205]) pages.push(await addon.catalog('nfl:main', { ...extras, skip: String(skip) }, TYPE, 'nfl'));
  assert.equal(PAGE_SIZE, 100);
  assert.deepEqual(pages.map(p => p.metas.length), [100, 100, 5, 0]);
  assert.deepEqual(pages.flatMap(p => p.metas.map(m => m.name)), Array.from({ length: 205 }, (_, i) => `GamePass ${i}`));
  const search = await addon.catalog('nfl:main', { ...extras, search: ' gAmEpAsS 20 ' }, TYPE, 'nfl');
  assert.deepEqual(search.metas.map(m => m.name), ['GamePass 20', 'GamePass 200', 'GamePass 201', 'GamePass 202', 'GamePass 203', 'GamePass 204']);
  assert.equal((await addon.catalog('nfl:main', { ...extras, search: ' ticket ', skip: '200' }, TYPE, 'nfl')).metas.length, 5);
  assert.deepEqual(await addon.catalog('nfl:main', { ...extras, search: 'News' }, TYPE, 'nfl'), { metas: [] });
});

test('NFL and full channel identities stay disjoint and forged non-NFL or VOD IDs cannot bypass filtering', async () => {
  const config = settings();
  const addon = createAddon(config, async () => mixed);
  const fullBefore = await addon.catalog('main', extras);
  const nfl = await addon.catalog('nfl:main', extras, TYPE, 'nfl');
  assert.deepEqual(nfl.metas.map(m => m.name), ['NFL Network', 'NFL GamePass 01']);
  assert.deepEqual(await addon.catalog('main', extras), fullBefore, 'NFL projection must not mutate shared canonical channels');
  const canonical = fullBefore.metas.find(m => m.name === 'NFL Network');
  const selected = nfl.metas.find(m => m.name === 'NFL Network');
  assert.equal(selected.id, nflId(canonical.id));
  assert.equal(selected.behaviorHints.defaultVideoId, selected.id);
  assert.deepEqual((await addon.meta(selected.id, TYPE, 'nfl')).meta, selected);
  const nflStreams = (await addon.stream(selected.id, TYPE, 'nfl')).streams;
  const fullStreams = (await addon.stream(canonical.id)).streams;
  assert.equal(nflStreams.length, 1);
  assert.equal(nflStreams[0].url, fullStreams[0].url);
  assert.equal(nflStreams[0].title, fullStreams[0].title);
  assert.deepEqual(nflStreams[0].behaviorHints, fullStreams[0].behaviorHints);
  const news = fullBefore.metas.find(m => m.name === 'Local News');
  const recorded = parsePlaylist(playlist(entry('NFL Recorded Game', { id: 'recorded' })), config.sources[0]).channels[0];
  for (const id of [canonical.id, news.id, nflId(news.id), nflId(recorded.id), 'iptv-nfl:unknown:unknown', `${selected.id}:epg:forged`]) {
    assert.deepEqual(await addon.meta(id, TYPE, 'nfl'), { meta: null }, id);
    assert.deepEqual(await addon.stream(id, TYPE, 'nfl'), { streams: [] }, id);
  }
  assert.deepEqual(await addon.meta(selected.id), { meta: null });
  assert.deepEqual(await addon.stream(selected.id), { streams: [] });
  assert.equal((await addon.meta(news.id)).meta.name, 'Local News');
});

test('concurrent full and NFL requests share provider work, TTL and refresh', async () => {
  let now = NOW, calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const addon = createAddon(settings(), async () => { calls++; if (calls === 1) await gate; return mixed; }, () => now);
  const full = addon.catalog('main', extras);
  const nfl = addon.catalog('nfl:main', extras, TYPE, 'nfl');
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
  } finally { release(); }
  const [a, b] = await Promise.all([full, nfl]);
  assert.equal(a.metas.length, 4);
  assert.equal(b.metas.length, 2);
  now += 899999;
  await addon.catalog('nfl:main', extras, TYPE, 'nfl');
  assert.equal(calls, 1);
  now++;
  await addon.catalog('nfl:main', extras, TYPE, 'nfl');
  await addon.catalog('main', extras);
  assert.equal(calls, 2);
  addon.refresh();
  await addon.catalog('main', extras);
  await addon.catalog('nfl:main', extras, TYPE, 'nfl');
  assert.equal(calls, 3);
});

test('NFL native guide shares full canonical XMLTV cache and uses NFL channel and programme identities', async () => {
  let playlistCalls = 0, guideCalls = 0;
  const addon = createAddon(settings([GUIDE_SOURCE]), async () => { playlistCalls++; return mixed; }, () => NOW,
    async () => { guideCalls++; return guide; });
  const noDate = await addon.catalog('guide:nfl:main', extras, NATIVE_TYPE, 'nfl');
  assert.equal(noDate.metas.length, 2);
  assert.ok(noDate.metas.every(m => m.type === NATIVE_TYPE && m.videos === undefined));
  assert.equal(guideCalls, 0);
  const nfl = await addon.catalog('guide:nfl:main', { date: '2026-09-23' }, NATIVE_TYPE, 'nfl');
  assert.deepEqual(nfl.metasDetailed.map(m => m.name), ['NFL Network', 'NFL GamePass 01']);
  const full = await addon.catalog('guide:main', { date: '2026-09-23' }, NATIVE_TYPE);
  assert.equal(full.metasDetailed.find(m => m.name === 'Local News').videos[0].title, 'Midday news',
    'NFL-first requests must not narrow the shared guide channel allowlist');
  const channel = nfl.metasDetailed[0];
  const canonical = full.metasDetailed.find(m => m.name === channel.name);
  assert.equal(channel.behaviorHints.defaultVideoId, channel.id);
  assert.equal(channel.behaviorHints.hasScheduledVideos, true);
  assert.equal(channel.videos[0].released, '2026-09-23T11:00:00.000Z');
  assert.equal(channel.videos[0].startTime, '2026-09-23T11:00:00.000Z');
  assert.equal(channel.videos[0].endTime, '2026-09-23T13:00:00.000Z');
  assert.ok(channel.videos[0].id.startsWith(`${channel.id}:epg:`));
  assert.notEqual(channel.videos[0].id, canonical.videos[0].id);
  assert.equal((await addon.meta(channel.id, NATIVE_TYPE, 'nfl')).meta.videos[0].id, channel.videos[0].id);
  assert.equal((await addon.stream(channel.id, NATIVE_TYPE, 'nfl')).streams.length, 1);
  assert.deepEqual(await addon.stream(channel.videos[0].id, NATIVE_TYPE, 'nfl'), { streams: [] });
  assert.deepEqual(await addon.catalog('guide:nfl:main', { date: '2026-09-23', skip: '2' }, NATIVE_TYPE, 'nfl'), { metasDetailed: [] });
  assert.equal((await addon.meta(channel.id, TYPE, 'nfl')).meta.videos, undefined);
  assert.equal(playlistCalls, 1);
  assert.equal(guideCalls, 1);
});

test('guide failure still returns only playable NFL live channels without invented schedules', async () => {
  const addon = createAddon(settings([GUIDE_SOURCE]), async () => mixed, () => NOW,
    async () => { throw new Error('Provider secret must stay hidden'); });
  const result = await addon.catalog('guide:nfl:main', { date: '2026-09-23' }, NATIVE_TYPE, 'nfl');
  assert.equal(result.metasDetailed.length, 2);
  assert.ok(result.metasDetailed.every(m => m.videos.length === 0));
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.equal((await addon.stream(result.metasDetailed[0].id, NATIVE_TYPE, 'nfl')).streams.length, 1);
});

test('a source with no matching NFL channels stays empty and does not fetch a pointless guide', async () => {
  let guideCalls = 0;
  const addon = createAddon(settings([GUIDE_SOURCE]), async () => playlist(entry('Local News')), () => NOW,
    async () => { guideCalls++; return guide; });
  assert.deepEqual(await addon.catalog('nfl:main', extras, TYPE, 'nfl'), { metas: [] });
  assert.deepEqual(await addon.catalog('guide:nfl:main', { date: '2026-09-23' }, NATIVE_TYPE, 'nfl'), { metasDetailed: [] });
  assert.equal(guideCalls, 0);
  assert.equal((await addon.catalog('main', extras)).metas[0].name, 'Local News');
});

test('HTTP NFL profile preserves authentication, legacy routes, native EPG and profile boundaries', async () => {
  const config = settings([GUIDE_SOURCE]);
  const addon = createAddon(config, async () => mixed, () => NOW, async () => guide);
  const server = createServer(config, addon);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = `${base}/addon/${TOKEN}`;
  const get = async path => {
    const response = await fetch(root + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  };
  try {
    assert.equal((await get('/manifest.json')).id, 'community.stremio.live-tv');
    assert.equal((await get('/nfl/manifest.json')).id, 'community.stremio.live-tv.nfl');
    assert.equal((await fetch(`${base}/addon/wrong/nfl/manifest.json`)).status, 404);
    assert.equal((await fetch(`${base}/nfl/manifest.json`)).status, 404);
    const full = await get('/catalog/Live%20TV/main/genre=All%20channels.json');
    const nfl = await get('/nfl/catalog/Live%20TV/nfl%3Amain/genre=All%20channels.json');
    assert.equal(full.metas.length, 4);
    assert.equal(nfl.metas.length, 2);
    const id = encodeURIComponent(nfl.metas[0].id);
    const fullId = encodeURIComponent(full.metas[0].id);
    assert.equal((await get(`/nfl/meta/Live%20TV/${id}.json`)).meta.id, nfl.metas[0].id);
    assert.equal((await get(`/nfl/stream/Live%20TV/${id}.json`)).streams.length, 1);
    assert.deepEqual(await get(`/nfl/meta/Live%20TV/${fullId}.json`), { meta: null, cacheMaxAge: 0, staleRevalidate: 0, staleError: 0 });
    assert.equal((await get(`/meta/Live%20TV/${id}.json`)).meta, null);
    assert.deepEqual((await get('/nfl/catalog/Live%20TV/nfl%3Amain.json')).metas, []);
    assert.deepEqual((await get('/nfl/catalog/Live%20TV/main/genre=All%20channels.json')).metas, []);
    const native = await get('/nfl/catalog/tv/guide%3Anfl%3Amain/genre=All%20channels&date=2026-09-23.json');
    assert.equal(native.metasDetailed.length, 2);
    assert.equal(native.metasDetailed[0].videos[0].title, 'NFL pregame');
    assert.equal((await get(`/nfl/meta/tv/${id}.json`)).meta.behaviorHints.defaultVideoId, nfl.metas[0].id);
    assert.equal((await get(`/nfl/stream/tv/${id}.json`)).streams.length, 1);
    assert.deepEqual((await get('/nfl/catalog/tv/guide%3Anfl%3Amain.json')).metas, []);
    assert.deepEqual((await get('/nfl/catalog/movie/nfl%3Amain/genre=All%20channels.json')).metas, []);
    assert.equal((await get(`/nfl/meta/movie/${id}.json`)).meta, null);
    assert.deepEqual((await get(`/nfl/stream/movie/${id}.json`)).streams, []);
    assert.doesNotMatch(JSON.stringify({ full, nfl, native }), /provider\.example|stream\.example|channels\.m3u/);
  } finally {
    server.closeIdleConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
