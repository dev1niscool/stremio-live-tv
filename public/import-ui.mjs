import {extractPlaylists} from './importer.mjs';

export function mountImport(root, onImport) {
  const drop = root.querySelector('[data-drop]');
  const file = root.querySelector('[data-file]');
  const text = root.querySelector('[data-import-text]');
  const status = root.querySelector('[data-import-status]');
  const parse = (value) => {
    if (value.length > 5 * 1024 * 1024) {status.textContent = 'Choose a text file smaller than 5 MiB.'; return;}
    const result = extractPlaylists(value);
    if (!result.sources.length) {status.textContent = 'No playlist links found. Look for complete get.php, .m3u or playlist .m3u8 URLs.'; return;}
    onImport(result.sources);
    status.textContent = `Found ${result.sources.length} playlist${result.sources.length === 1 ? '' : 's'}. Removed ${result.duplicateCount} duplicate${result.duplicateCount === 1 ? '' : 's'}; ignored ${result.rejectedCount} other URL${result.rejectedCount === 1 ? '' : 's'}. Review before copying.`;
    text.value = ''; file.value = '';
  };
  const read = async files => {
    const selection = [...files];
    if (!selection.length) return;
    if (selection.reduce((n,f)=>n+f.size,0) > 5 * 1024 * 1024) {status.textContent = 'Choose text files totaling less than 5 MiB.'; return;}
    try { parse((await Promise.all(selection.map(f=>f.text()))).join('\n')); }
    catch {status.textContent = 'Could not read that file. Try a plain-text file or paste the text below.';}
  };
  root.querySelector('[data-browse]').addEventListener('click',()=>file.click());
  root.querySelector('[data-extract]').addEventListener('click',()=>parse(text.value));
  file.addEventListener('change',()=>read(file.files));
  for (const event of ['dragenter','dragover']) drop.addEventListener(event,e=>{e.preventDefault();drop.classList.add('drag-over');});
  drop.addEventListener('dragleave',()=>drop.classList.remove('drag-over'));
  drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('drag-over');read(e.dataTransfer.files);});
}
