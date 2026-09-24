import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { createAddon } from '../src/addon.mjs';

const token = 'a'.repeat(64);
const config = {sources:[{id:'one',name:'Private provider',url:'https://example.com/private.m3u'}],token,port:7860,ttlMs:10000,publicUrl:'https://service.example',name:'Stremio Live TV'};
const fixture = '#EXTM3U\n#EXTINF:-1 tvg-id="news" group-title="Live TV",Channel News\nhttps://provider.example/live/private/password/1.ts\n#EXTINF:120 group-title="Movies",Hidden VOD\nhttps://provider.example/movie/private/password/2.mp4';
async function usingServer(fn, options = {}) {
  const addon = createAddon(config, async () => {if(options.fail) throw new Error('https://provider.example/secret'); return fixture;});
  const server = createServer(config, addon);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
test('public health/setup has no playlist data; all addon resources require key', async () => usingServer(async base => {
  assert.deepEqual(await (await fetch(base+'/health')).json(),{status:'ok'});
  for (const path of ['/manifest.json','/addon/wrong/manifest.json','/.env','/src/config.mjs']) assert.equal((await fetch(base+path)).status,404);
  const status = await fetch(base+'/api/status'); assert.equal(status.status,401);
  assert.doesNotMatch(await (await fetch(base+'/api/info')).text(),/provider|private\.m3u/);
  const page = await fetch(base+'/'); assert.equal(page.status,200); assert.match(await page.text(),/Build your channel list/);
}));
test('encoded Live TV route handles Discover, search, meta and stream end to end', async () => usingServer(async base => {
  const prefix = `${base}/addon/${token}`;
  const manifestResponse = await fetch(prefix+'/manifest.json');
  assert.equal(manifestResponse.headers.get('access-control-allow-origin'),'*');
  assert.equal(manifestResponse.headers.get('cache-control'),'no-store');
  assert.equal(manifestResponse.headers.get('referrer-policy'),'no-referrer');
  const manifest = await manifestResponse.json(); assert.deepEqual(manifest.types,['Live TV']);
  const home = await (await fetch(prefix+'/catalog/Live%20TV/one.json')).json(); assert.deepEqual(home.metas,[]);
  const list = await (await fetch(prefix+'/catalog/Live%20TV/one/genre=All%20channels&search=Channel%20News.json')).json();
  assert.equal(list.metas.length,1); assert.equal(list.metas[0].name,'Channel News');
  const id = encodeURIComponent(list.metas[0].id);
  const meta = await (await fetch(prefix+`/meta/Live%20TV/${id}.json`)).json(); assert.equal(meta.meta.behaviorHints.isLive,true);
  const stream = await (await fetch(prefix+`/stream/Live%20TV/${id}.json`)).json();
  assert.equal(stream.streams.length,1); assert.equal(stream.streams[0].url,'https://provider.example/live/private/password/1.ts');
  assert.doesNotMatch(JSON.stringify({manifest,list,meta}),/password|private\.m3u/);
  assert.deepEqual((await (await fetch(prefix+'/catalog/movie/one/genre=All%20channels.json')).json()).metas,[]);
}));
test('status only discloses counts and install URL to authenticated host', async () => usingServer(async base => {
  const response = await fetch(base+'/api/status',{headers:{Authorization:`Bearer ${token}`}});
  const body = await response.text(); assert.doesNotMatch(body,/password|private\.m3u/);
  const data=JSON.parse(body); assert.equal(data.sources[0].stats.accepted,1); assert.equal(data.sources[0].stats.excludedVod,1);
  assert.equal(data.manifestUrl,`https://service.example/addon/${token}/manifest.json`);
  assert.equal((await fetch(base+'/api/refresh',{headers:{Authorization:`Bearer ${token}`}})).status,405);
  assert.equal((await fetch(base+'/api/refresh',{method:'POST',headers:{Authorization:`Bearer ${token}`}})).status,200);
}));
test('provider failures and malformed encodings do not expose sensitive details', async () => usingServer(async base => {
  const response = await fetch(`${base}/addon/${token}/catalog/Live%20TV/one/genre=All%20channels.json`);
  assert.equal(response.status,502); assert.doesNotMatch(await response.text(),/provider\.example|secret/);
  assert.equal((await fetch(`${base}/addon/${token}/catalog/%ZZ/one.json`)).status,400);
},{fail:true}));
