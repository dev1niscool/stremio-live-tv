import test from 'node:test';
import assert from 'node:assert/strict';
import { isNflChannel } from '../src/nfl.mjs';
import { parsePlaylist } from '../src/playlist.mjs';

test('includes explicit NFL networks and numbered event feeds', () => {
  for (const name of ['NFL Network', 'NFL RedZone', 'NFL01', 'NFL16 | Event', 'US: NFL 01 HD', 'Sky Sports NFL/ACTION']) {
    assert.equal(isNflChannel({ name, group: 'USA | Sports' }), true, name);
  }
});

test('NFL-specific groups include generic or unnamed event slots', () => {
  for (const group of ['USA | NFL', 'USA | NFL Game Pass', 'NFL Game Pass | International']) {
    for (const name of ['01', 'Event 12', 'No event scheduled', '']) {
      assert.equal(isNflChannel({ name, group }), true, `${group}: ${name}`);
    }
  }
});

test('recognizes RedZone, Sunday Ticket and the full league name in either field', () => {
  for (const signal of ['RedZone', 'Red Zone', 'NFL Sunday Ticket', 'Sunday Ticket 08', 'National Football League']) {
    assert.equal(isNflChannel({ name: signal, group: 'Sports' }), true, signal);
    assert.equal(isNflChannel({ name: 'Event slot', group: signal }), true, signal);
  }
});

test('normalizes compatibility characters and uses Unicode-aware token boundaries', () => {
  for (const name of ['ＮＦＬ０１', 'ＮＦＬ Network', 'nFl network', '🇺🇸 [NFL] HD', 'Sunday—Ticket', 'Red_Zone']) {
    assert.equal(isNflChannel({ name }), true, name);
  }
  for (const name of ['Inflight Entertainment', 'Conflict TV', 'NFLIX', 'ANFL01', 'NFL01Extra', 'RedZoneSports', 'Sunday Ticketing', 'éNFL', 'NFL東京']) {
    assert.equal(isNflChannel({ name }), false, name);
  }
});

test('excludes the provider NFL Teams affiliate group regardless of channel name', () => {
  for (const group of ['USA | NFL Teams', 'USA | ＮＦＬ Ｔｅａｍｓ', 'NFL-Teams', 'NFL Teams | Local']) {
    for (const name of ['NFL Teams: FOX Cowboys (KDFW) Dallas TX', 'NFL Teams: CBS Local', 'NFL Teams: NBC Local', 'NFL Teams: ABC Local', 'NFL Network', 'RedZone']) {
      assert.equal(isNflChannel({ name, group }), false, `${group}: ${name}`);
    }
  }
});

test('generic football, game passes and broadcast networks do not imply NFL coverage', () => {
  for (const signal of ['Football', 'Football HD', 'Game Pass', 'NBA League Pass', 'ESPN', 'FOX', 'CBS', 'NBC', 'ABC', 'USA | Sports', 'College Football', 'Premier League']) {
    assert.equal(isNflChannel({ name: signal, group: 'USA' }), false, signal);
    assert.equal(isNflChannel({ name: 'Event 01', group: signal }), false, signal);
  }
});

test('explicit NFL feed labeling is accepted even when a network also carries other sports', () => {
  assert.equal(isNflChannel({ name: 'Sky Sports NFL/ACTION', group: 'UK | Sports' }), true);
  assert.equal(isNflChannel({ name: 'FOX', group: 'USA | NFL' }), true);
  assert.equal(isNflChannel({ name: 'FOX', group: 'USA | Networks' }), false);
});

test('missing or malformed labels do not become matching signals', () => {
  for (const value of [null, undefined, {}, { name: null, group: null }, { name: 123 }, { group: ['NFL'] }]) {
    assert.equal(isNflChannel(value), false);
  }
});

test('applying the NFL filter after the live parser retains no NFL-labeled VOD or broad affiliates', () => {
  const text = '#EXTM3U\n'
    + '#EXTINF:-1 group-title="USA | NFL",NFL01\nhttps://stream.example.test/live/one.ts\n'
    + '#EXTINF:-1 group-title="USA | NFL Game Pass",Event 02\nhttps://stream.example.test/live/two.ts\n'
    + '#EXTINF:3600 group-title="USA | NFL",NFL Replay\nhttps://stream.example.test/live/replay.ts\n'
    + '#EXTINF:-1 group-title="Movies",NFL Documentary\nhttps://stream.example.test/movie/documentary.mp4\n'
    + '#EXTINF:-1 group-title="USA | NFL Teams",NFL Teams: FOX Cowboys (KDFW) Dallas TX\nhttps://stream.example.test/live/fox.ts\n'
    + '#EXTINF:-1 group-title="USA | Sports",ESPN\nhttps://stream.example.test/live/espn.ts\n';
  const { channels, stats } = parsePlaylist(text, { id: 'synthetic', name: 'Synthetic list', url: 'https://lists.example.test/channels.m3u' });
  assert.equal(stats.excludedVod, 2);
  assert.deepEqual(channels.filter(isNflChannel).map(({ name }) => name), ['NFL01', 'Event 02']);
});
