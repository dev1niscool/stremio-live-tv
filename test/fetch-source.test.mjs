import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchSource } from '../src/fetch-source.mjs';
import { parsePlaylist } from '../src/playlist.mjs';

const source = { id: 'example', name: 'Account', url: 'https://provider.example/prefix/get.php?username=TestUser&password=private-password&type=m3u_plus', headers: { Authorization: 'Bearer private-auth' } };
const live = (changes = {}) => ({ stream_type: 'live', stream_id: 101, name: 'News', epg_channel_id: 'news.example', category_id: '7', stream_icon: 'https://images.example/news.png', ...changes });
const categories = [{ category_id: '7', category_name: 'US | News' }];
function fake(replies) {
  const calls = [];
  const fetcher = async (input, options) => {
    calls.push({ source: input, options });
    const result = replies.shift();
    assert.notEqual(result, undefined, 'Unexpected request');
    if (result instanceof Error) throw result;
    return { text: typeof result === 'string' ? result : JSON.stringify(result), url: input.url };
  };
  return { calls, fetcher };
}

test('uses same-origin sibling live API endpoints and builds parser-compatible live channels', async () => {
  const { calls, fetcher } = fake([[live()], categories]);
  const result = await fetchSource(source, fetcher);
  assert.equal(result.url, source.url);
  assert.deepEqual(calls.map(call => new URL(call.source.url).searchParams.get('action')), ['get_live_streams', 'get_live_categories']);
  for (const call of calls) {
    const endpoint = new URL(call.source.url);
    assert.equal(endpoint.origin, 'https://provider.example');
    assert.equal(endpoint.pathname, '/prefix/player_api.php');
    assert.equal(endpoint.searchParams.get('username'), 'TestUser');
    assert.equal(endpoint.searchParams.get('password'), 'private-password');
    assert.deepEqual(call.source.headers, source.headers);
    assert.equal(call.options.maxBytes, 25 * 1024 * 1024);
  }
  const parsed = parsePlaylist(result.text, source);
  assert.equal(parsed.stats.accepted, 1);
  assert.equal(parsed.channels[0].tvgId, 'news.example');
  assert.equal(parsed.channels[0].group, 'US | News');
  assert.equal(parsed.channels[0].url, 'https://provider.example/prefix/live/TestUser/private-password/101.ts');
});

test('keeps only explicit live records and preserves conflicting VOD evidence', async () => {
  const { fetcher } = fake([[
    live(), live({ stream_id: 102, stream_type: 'created_live' }), live({ stream_id: 103, stream_type: 'movie' }),
    live({ stream_id: 104, stream_type: undefined }), live({ stream_id: 105, type: 'vod' }),
    live({ stream_id: 106, content_type: 'series' }), live({ stream_id: 107, container_extension: 'mp4' }),
    live({ stream_id: 108, direct_source: 'https://provider.example/movie/user/pass/108.ts' }),
    live({ stream_id: 109, direct_source: 'https://provider.example/play?type=vod' }),
    live({ stream_id: 110, name: 'Show S01E03' }), live({ stream_id: 111, category_id: '8' }),
  ], [...categories, { category_id: '8', category_name: 'VOD Movies' }]]);
  const result = await fetchSource(source, fetcher);
  const parsed = parsePlaylist(result.text, source);
  assert.equal(parsed.stats.accepted, 1);
  assert.equal(parsed.channels[0].name, 'News');
  assert.ok(parsed.stats.excludedVod >= 4);
});

test('selectors, duplicate credentials, unknown params and unsupported formats retain original M3U scope', async () => {
  for (const suffix of ['&category_id=7', '&group=Sports', '&action=get_vod_streams', '&username=Other', '&output=mp4', '&token=secret']) {
    const input = { ...source, url: source.url + suffix };
    const { calls, fetcher } = fake(['#EXTM3U\n']);
    assert.equal((await fetchSource(input, fetcher)).text, '#EXTM3U\n');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].source.url, input.url);
  }
  const input = { ...source, url: 'https://provider.example/list.m3u' };
  const { calls, fetcher } = fake(['#EXTM3U\n']);
  await fetchSource(input, fetcher);
  assert.equal(calls[0].source.url, input.url);
});

