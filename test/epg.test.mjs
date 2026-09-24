import assert from 'node:assert/strict';
import test from 'node:test';
import { parseXmltv, playlistEpgUrls, programmesForDay } from '../src/epg.mjs';

const nowMs = Date.parse('2026-09-24T12:00:00Z');
const options = { channelIds: new Set(['live-one', 'live-two']), nowMs };
const programme = (attributes, body = '<title>News</title>') => `<programme ${attributes}>${body}</programme>`;
const guide = (...items) => `<?xml version="1.0" encoding="UTF-8"?><tv>${items.join('')}</tv>`;
const slot = (channel = 'live-one', start = '20260924120000 +0000', stop = '20260924130000 +0000', title = 'News') =>
  programme(`channel="${channel}" start="${start}" stop="${stop}"`, `<title>${title}</title>`);

test('matches only exact allowed live tvg-id values and never display names or VOD IDs', () => {
  const result = parseXmltv(guide(
    '<channel id="vod-one"><display-name>live-one</display-name></channel>',
    slot(), slot('live-two'), slot('vod-one'), slot('Live-one'), slot(' live-one '),
  ), options);
  assert.equal(result.count, 2);
  assert.deepEqual([...result.programmes.keys()], ['live-one', 'live-two']);
  assert.equal(parseXmltv(guide(slot()), { nowMs }).count, 0);
});

test('preserves Unicode, CDATA and built-in/numeric XML entities', () => {
  const result = parseXmltv(guide(programme(
    'channel="live-one" start="202609241200" stop="202609241300"',
    '<title> Café &amp; météo &#x1F4FA; </title><desc><![CDATA[<Live> 世界]]> &quot;today&quot; &apos;yes&apos;\n next</desc>',
  )), options);
  assert.deepEqual(result.programmes.get('live-one')[0], {
    title: 'Café & météo 📺', overview: '<Live> 世界 "today" \'yes\' next',
    startTime: '2026-09-24T12:00:00.000Z', endTime: '2026-09-24T13:00:00.000Z', released: '2026-09-24T12:00:00.000Z',
  });
});

test('uses the first nonempty title/description without fetching metadata URLs', () => {
  const result = parseXmltv(guide(programme(
    'channel="live-one" start="20260924120000" stop="20260924130000"',
    '<title> </title><title lang="es">Noticias</title><title lang="en">News</title><desc>Actual report</desc><desc>Other</desc><icon src="http://127.0.0.1/secret"/><url>file:///secret</url>',
  )), options);
  assert.equal(result.programmes.get('live-one')[0].title, 'Noticias');
  assert.equal(result.programmes.get('live-one')[0].overview, 'Actual report');
  assert.ok(!JSON.stringify(result.programmes.get('live-one')).includes('secret'));
});

test('converts numeric timezone offsets and assumes UTC when no zone is supplied', () => {
  const result = parseXmltv(guide(
    slot('live-one', '20260924143000 +0230', '20260924153000 +0230', 'East'),
    slot('live-one', '20260924073000 -0430', '20260924083000 -0430', 'West'),
    slot('live-one', '202609241200', '202609241300', 'UTC default'),
    slot('live-one', '20260924120000 UTC', '20260924130000 GMT', 'UTC names'),
  ), options);
  assert.equal(result.count, 4);
  for (const item of result.programmes.get('live-one')) {
    assert.equal(item.startTime, '2026-09-24T12:00:00.000Z');
    assert.equal(item.endTime, '2026-09-24T13:00:00.000Z');
  }
});

test('uses explicit DST offsets instead of host timezone or ambiguous local time', () => {
  const result = parseXmltv(guide(
    slot('live-one', '20261101013000 -0400', '20261101013000 -0500'),
  ), { ...options, nowMs: Date.parse('2026-11-01T12:00:00Z') });
  const item = result.programmes.get('live-one')[0];
  assert.equal(item.startTime, '2026-11-01T05:30:00.000Z');
  assert.equal(item.endTime, '2026-11-01T06:30:00.000Z');
});

test('skips impossible dates/times, incomplete times and missing or reversed slots', () => {
  const items = [
    ...['20260230120000', '20261301120000', '20260924126000', '20260924250000', '20260924120060',
      '20260924', '20260924120000 +2500', '20260924120000 +1260', '20260924120000 CST', 'not-a-date']
      .map(start => slot('live-one', start)),
    slot('live-one', '20260924120000', '20260924110000'),
    slot('live-one', '20260924120000', '20260924120000'),
    programme('channel="live-one" start="20260924120000"'),
    programme('channel="live-one" stop="20260924130000"'),
    programme('channel="live-one" start="20260924120000" stop="20260924130000"', '<desc>No title</desc>'),
    slot(),
  ];
  const result = parseXmltv(guide(...items), options);
  assert.equal(result.count, 1);
});

test('supports valid leap-day programmes and rejects invalid leap days', () => {
  const parsed = parseXmltv(guide(slot('live-one', '20240229120000', '20240229130000')), {
    ...options, nowMs: Date.parse('2024-02-29T00:00:00Z'),
  });
  assert.equal(parsed.count, 1);
  assert.equal(parseXmltv(guide(slot('live-one', '20260229120000', '20260229130000')), {
    ...options, nowMs: Date.parse('2026-02-28T00:00:00Z'),
  }).count, 0);
});

test('keeps whole UTC days in the requested window and excludes nonoverlapping intervals', () => {
  const result = parseXmltv(guide(
    slot('live-one', '20260922230000', '20260923000000', 'Ends at left boundary'),
    slot('live-one', '20260922233000', '20260923003000', 'Crosses left boundary'),
    slot('live-one', '20261001233000', '20261002003000', 'Crosses right boundary'),
    slot('live-one', '20261002000000', '20261002010000', 'Starts at right boundary'),
    slot(),
  ), options);
  assert.deepEqual(result.programmes.get('live-one').map(p => p.title), ['Crosses left boundary', 'News', 'Crosses right boundary']);
});

