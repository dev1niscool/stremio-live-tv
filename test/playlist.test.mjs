import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaylist } from '../src/playlist.mjs';

const source = { id: 'demo', name: 'Demo', url: 'https://example.test/lists/main.m3u' };
const parse = (body, overrides = {}) => parsePlaylist(`#EXTM3U\n${body}`, { ...source, ...overrides });

test('parses BOM, CRLF, quoted commas, relative logos/streams and playback headers', () => {
  const result = parsePlaylist('\uFEFF#EXTM3U\r\n'
    + '#EXTINF:-1 tvg-id="news.1" tvg-logo="../logos/news.png" group-title="News, Local",News, 24\r\n'
    + '#EXTVLCOPT:http-user-agent=Player 1\r\n'
    + '#EXTVLCOPT:http-referrer=https://player.example.test/\r\n'
    + '../live/news.m3u8|User-Agent=Player%202&Origin=https%3A%2F%2Fplayer.example.test\r\n', source);
  assert.equal(result.channels.length, 1);
  assert.match(result.channels[0].id, /^iptv:demo:[a-f0-9]{24}$/);
  assert.deepEqual({ ...result.channels[0], id: '' }, {
    id: '', name: 'News, 24', group: 'News, Local',
    logo: 'https://example.test/logos/news.png',
    url: 'https://example.test/live/news.m3u8',
    headers: { 'User-Agent': 'Player 2', Referer: 'https://player.example.test/', Origin: 'https://player.example.test' },
  });
  assert.equal(result.stats.accepted, 1);
});

test('does not mistake a bare .m3u8, .ts, tvg-id or nonpositive duration for live proof', () => {
  const result = parse('#EXTINF:-1 tvg-id="one",One\nhttps://example.test/one.m3u8\n'
    + '#EXTINF:0,Two\nhttps://example.test/two.ts\n'
    + '#EXTINF:-1 group-title="USA",Three\nhttps://example.test/stream/three\n');
  assert.equal(result.channels.length, 0);
  assert.equal(result.stats.excludedUnknown, 3);
});

test('accepts affirmative live path, query, metadata and live group signals', () => {
  const result = parse('#EXTINF:-1,One\nhttps://example.test/live/one.ts\n'
    + '#EXTINF:0,Two\nhttps://example.test/stream?id=2&type=live\n'
    + '#EXTINF:-1 tvg-type="live",Three\nhttps://example.test/stream/3\n'
    + '#EXTINF:-1 group-title="⚽ Deportes",Four\nhttps://example.test/stream/4\n'
    + '#EXTINF:-1 group-title="بث مباشر",Five\nhttps://example.test/stream/5\n');
  assert.equal(result.channels.length, 5);
});

test('positive durations, VOD formats and on-demand URLs override live labels', () => {
  const result = parse('#EXTINF:120 group-title="Live TV",Clip\nhttps://example.test/live/clip\n'
    + '#EXTINF:-1 group-title="News",Film\nhttps://example.test/movie/account/123.m3u8\n'
    + '#EXTINF:-1 group-title="Sports",Series\nhttps://example.test/%73eries/account/123.ts\n'
    + '#EXTINF:-1 group-title="Live TV",MP4\nhttps://example.test/live/asset.MP4?token=example\n'
    + '#EXTINF:-1 group-title="Live TV",Query\nhttps://example.test/live/asset?type=vod\n'
    + '#EXTINF:-1 group-title="Live TV",Action\nhttps://example.test/api?action=get_vod_streams\n'
    + '#EXTINF:-1 group-title="Live TV" media-type="movie",Meta\nhttps://example.test/live/meta\n');
  assert.equal(result.channels.length, 0);
  assert.equal(result.stats.excludedVod, 7);
});

test('decorated and multilingual VOD groups and episode titles are excluded', () => {
  const groups = ['★★ VOD ★★', 'US | MOVIES', 'FR • Cinéma', 'ES • Películas', 'BR | Séries',
    'DE | Filme', 'RU | Фильмы', '中文电影', 'أفلام', 'TR | Diziler'];
  const body = groups.map((group, i) => `#EXTINF:-1 group-title="${group}",Channel ${i}\nhttps://example.test/live/${i}`).join('\n')
    + '\n#EXTINF:-1 group-title="Live TV",A show S02E03\nhttps://example.test/live/episode\n'
    + '#EXTINF:-1 group-title="Live TV",A show 2x03\nhttps://example.test/live/episode2\n';
  const result = parse(body);
  assert.equal(result.channels.length, 0);
  assert.equal(result.stats.excludedVod, groups.length + 2);
});

test('owner-confirmed groups admit ambiguous live streams without overriding VOD evidence', () => {
  const result = parse('#EXTINF:-1 group-title="USA",One\nhttps://example.test/one.m3u8\n'
    + '#EXTINF:-1 group-title="USA",Film\nhttps://example.test/movie/2\n'
    + '#EXTINF:99 group-title="USA",Clip\nhttps://example.test/three.ts\n'
    + '#EXTINF:-1 group-title="USA Movies",Movie\nhttps://example.test/live/four\n'
    + '#EXTINF:-1 group-title="News",Five\nhttps://example.test/live/five\n',
  { includeGroups: [' usa ', 'USA Movies'] });
  assert.deepEqual(result.channels.map((channel) => channel.name), ['One']);
  assert.equal(result.stats.excludedVod, 3);
  assert.equal(result.stats.excludedGroups, 1);
});

