import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readConfig } from './config.mjs';
import { createAddon, TYPE, NATIVE_TYPE } from './addon.mjs';

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/configure', ['index.html','text/html; charset=utf-8']],
  ['/app.js', ['app.js','text/javascript; charset=utf-8']], ['/style.css',['style.css','text/css; charset=utf-8']],
  ['/importer.mjs',['importer.mjs','text/javascript; charset=utf-8']], ['/import-ui.mjs',['import-ui.mjs','text/javascript; charset=utf-8']], ['/awake.mjs',['awake.mjs','text/javascript; charset=utf-8']],
  ['/icon.svg',['icon.svg','image/svg+xml']], ['/service-url.mjs',['service-url.mjs','text/javascript; charset=utf-8']],
  ['/robots.txt',['robots.txt','text/plain; charset=utf-8']]
]);
const same = (a, b) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createServer(config, addon = createAddon(config)) {
  return http.createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); };
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'");
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const origin = config.publicUrl || `http://localhost:${config.port}`;
      if (req.method === 'GET' && staticFiles.has(path)) {
        const [file, mime] = staticFiles.get(path);
        res.writeHead(200, {'Content-Type':mime});
        res.end(await readFile(new URL(`../public/${file}`, import.meta.url)));
        return;
      }
      if (path === '/health' && req.method === 'GET') return json(200, {status:'ok'});
      if (path === '/api/info' && req.method === 'GET') return json(200, {configured:!!(config.token && config.sources.length), name:config.name});
      if (path === '/api/status' || path === '/api/refresh') {
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        if (!config.token || !same(token, config.token)) return json(401, {error:'Access key is missing or incorrect.'});
        if ((path === '/api/status' && req.method !== 'GET') || (path === '/api/refresh' && req.method !== 'POST')) return json(405,{error:'Method not allowed.'});
        if (path === '/api/refresh') addon.refresh();
        const status = url.searchParams.get('summary') === '1'
          ? {sources:config.sources.map(s => ({id:s.id,name:s.name,state:'pending'}))}
          : await addon.status(url.searchParams.get('source'));
        return json(200, {...status, manifestUrl:`${origin}/addon/${config.token}/manifest.json`,
          nflManifestUrl:`${origin}/addon/${config.token}/nfl/manifest.json`});
      }
      const match = path.match(/^\/addon\/([^/]+)\/(.+)$/);
      if (!match || !config.token || !same(match[1], config.token)) return json(404, {error:'Not found.'});
      if (req.method !== 'GET') return json(405, {error:'Method not allowed.'});
      const profile = match[2].startsWith('nfl/') ? 'nfl' : 'full';
      const resourcePath = profile === 'nfl' ? match[2].slice('nfl/'.length) : match[2];
      if (resourcePath === 'configure') { res.writeHead(302, {Location:'/configure'}); res.end(); return; }
      if (!config.sources.length) return json(503, {error:'Add at least one playlist in the hosting environment settings.'});
      if (resourcePath === 'manifest.json') return json(200, addon.manifest(origin,profile));
      const resource = resourcePath.match(/^(catalog|meta|stream)\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/);
      if (!resource) return json(404, {error:'Not found.'});
      const [, kind, encodedType, encodedId, encodedExtra] = resource;
      const type = decodeURIComponent(encodedType), id = decodeURIComponent(encodedId);
      if (![TYPE,NATIVE_TYPE].includes(type)) return json(200, kind === 'catalog' ? {metas:[]} : kind === 'stream' ? {streams:[]} : {meta:null});
      // URLSearchParams decodes each value exactly once; do not decode the entire extra segment.
      const extra = Object.fromEntries(new URLSearchParams(encodedExtra || ''));
      const response = kind === 'catalog' ? await addon.catalog(id, extra, type, profile) : await addon[kind](id,type,profile);
      return json(200, {...response, cacheMaxAge:0, staleRevalidate:0, staleError:0});
    } catch (error) {
      // Upstream URLs and credentials must never appear in responses or logs.
      return json(error instanceof URIError ? 400 : 502, {error:error instanceof URIError ? 'Malformed request.' : 'Unable to load the playlist. Check its settings and try again.'});
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const config = readConfig();
    const server = createServer(config);
    server.listen(config.port, '0.0.0.0', () => console.log(`Stremio Live TV listening on port ${config.port}. ${config.sources.length} playlist(s) configured.`));
    const close = () => server.close(() => process.exit(0));
    process.on('SIGTERM', close); process.on('SIGINT', close);
  } catch (error) { console.error(`Configuration error: ${error.message}`); process.exit(1); }
}
