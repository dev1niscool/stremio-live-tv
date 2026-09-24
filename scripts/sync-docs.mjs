import {readFile,writeFile} from 'node:fs/promises';
const check = process.argv.includes('--check');
async function output(file, content) {
  const target = new URL(`../docs/${file}`,import.meta.url);
  if (check) {
    if (await readFile(target,'utf8') !== content) throw new Error(`docs/${file} is stale. Run npm run sync-docs.`);
  } else await writeFile(target,content);
}
for (const file of ['awake.mjs','service-url.mjs','importer.mjs','import-ui.mjs']) await output(file,await readFile(new URL(`../public/${file}`,import.meta.url),'utf8'));
const css = await readFile(new URL('../public/style.css',import.meta.url),'utf8') + '\n' + await readFile(new URL('../docs/guide-style.css',import.meta.url),'utf8');
await output('style.css',css);
