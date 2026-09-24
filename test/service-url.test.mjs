import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeServiceUrl } from '../public/service-url.mjs';

test('normalizes bare service hosts, optional slashes, ports and protocol-relative URLs to HTTPS', () => {
  for (const [input, expected] of [
    [' example-service.onrender.com ', 'https://example-service.onrender.com'],
    ['example-service.onrender.com/', 'https://example-service.onrender.com'],
    ['example.com:8443/', 'https://example.com:8443'],
    ['example.com:443', 'https://example.com'],
    ['//example.com/', 'https://example.com'],
    ['HTTPS://EXAMPLE.COM/', 'https://example.com'],
    ['https://example.com./', 'https://example.com'],
    ['localhost:7860', 'https://localhost:7860'],
    ['[::1]:7860/', 'https://[::1]:7860'],
    ['https://münich.example/', 'https://xn--mnich-kva.example'],
  ]) assert.equal(normalizeServiceUrl(input), expected);
});

test('upgrades HTTP Render subdomains before checking HTTPS-page compatibility', () => {
  const options = { pageOrigin: 'https://example-service.onrender.com', sameOriginOnly: true };
  assert.equal(normalizeServiceUrl('http://example-service.onrender.com', options), options.pageOrigin);
  assert.equal(normalizeServiceUrl('http://EXAMPLE-SERVICE.ONRENDER.COM./', options), options.pageOrigin);
  assert.equal(normalizeServiceUrl('http://example-service.onrender.com:80/', options), options.pageOrigin);
  assert.equal(normalizeServiceUrl('http://example-service.onrender.com:8443'), 'https://example-service.onrender.com:8443');
});

test('does not treat lookalike Render hosts as HTTPS-upgrade targets', () => {
  for (const hostname of ['evil-onrender.com', 'onrender.com.evil.example', 'example.onrender.com.evil.example', 'onrender.com']) {
    assert.throws(() => normalizeServiceUrl(`http://${hostname}`, { pageOrigin: 'https://guide.example' }), /Use the HTTPS service address/);
    assert.equal(normalizeServiceUrl(`http://${hostname}`, { pageOrigin: 'http://guide.example' }), `http://${hostname}`);
  }
});

test('rejects remote HTTP from HTTPS pages with actionable help', () => {
  assert.throws(() => normalizeServiceUrl('http://example.com:8080', { pageOrigin: 'https://guide.example' }), /HTTPS/);
  assert.equal(normalizeServiceUrl('http://example.com:8080', { pageOrigin: 'http://guide.example' }), 'http://example.com:8080');
  assert.equal(normalizeServiceUrl('http://example.com:8080'), 'http://example.com:8080');
});

test('permits explicit loopback HTTP only from an HTTP page', () => {
  for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.2.3.4', '[::1]']) {
    const input = `http://${host}:7860`;
    assert.equal(normalizeServiceUrl(input, { pageOrigin: 'http://localhost:7860' }), input);
    assert.throws(() => normalizeServiceUrl(input, { pageOrigin: 'https://guide.example' }), /HTTPS/);
    assert.throws(() => normalizeServiceUrl(input), /HTTPS/);
  }
});

test('rejects Render dashboard addresses with public service address guidance', () => {
  for (const input of ['dashboard.render.com', 'https://dashboard.render.com/', 'https://dashboard.render.com/web/srv-private?token=private']) {
    assert.throws(() => normalizeServiceUrl(input), error => {
      assert.match(error.message, /public service address/);
      assert.match(error.message, /dashboard/);
      assert.doesNotMatch(error.message, /srv-private|token=private/);
      return true;
    });
  }
});

test('rejects credentials, add-on/private paths, queries and fragments without echoing them', () => {
  for (const input of [
    'https://private-user:private-password@example.com/',
    '//private-user:private-password@example.com/',
    'https://example.com/addon/private-key/manifest.json',
    'https://example.com/?key=private-key', 'https://example.com/#private-key',
    'https://example.com/?', 'https://example.com/#',
    'https://example.com/addon/..', 'https://example.com/./', 'https://example.com/%2e/',
    'https://example.com//',
  ]) {
    assert.throws(() => normalizeServiceUrl(input), error => {
      assert.match(error.message, /only your service address/);
      assert.doesNotMatch(error.message, /private-user|private-password|private-key/);
      return true;
    });
  }
});

test('rejects malformed hosts, ports and unsupported schemes without URL-parser diagnostics', () => {
  for (const value of [
    '', null, undefined, {}, 'not a URL', 'https://', 'https://.example.com', 'https://example..com',
    'https://-example.com', 'https://example-.com', 'https://under_score.example',
    'https://example.com:65536', 'https://example.com:-1', 'https://[not-ipv6]',
    'https:example.com', 'http:443', 'file:///private-key', 'javascript:private-key', 'ftp://example.com',
    'https://example.com/\nprivate-key', 'https:\\example.com',
  ]) assert.throws(() => normalizeServiceUrl(value), error => {
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.message, /private-key/);
    return true;
  });
});

test('same-origin mode requires the exact normalized page scheme, hostname and port', () => {
  const options = { pageOrigin: 'https://example.com:8443', sameOriginOnly: true };
  assert.equal(normalizeServiceUrl('EXAMPLE.COM:8443/', options), options.pageOrigin);
  for (const input of ['https://other.example:8443', 'https://example.com', 'https://example.com:8444']) {
    assert.throws(() => normalizeServiceUrl(input, options), /own service address/);
  }
  assert.throws(() => normalizeServiceUrl('https://example.com', { sameOriginOnly: true }), /own service address/);
  assert.equal(normalizeServiceUrl('http://localhost:7860', { pageOrigin: 'http://localhost:7860', sameOriginOnly: true }), 'http://localhost:7860');
});

test('invalid page-origin context produces fixed help without leaking context values', () => {
  for (const pageOrigin of ['private-context', 'file:///private-context', 'https://user:private-context@example.com', 'https://example.com/private-context']) {
    assert.throws(() => normalizeServiceUrl('https://example.com', { pageOrigin }), error => {
      assert.match(error.message, /Open the service setup page/);
      assert.doesNotMatch(error.message, /private-context/);
      return true;
    });
  }
});