test('encodes path credentials, respects requested m3u8 output, and ignores unsafe stream IDs', async () => {
  const input = { ...source, url: 'https://provider.example/prefix/get.php?username=user%2Fname&password=p%3Fa%23ss&output=m3u8' };
  const { fetcher } = fake([[
    live(), ...['../movie/3', '2.ts?type=vod', '-1', 1.5, 0, '1\n#EXTINF', '9999999999999999'].map(stream_id => live({ stream_id })),
  ], categories]);
  const result = await fetchSource(input, fetcher);
  const parsed = parsePlaylist(result.text, input);
  assert.equal(parsed.stats.accepted, 1);
  assert.equal(parsed.channels[0].url, 'https://provider.example/prefix/live/user%2Fname/p%3Fa%23ss/101.m3u8');
});

test('metadata cannot inject extra playlist entries and Unicode/quotes survive', async () => {
  const { fetcher } = fake([[live({ name: 'Café "News"\n#EXTINF:500,Fake', epg_channel_id: 'news"special', stream_icon: 'https://images.example/news.png\nhttps://bad.example/movie.mp4' })], categories]);
  const result = await fetchSource(source, fetcher);
  const parsed = parsePlaylist(result.text, source);
  assert.equal(parsed.stats.totalEntries, 1);
  assert.equal(parsed.stats.accepted, 1);
  assert.equal(parsed.channels[0].tvgId, 'news"special');
  assert.equal(parsed.channels[0].logo, '');
  assert.ok(parsed.channels[0].name.startsWith('Café "News"'));
});

test('live API failure falls back once to the original M3U', async () => {
  for (const failure of [new Error('private-password'), '{bad json', { user_info: { auth: 0 } }]) {
    const { calls, fetcher } = fake([failure, '#EXTM3U\n']);
    assert.equal((await fetchSource(source, fetcher)).text, '#EXTM3U\n');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].source.url, source.url);
    assert.equal(calls[1].options.timeoutMs, 20000);
  }
});

test('optional categories fail softly unless named exclusions require the original groups', async () => {
  const first = fake([[live()], new Error('Categories unavailable')]);
  const result = await fetchSource(source, first.fetcher);
  assert.equal(parsePlaylist(result.text, source).stats.accepted, 1);
  assert.equal(first.calls[1].options.timeoutMs, 5000);
  const input = { ...source, excludeGroups: ['Unwanted'] };
  const second = fake([[live()], new Error('Categories unavailable'), '#EXTM3U\n']);
  await fetchSource(input, second.fetcher);
  assert.equal(second.calls.at(-1).source.url, source.url);
});

test('empty API lists do not fabricate channels or perform VOD/stream requests', async () => {
  const { calls, fetcher } = fake([[], []]);
  const result = await fetchSource(source, fetcher);
  assert.equal(result.text, '#EXTM3U\n');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => /^get_live_(?:streams|categories)$/.test(new URL(call.source.url).searchParams.get('action'))));
});

test('fallback retains final M3U URL and all failures are credential-safe', async () => {
  const input = { ...source, url: 'https://provider.example/list.m3u' };
  const result = await fetchSource(input, async () => ({ text: '#EXTM3U', url: 'https://cdn.example/new/list.m3u' }));
  assert.equal(result.url, 'https://cdn.example/new/list.m3u');
  await assert.rejects(fetchSource(source, async () => { throw new Error('https://user:private-password@provider.example?secret=private-auth'); }), error => {
    assert.equal(error.name, 'SourceFetchError');
    assert.equal(error.cause, undefined);
    assert.ok(!/private-password|private-auth|provider\.example/.test(error.stack));
    return true;
  });
});

test('oversized API bodies and generated playlists stay within download bounds', async () => {
  const oversized = ' '.repeat(25 * 1024 * 1024 + 1);
  const { calls, fetcher } = fake([oversized, '#EXTM3U\n']);
  await fetchSource(source, fetcher);
  assert.equal(calls.length, 2);
  const records = Array.from({ length: 15000 }, (_, index) => live({ stream_id: index + 1 }));
  const longCredentials = { ...source, url: 'https://provider.example/get.php?username=' + 'u'.repeat(1000) + '&password=' + 'p'.repeat(1000) };
  const second = fake([records, categories, '#EXTM3U\n']);
  assert.equal((await fetchSource(longCredentials, second.fetcher)).text, '#EXTM3U\n');
  assert.equal(second.calls.length, 3);
  assert.equal(second.calls.at(-1).source.url, longCredentials.url);
});
