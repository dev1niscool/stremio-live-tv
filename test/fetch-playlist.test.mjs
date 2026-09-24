import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import test from 'node:test';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { fetchPlaylist, isPublicAddress } from '../src/fetch-playlist.mjs';

// Mock the transports themselves, keeping every production validation enabled.
function network(t, replies, answers = [{ address: '93.184.216.34', family: 4 }]) {
  const calls = [];
  const lookups = [];
  t.mock.method(dns, 'lookup', async (hostname) => {
    lookups.push(hostname);
    return typeof answers === 'function' ? answers(hostname) : answers;
  });
  function request(options, callback) {
    calls.push({ ...options, headers: { ...options.headers } });
    const reply = replies.shift();
    assert.ok(reply, 'Unexpected outbound request');
    const req = new EventEmitter();
    const onAbort = () => {
      req.emit('error', options.signal.reason);
      reply.stream?.destroy(options.signal.reason);
    };
    req.end = () => {
      options.signal.addEventListener('abort', onAbort, { once: true });
      queueMicrotask(() => {
        if (reply.pending) return;
        options.signal.removeEventListener('abort', onAbort);
        if (reply.error) return req.emit('error', reply.error);
        const response = reply.stream || Readable.from(reply.chunks || [reply.body || '']);
        response.statusCode = reply.status || 200;
        response.headers = reply.headers || {};
        callback(response);
      });
    };
    return req;
  }
  t.mock.method(http, 'request', request);
  t.mock.method(https, 'request', request);
  return { calls, lookups };
}

test('rejects private, local, metadata, documentation, and transition addresses', () => {
  for (const address of [
    '', 'localhost', '8.8.8.999', '0.0.0.0', '0.1.2.3', '10.20.30.40', '100.64.0.1',
    '100.127.255.254', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.0.0.8', '192.0.2.1', '192.88.99.1', '192.168.0.1', '198.18.0.1', '198.19.255.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1',
    'fc00::1', 'fdab::1', 'fe80::1', 'fe80::1%en0', 'ff02::1', '::ffff:127.0.0.1',
    '::ffff:7f00:1', '::ffff:192.168.1.1', '::ffff:a9fe:a9fe', '::8.8.8.8',
    '64:ff9b::a9fe:a9fe', '2001::1234', '2001:2::1', '2001:db8::1', '2002:7f00:1::',
    '3fff::1', '3fff:fff::1',
  ]) assert.equal(isPublicAddress(address), false, address);
});

test('accepts native public addresses and public mapped IPv4', () => {
  for (const address of [
    '1.1.1.1', '8.8.8.8', '93.184.216.34', '100.128.0.1', '172.32.0.1', '198.20.0.1',
    '2001:4860:4860::8888', '2606:4700:4700::1111', '::ffff:8.8.8.8', '::ffff:0808:0808',
  ]) assert.equal(isPublicAddress(address), true, address);
});

test('URL normalization cannot bypass loopback checks', async (t) => {
  const { calls } = network(t, []);
  for (const url of [
    'http://127.0.0.1/secret', 'http://2130706433/secret', 'http://0x7f000001/secret',
    'http://127.1/secret', 'http://[::ffff:127.0.0.1]/secret',
    'http://localhost./secret', 'http://anything.localhost/secret',
    'http://metadata.google.internal/secret', 'file:///private/secret',
  ]) await assert.rejects(fetchPlaylist({ url }), { name: 'FetchPlaylistError' });
  assert.equal(calls.length, 0);
});

test('fails closed for mixed public/private DNS answers', async (t) => {
  const { calls } = network(t, [], [
    { address: '8.8.8.8', family: 4 }, { address: '192.168.1.1', family: 4 },
  ]);
  await assert.rejects(fetchPlaylist({ url: 'https://provider.example/list' }), { code: 'BLOCKED_ADDRESS' });
  assert.equal(calls.length, 0);
});

