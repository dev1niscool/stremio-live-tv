import {mountImport} from './import-ui.mjs';
import {mountAwake} from './awake.mjs';
const $ = selector => document.querySelector(selector);
const tabs = [...document.querySelectorAll('[role=tab]')];
function selectTab(id, focus = false) {
  for (const tab of tabs) {
    const selected = tab.getAttribute('aria-controls') === id;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
    if (selected && focus) tab.focus();
  }
}
function route() {selectTab(!location.hash || ['#ready','#ready-playlists'].includes(location.hash) ? 'ready' : 'self-host');}
for (const [i,tab] of tabs.entries()) {
  tab.addEventListener('click',()=>{const id=tab.getAttribute('aria-controls');history.replaceState(null,'',`#${id}`);selectTab(id);});
  tab.addEventListener('keydown',event=>{
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length-1 : (i+(event.key === 'ArrowRight'?1:-1)+tabs.length)%tabs.length;
    tabs[next].click(); tabs[next].focus();
  });
}
window.addEventListener('hashchange',route);route();
mountAwake($('#guide-awake'));
$('[data-service-url]').addEventListener('input',()=>{
  try {
    const url = new URL($('[data-service-url]').value.trim());
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    $('#open-service').href = url.origin;
    $('#open-service').removeAttribute('aria-disabled');
  } catch {$('#open-service').removeAttribute('href');$('#open-service').setAttribute('aria-disabled','true');}
});
let sources = [];
function updateOutput() {$('#ready-json').value = JSON.stringify(sources,null,2);$('#ready-copy-status').textContent='';}
function renderSources() {
  $('#import-review').hidden = !sources.length;
  $('#review-sources').replaceChildren();
  for (const source of sources) {
    const row = document.createElement('div');row.className='review-source';
    const label = document.createElement('label');label.textContent='Title in Stremio';
    const input = document.createElement('input');input.value=source.name;input.maxLength=80;input.autocomplete='off';label.append(input);
    input.addEventListener('input',()=>{source.name=input.value;updateOutput();});
    const detail = document.createElement('p');detail.className='subtle';detail.textContent=`${new URL(source.url).hostname} · ${source.epgUrl ? 'XMLTV guide detected' : 'Classic list; add XMLTV in advanced setup'}`;
    const remove = document.createElement('button');remove.type='button';remove.className='remove-source';remove.textContent='Remove';remove.setAttribute('aria-label',`Remove ${source.name}`);
    remove.addEventListener('click',()=>{sources=sources.filter(s=>s!==source);renderSources();});
    row.append(label,detail,remove);$('#review-sources').append(row);
  }
  updateOutput();
}
mountImport($('#guide-import'),found=>{
  const ids=new Set(sources.map(s=>s.id));let skipped=0;
  for(const source of found) if(!ids.has(source.id)) {if(sources.length>=50){skipped++;continue;}sources.push(source);ids.add(source.id);}
  renderSources();if(skipped) $('#ready-copy-status').textContent=`Kept 50 sources; ${skipped} more exceed this service’s limit.`;
});
async function copy(env) {
  if(sources.some(s=>!s.name.trim() || s.name.length>80)) {$('#ready-copy-status').textContent='Give every source a title of 1–80 characters.';return;}
  const value=JSON.stringify(sources.map(s=>({...s,name:s.name.trim()})));
  try {await navigator.clipboard.writeText(env?`PLAYLISTS_JSON=${value}`:value);$('#ready-copy-status').textContent='Copied. Paste into your service’s private Render Environment settings. Keep your existing ADDON_TOKEN.';}
  catch {$('#ready-json').closest('details').open=true;$('#ready-json').focus();$('#ready-json').select();$('#ready-copy-status').textContent='Clipboard unavailable. Copy the selected JSON into PLAYLISTS_JSON manually.';}
}
$('#copy-playlists').addEventListener('click',()=>copy(false));$('#copy-env').addEventListener('click',()=>copy(true));
$('#clear-playlists').addEventListener('click',()=>{sources=[];renderSources();$('[data-import-status]').textContent='Links cleared from this page.';});