test('day selection includes overnight programmes and follows half-open interval boundaries', () => {
  const result = parseXmltv(guide(
    slot('live-one', '20260923230000', '20260924000000', 'Yesterday'),
    slot('live-one', '20260923233000', '20260924003000', 'Overnight'),
    slot('live-one', '20260924233000', '20260925003000', 'Late'),
    slot('live-one', '20260925000000', '20260925010000', 'Tomorrow'),
  ), options);
  const list = result.programmes.get('live-one');
  assert.deepEqual(programmesForDay(list, '2026-09-24').map(p => p.title), ['Overnight', 'Late']);
  assert.deepEqual(programmesForDay(list, '2026-09-25').map(p => p.title), ['Late', 'Tomorrow']);
  assert.equal(programmesForDay([], '2024-02-29').length, 0);
  for (const invalid of ['2026-02-29', '2026-13-01', '2026-09-31', '2026-9-24', '2026-09-24T00:00:00Z', '0000-01-01']) {
    assert.throws(() => programmesForDay(list, invalid), { code: 'INVALID_OPTIONS' });
  }
});

test('sorts schedules and removes exact duplicate slots without collapsing distinct titles', () => {
  const result = parseXmltv(guide(
    slot('live-one', '20260924140000', '20260924150000', 'Later'),
    slot(), slot(), slot('live-one', '20260924120000', '20260924130000', 'Weather'),
  ), options);
  assert.equal(result.count, 3);
  assert.deepEqual(result.programmes.get('live-one').map(p => p.title), ['News', 'Weather', 'Later']);
});

test('accepts external-only XMLTV DOCTYPE as inert metadata, never loading its target', () => {
  for (const location of ['xmltv.dtd', 'https://example.test/xmltv.dtd', 'http://169.254.169.254/private-token']) {
    const result = parseXmltv(`<!DOCTYPE tv SYSTEM "${location}"><tv>${slot()}</tv>`, options);
    assert.equal(result.count, 1);
  }
});

test('rejects internal DTD subsets, custom entities and malformed documents without leaking input', () => {
  const inputs = [
    '<!DOCTYPE tv [<!ENTITY secret SYSTEM "file:///private-token">]><tv>&secret;</tv>',
    '<!DOCTYPE tv SYSTEM "xmltv.dtd" [<!ENTITY secret "private-token">]><tv/>',
    '<!DOCTYPE tv []><tv/>',
    '<!DOCTYPE tv PUBLIC "private-token" "xmltv.dtd"><tv/>',
    `<tv>${slot()}<programme channel="private-token"></tv>`,
    '<tv><bad private-token=unquoted/></tv>',
    '<tv>&private-token;</tv>',
    '<tv/><tv/>', '<html>private-token</html>', '',
  ];
  for (const input of inputs) {
    assert.throws(() => parseXmltv(input, options), error => {
      assert.equal(error.name, 'XmltvError');
      assert.equal(error.cause, undefined);
      assert.ok(!error.stack.includes('private-token'));
      return true;
    });
  }
});

test('does not invent entries when XMLTV has no programme data', () => {
  assert.deepEqual(parseXmltv('<tv><channel id="live-one"><display-name>News</display-name></channel></tv>', options), {
    programmes: new Map(), count: 0,
  });
});

test('bounds nesting, field sizes, programme storage and the input allowlist', () => {
  assert.throws(() => parseXmltv('<tv>' + '<x>'.repeat(32) + '</x>'.repeat(32) + '</tv>', options), { code: 'TOO_LARGE' });
  assert.throws(() => parseXmltv(guide(slot('live-one', undefined, undefined, 'x'.repeat(2049))), options), { code: 'TOO_LARGE' });
  assert.throws(() => parseXmltv('<tv/>', { ...options, channelIds: new Set(['x'.repeat(513)]) }), { code: 'INVALID_OPTIONS' });
  // Long descriptions reach the cumulative memory bound well before 100k rows.
  const content = '<desc>' + 'x'.repeat(16384) + '</desc>';
  const items = Array.from({ length: 1100 }, (_, i) => programme(
    'channel="live-one" start="20260924120000" stop="20260924130000"', `<title>Programme ${i}</title>${content}`,
  ));
  assert.throws(() => parseXmltv(guide(...items), options), { code: 'TOO_LARGE' });
});

test('discovers bounded HTTP(S) guide URLs only from the M3U header', () => {
  const text = '\uFEFF#EXTM3U x-tvg-url="../guide.xml, https://guides.example/second.xml" url-tvg=../guide.xml other-url-tvg="https://wrong.example/guide.xml"\n#EXTINF:-1 x-tvg-url="https://wrong.example/other.xml",News\nhttps://streams.example/live';
  assert.deepEqual(playlistEpgUrls(text, 'https://user:password@provider.example/lists/channels.m3u'), [
    'https://user:password@provider.example/guide.xml', 'https://guides.example/second.xml',
  ]);
  assert.deepEqual(playlistEpgUrls('#EXTM3U url-tvg="file:///private, data:text/plain, javascript:alert(1)"'), []);
  assert.deepEqual(playlistEpgUrls('not a playlist\n#EXTM3U url-tvg="https://wrong.example"'), []);
  const many = '#EXTM3U x-tvg-url="' + Array.from({ length: 20 }, (_, i) => `https://guides.example/${i}.xml`).join(',') + '"';
  assert.equal(playlistEpgUrls(many).length, 5);
});