test('pins the validated DNS address into the HTTP transport', async (t) => {
  const { calls, lookups } = network(t, [{ body: '#EXTM3U\n' }]);
  assert.equal(await fetchPlaylist({ url: 'https://provider.example/list' }), '#EXTM3U\n');
  assert.deepEqual(lookups, ['provider.example']);
  assert.equal(calls[0].agent, false);
  assert.equal(calls[0].hostname, 'provider.example');
  calls[0].lookup('changed.example', {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, '93.184.216.34');
    assert.equal(family, 4);
  });
  calls[0].lookup('changed.example', { all: true }, (error, addresses) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
  });
});

test('validates every redirect target before requesting it', async (t) => {
  const { calls } = network(t, [{ status: 302, headers: { location: 'https://169.254.169.254/latest' } }]);
  await assert.rejects(fetchPlaylist({ url: 'https://provider.example/list' }), { code: 'BLOCKED_ADDRESS' });
  assert.equal(calls.length, 1);
});

test('returns the final response URL only when requested', async (t) => {
  const text = '#EXTM3U\n#EXTINF:-1,Channel\nlive/channel.m3u8\n';
  network(t, [
    { status: 302, headers: { location: 'https://cdn.example/region/playlist.m3u?token=private' } },
    { body: text },
    { status: 302, headers: { location: '/region/playlist.m3u' } },
    { body: text },
  ]);
  const result = await fetchPlaylist({ url: 'https://provider.example/list' }, { includeFinalUrl: true });
  assert.deepEqual(result, { text, url: 'https://cdn.example/region/playlist.m3u?token=private' });
  assert.equal(new URL('live/channel.m3u8', result.url).href, 'https://cdn.example/region/live/channel.m3u8');
  assert.equal(await fetchPlaylist({ url: 'https://provider.example/list' }), text);
});