test('excludeGroups has priority and group filters use complete names', () => {
  const result = parse('#EXTINF:-1 group-title="News",One\nhttps://example.test/live/1\n'
    + '#EXTINF:-1 group-title="News Local",Two\nhttps://example.test/live/2\n'
    + '#EXTINF:-1 group-title="Sports",Three\nhttps://example.test/live/3\n',
  { includeGroups: ['News', 'Sports'], excludeGroups: ['sports'] });
  assert.deepEqual(result.channels.map((channel) => channel.name), ['One']);
  assert.equal(result.stats.excludedGroups, 2);
});

test('Ungrouped confirmation covers streams lacking a group without admitting VOD handlers', () => {
  const result = parse('#EXTINF:-1,One\nhttps://example.test/one.m3u8\n'
    + '#EXTINF:-1,Movie\nhttps://example.test/movie.php?id=2\n', { includeGroups: ['Ungrouped'] });
  assert.equal(result.channels.length, 1);
  assert.equal(result.channels[0].group, 'Ungrouped');
  assert.equal(result.stats.excludedVod, 1);
  assert.equal(parse('#EXTINF:-1,One\nhttps://example.test/live/one\n',
    { excludeGroups: ['Ungrouped'] }).stats.excludedGroups, 1);
});

test('EXTGRP supplies groups and explicit group-title remains authoritative', () => {
  const result = parse('#EXTGRP:News\n#EXTINF:-1,One\nhttps://example.test/one\n'
    + '#EXTINF:-1,Two\n#EXTGRP:Sports\nhttps://example.test/two\n'
    + '#EXTINF:-1 group-title="Movies",Three\n#EXTGRP:News\nhttps://example.test/live/three\n');
  assert.deepEqual(result.channels.map((channel) => channel.group), ['News', 'Sports']);
  assert.equal(result.stats.excludedVod, 1);
});

test('channel IDs survive token rotation; duplicate identities/URLs collapse', () => {
  const first = parse('#EXTINF:-1 tvg-id="shared" group-title="News",One\nhttps://example.test/live/1?token=old\n'
    + '#EXTINF:-1 tvg-id="shared" group-title="News",One\nhttps://example.test/live/1?token=new\n'
    + '#EXTINF:-1 tvg-id="shared" group-title="News",Two\nhttps://example.test/live/2\n'
    + '#EXTINF:-1 tvg-id="other" group-title="News",Duplicate\nhttps://example.test/live/2\n');
  const refreshed = parse('#EXTINF:-1 tvg-id="shared" group-title="News",One\nhttps://example.test/live/1?token=refreshed\n');
  assert.equal(first.channels.length, 2);
  assert.equal(first.stats.duplicates, 2);
  assert.equal(first.channels[0].id, refreshed.channels[0].id);
  assert.notEqual(first.channels[0].id, first.channels[1].id);
  const otherSource = parse('#EXTINF:-1 tvg-id="shared" group-title="News",One\nhttps://example.test/live/1\n', { id: 'second' });
  assert.notEqual(first.channels[0].id, otherSource.channels[0].id);
});

test('unsupported schemes and missing URL entries are counted, not exposed', () => {
  const result = parse('#EXTINF:-1 group-title="News",Local\nfile:///etc/example\n'
    + '#EXTINF:-1 group-title="News",Script\njavascript:example\n'
    + '#EXTINF:-1 group-title="News",Missing\n'
    + '#EXTINF:-1 group-title="News",Trailing\n');
  assert.equal(result.channels.length, 0);
  assert.equal(result.stats.totalEntries, 4);
  assert.equal(result.stats.invalidUrls, 4);
});

test('HLS media and master playlists are never interpreted as channel catalogs', () => {
  for (const body of ['#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nsegment.ts',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000\nlive/stream.m3u8']) {
    const result = parse(body);
    assert.equal(result.channels.length, 0);
    assert.equal(result.stats.invalidPlaylist, true);
  }
  assert.equal(parsePlaylist('<html>upstream error</html>', source).stats.invalidPlaylist, true);
});

test('header injection and unsupported header names are dropped', () => {
  const result = parse('#EXTINF:-1 group-title="News",One\n'
    + 'https://example.test/live/one|User-Agent=OK%0D%0AX-Test%3Aevil&Host=evil.example.test&Referer=https%3A%2F%2Fplayer.example.test');
  assert.deepEqual(result.channels[0].headers, { Referer: 'https://player.example.test' });
});

test('malformed durations fail closed, even in confirmed-live groups', () => {
  const result = parse('#EXTINF:unknown group-title="USA",One\nhttps://example.test/live/one\n'
    + '#EXTINF:-2 group-title="USA",Two\nhttps://example.test/live/two\n', { includeGroups: ['USA'] });
  assert.equal(result.channels.length, 0);
  assert.equal(result.stats.excludedUnknown, 2);
});

test('single-quoted metadata and tvg-name fallback parse without leaking controls', () => {
  const result = parse("#EXTINF:-1 group-title='News, Local' tvg-name='Fallback, Station' tvg-logo='javascript:example',\n"
    + 'https://example.test/live/one');
  assert.equal(result.channels[0].name, 'Fallback, Station');
  assert.equal(result.channels[0].group, 'News, Local');
  assert.equal(result.channels[0].logo, '');
});
