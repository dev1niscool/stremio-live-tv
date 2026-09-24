import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.mjs';

const TOKEN = 'config-test-key-'.repeat(4);
const ACCOUNT = 'https://panel.example.test:8443/service/get.php?username=Demo_User%2BWest&password=synthetic%26pass%3D%2B%2F%3F%23%25&type=m3u_plus&output=ts';
const settings = (...sources) => readConfig({
  PLAYLISTS_JSON: JSON.stringify(sources), ADDON_TOKEN: TOKEN,
});

test('omitted source names use the exact decoded username or the hostname', () => {
  const { sources } = settings(
    { id: 'account', url: ACCOUNT },
    { id: 'generic-user', url: 'https://lists.example.test/tv.m3u?username=Family%2BWest' },
    { id: 'generic', url: 'https://LISTS.example.test:8443/tv.m3u' },
  );
  assert.deepEqual(sources.map(source => source.name), ['Demo_User+West', 'Family+West', 'lists.example.test']);
  assert.equal(sources[0].url, ACCOUNT, 'name derivation does not rewrite the playlist credential encoding');
});

test('an explicit source name overrides account or hostname defaults and preserves its spelling', () => {
  const { sources } = settings(
    { id: 'account', name: '  Family TV + West  ', url: ACCOUNT },
    { id: 'generic', name: 'Café: Local News', url: 'https://lists.example.test/tv.m3u' },
  );
  assert.deepEqual(sources.map(source => source.name), ['Family TV + West', 'Café: Local News']);
  for (const name of ['', '   ', false, 42, ['Wrong type']]) {
    assert.throws(() => settings({ url: ACCOUNT, name }), /name must contain/);
  }
});

test('Xtream XMLTV derivation preserves origin, path prefix and decoded credentials only', () => {
  const [{ epgUrl }] = settings({ url: `${ACCOUNT}&category_id=12#fragment` }).sources;
  const guide = new URL(epgUrl);
  assert.equal(guide.origin, 'https://panel.example.test:8443');
  assert.equal(guide.pathname, '/service/xmltv.php');
  assert.equal(guide.hash, '');
  assert.deepEqual([...guide.searchParams], [
    ['username', 'Demo_User+West'], ['password', 'synthetic&pass=+/?#%'],
  ]);
  assert.equal(epgUrl, 'https://panel.example.test:8443/service/xmltv.php?username=Demo_User%2BWest&password=synthetic%26pass%3D%2B%2F%3F%23%25');
});

test('guide derivation is limited to complete get.php accounts and also handles root paths', () => {
  const root = settings({ url: 'https://panel.example.test/get.php?username=root&password=synthetic' }).sources[0];
  assert.equal(root.epgUrl, 'https://panel.example.test/xmltv.php?username=root&password=synthetic');
  for (const url of [
    'https://lists.example.test/tv.m3u?username=demo&password=synthetic',
    'https://panel.example.test/player_api.php?username=demo&password=synthetic',
    'https://panel.example.test/get.php?username=demo',
    'https://panel.example.test/get.php?password=synthetic',
    'https://panel.example.test/get.php?username=demo&password=',
  ]) assert.equal(settings({ name: 'My channels', url }).sources[0].epgUrl, '');
});

test('an explicit guide overrides derivation and false disables it without changing the playlist', () => {
  const explicit = 'https://guides.example.test/schedule.xml.gz?token=synthetic%2Bvalue&region=west';
  const { sources } = settings(
    { id: 'explicit', url: ACCOUNT, epgUrl: explicit },
    { id: 'disabled', url: ACCOUNT, epgUrl: false },
    { id: 'generic', url: 'https://lists.example.test/tv.m3u', epgUrl: explicit },
  );
  assert.deepEqual(sources.map(source => source.epgUrl), [explicit, '', explicit]);
  assert.equal(sources[1].url, ACCOUNT);
  assert.equal(sources[1].name, 'Demo_User+West');
});

test('invalid explicit guide URLs fail with a sanitized playlist-specific error', () => {
  for (const epgUrl of [
    'PRIVATE_GUIDE_VALUE',
    '/guide.xml?password=PRIVATE_PASSWORD',
    'https://[PRIVATE_HOST]?password=PRIVATE_PASSWORD',
    'ftp://PRIVATE_USER:PRIVATE_PASSWORD@private-provider.example/guide.xml',
    'file:///PRIVATE_PASSWORD.xml',
    'data:text/xml,PRIVATE_PASSWORD',
  ]) {
    assert.throws(() => settings({ url: ACCOUNT, epgUrl }), error => {
      assert.match(error.message, /^Playlist 1: epgUrl must (?:be a complete XMLTV URL|use HTTP or HTTPS)\.$/);
      assert.doesNotMatch(error.message, /PRIVATE|private-provider|panel\.example|synthetic|Demo_User/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('non-string guide values cannot be coerced into URLs or silently enable auto-derived guides', () => {
  for (const epgUrl of [true, 0, 1, [], ['https://guides.example.test/guide.xml'], {}]) {
    assert.throws(() => settings({ url: ACCOUNT, epgUrl }), error => {
      assert.match(error.message, /^Playlist 1: epgUrl /);
      assert.doesNotMatch(error.message, /panel\.example|guides\.example|synthetic|Demo_User/);
      return true;
    }, `epgUrl must reject ${JSON.stringify(epgUrl)}`);
  }
});