test('blocks HTTPS to HTTP redirects before transmitting credentials', async (t) => {
  const { calls, lookups } = network(t, [
    { status: 302, headers: { location: 'http://provider.example/list?token=private' } },
  ]);
  await assert.rejects(fetchPlaylist({
    url: 'https://user:password@provider.example/list',
    headers: { Authorization: 'Bearer private' },
  }), (error) => {
    assert.equal(error.code, 'INSECURE_REDIRECT');
    assert.ok(!/password|private|provider\.example/.test(error.stack));
    return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(lookups, ['provider.example']);
});

test('revalidates DNS on a same-origin redirect', async (t) => {
  let lookups = 0;
  const { calls } = network(t, [{ status: 302, headers: { location: '/new' } }], () => {
    lookups += 1;
    return [{ address: lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
  });
  await assert.rejects(fetchPlaylist({ url: 'https://provider.example/list' }), { code: 'BLOCKED_ADDRESS' });
  assert.equal(calls.length, 1);
  assert.equal(lookups, 2);
});

test('preserves credentials only within the same origin', async (t) => {
  const { calls } = network(t, [
    { status: 302, headers: { location: '/same-origin' } },
    { status: 307, headers: { location: 'https://other-user:other-password@cdn.example/list' } },
    { body: '#EXTM3U' },
  ]);
  await fetchPlaylist({
    url: 'https://user:password@provider.example/list?token=secret',
    headers: { Authorization: 'Bearer private-token', Referer: 'https://provider.example/private', 'User-Agent': 'IPTV Player' },
  });
  assert.equal(calls[0].auth, 'user:password');
  assert.equal(calls[1].auth, 'user:password');
  assert.equal(calls[1].headers.authorization, 'Bearer private-token');
  assert.equal(calls[2].auth, undefined);
  assert.equal(calls[2].headers.authorization, undefined);
  assert.equal(calls[2].headers.referer, undefined);
  assert.equal(calls[2].headers['user-agent'], 'IPTV Player');
  assert.equal(calls[2].path, '/list');
});

test('stops redirect loops after five redirects', async (t) => {
  const { calls } = network(t, Array.from({ length: 6 }, () => ({ status: 302, headers: { location: '/again' } })));
  await assert.rejects(fetchPlaylist({ url: 'https://provider.example/list' }), { code: 'TOO_MANY_REDIRECTS' });
  assert.equal(calls.length, 6);
});

test('decodes supported compression formats', async (t) => {
  const text = '#EXTM3U\n#EXTINF:-1,Channel café\nhttps://stream.example/live\n';
  network(t, [
    { headers: { 'content-encoding': 'gzip' }, body: gzipSync(text) },
    { headers: { 'content-encoding': 'deflate' }, body: deflateSync(text) },
    { headers: { 'content-encoding': 'br' }, body: brotliCompressSync(text) },
  ]);
  for (let n = 0; n < 3; n += 1) {
    assert.equal(await fetchPlaylist({ url: 'https://provider.example/list' }), text);
  }
});

test('bounds plain and decompressed body size', async (t) => {
  network(t, [
    { headers: { 'content-length': '1000' }, body: 'small' },
    { chunks: [Buffer.alloc(60), Buffer.alloc(60)] },
    { headers: { 'content-encoding': 'gzip' }, body: gzipSync('x'.repeat(10000)) },
  ]);
  for (let n = 0; n < 3; n += 1) {
    await assert.rejects(fetchPlaylist({ url: 'https://provider.example/list' }, { maxBytes: 100 }), { code: 'TOO_LARGE' });
  }
});

test('unsupported compression and corrupt compressed data fail safely', async (t) => {
  network(t, [
    { headers: { 'content-encoding': 'zstd' }, body: 'private-response' },
    { headers: { 'content-encoding': 'gzip' }, body: 'private-response' },
    { status: 401, body: 'private-response' },
  ]);
  for (const code of ['UNSUPPORTED_ENCODING', 'FETCH_FAILED', 'HTTP_ERROR']) {
    await assert.rejects(fetchPlaylist({ url: 'https://provider.example/list' }), (error) => {
      assert.equal(error.code, code);
      assert.ok(!error.stack.includes('private-response'));
      return true;
    });
  }
});

test('rejects unsafe header overrides before making requests', async (t) => {
  const { calls } = network(t, []);
  for (const headers of [{ Host: 'localhost' }, { Cookie: 'secret' }, { 'User-Agent': 'x\r\nHost: localhost' }]) {
    await assert.rejects(fetchPlaylist({ url: 'https://provider.example/list', headers }), { code: 'INVALID_SOURCE' });
  }
  assert.equal(calls.length, 0);
});

test('upstream errors cannot leak credentials in their message, stack, or cause', async (t) => {
  network(t, [{ error: new Error('Failed https://user:password@provider.example/list?token=private-token') }]);
  await assert.rejects(fetchPlaylist({ url: 'https://user:password@provider.example/list?token=private-token' }), (error) => {
    assert.equal(error.code, 'FETCH_FAILED');
    assert.equal(error.cause, undefined);
    assert.ok(!/password|private-token|user:/.test(error.stack));
    return true;
  });
});

test('one total timeout covers an unanswered HTTP request', async (t) => {
  network(t, [{ pending: true }]);
  await assert.rejects(fetchPlaylist({ url: 'https://provider.example/list' }, { timeoutMs: 15 }), { code: 'TIMEOUT' });
});

test('one total timeout also bounds DNS lookup', async (t) => {
  const { calls } = network(t, [], () => new Promise(() => {}));
  await assert.rejects(fetchPlaylist({ url: 'https://provider.example/list' }, { timeoutMs: 15 }), { code: 'TIMEOUT' });
  assert.equal(calls.length, 0);
});

test('one total timeout also bounds a stalled response body', async (t) => {
  const stream = new Readable({ read() {} });
  network(t, [{ stream }]);
  await assert.rejects(fetchPlaylist({ url: 'https://provider.example/list' }, { timeoutMs: 15 }), { code: 'TIMEOUT' });
  assert.equal(stream.destroyed, true);
});
