const $ = selector => document.querySelector(selector);
let sourceSequence = 0;
let accessKey = '';
const message = (id, text, error = false) => { $(id).textContent = text; $(id).classList.toggle('error', error); };

function addSource() {
  if ($('#sources').children.length >= 50) return message('#setup-message', 'This service supports up to 50 playlists.', true);
  const row = $('#source-template').content.firstElementChild.cloneNode(true);
  row.dataset.id = `playlist-${++sourceSequence}`;
  row.querySelector('.source-number').textContent = `PLAYLIST ${String(sourceSequence).padStart(2, '0')}`;
  row.querySelector('.remove-source').addEventListener('click', () => {
    if ($('#sources').children.length === 1) return message('#setup-message', 'Keep at least one playlist.', true);
    row.remove(); invalidateOutput();
  });
  row.addEventListener('input', invalidateOutput);
  $('#sources').append(row);
}
function invalidateOutput() { $('#settings-output').hidden = true; }
$('#add-source').addEventListener('click', addSource);
addSource();

$('#setup-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const names = new Set();
    const sources = [...$('#sources').children].map((row, i) => {
      const name = row.querySelector('.source-name').value.trim();
      if (!name || names.has(name.toLowerCase())) throw new Error('Give every playlist a different name.');
      names.add(name.toLowerCase());
      const raw = row.querySelector('.source-url').value.trim();
      let url;
      try { url = new URL(raw); } catch { throw new Error(`Playlist ${i + 1} needs a complete HTTP or HTTPS URL.`); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Playlist ${i + 1} needs an HTTP or HTTPS URL.`);
      const lines = selector => row.querySelector(selector).value.split('\n').map(s => s.trim()).filter(Boolean);
      // Stable name-based IDs remain the same when playlists are reordered or credentials change.
      const id = 'source-' + [...name].reduce((h,c) => Math.imul(h ^ c.codePointAt(0),16777619) >>> 0,2166136261).toString(16);
      return {id, name, url:raw, includeGroups:lines('.include-groups'), excludeGroups:lines('.exclude-groups')};
    });
    $('#json-output').value = JSON.stringify(sources, null, 2);
    if (!$('#token-output').value) $('#token-output').value = [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2,'0')).join('');
    $('#settings-output').hidden = false;
    message('#setup-message', 'Settings generated locally. Copy both values below into Render.');
  } catch (error) { message('#setup-message', error.message, true); }
});

document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
  const input = document.getElementById(button.dataset.copy);
  try {
    await navigator.clipboard.writeText(input.value);
    const original = button.textContent; button.textContent = 'Copied';
    setTimeout(() => { button.textContent = original; }, 2000);
  } catch {
    input.type === 'password' && (input.type = 'text');
    input.focus(); input.select();
    message(input.id === 'manifest-url' ? '#connect-message' : '#copy-message', 'Clipboard unavailable. Copy the selected value manually.', true);
  }
}));

let checking = false;
function renderStatuses(sources) {
  const list = $('#status-list'); list.replaceChildren();
  for (const source of sources) {
    const row = document.createElement('div'); row.className = 'status-row';
    const content = document.createElement('div'); const name = document.createElement('h3'); name.textContent = source.name;
    const detail = document.createElement('p');
    if (source.state === 'ready') {
      const s = source.stats;
      detail.textContent = `${s.excludedVod} VOD excluded · ${s.excludedUnknown} unclassified excluded · ${s.excludedGroups} filtered by group`;
      const count = document.createElement('span'); count.className = 'status-count'; count.textContent = `${s.accepted} live`;
      row.append(content, count);
    } else {
      detail.textContent = source.state === 'pending' ? 'Waiting to check…' : source.error;
      row.append(content);
    }
    content.append(name, detail); list.append(row);
  }
}
async function checkPlaylists(refresh = false) {
  if (checking) return;
  checking = true;
  const button = $('#connect-button'); button.disabled = true; $('#refresh').disabled = true;
  const key = accessKey;
  message('#connect-message', 'Connecting… This can take a moment after the host wakes up.');
  $('#install-output').hidden = true;
  $('#playlist-status').hidden = true;
  const request = async (path, method = 'GET', timeout = 90000) => {
    const response = await fetch(path, {method, headers:{Authorization:`Bearer ${key}`}, signal:AbortSignal.timeout(timeout)});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to connect. Try again in a minute.');
    return data;
  };
  try {
    // Show the install link immediately; check providers individually so one slow source
    // cannot hide all results or force a 50-playlist request to exceed proxy timeouts.
    const data = await request(refresh ? '/api/refresh?summary=1' : '/api/status?summary=1', refresh ? 'POST' : 'GET');
    if (data.sources.length) {
      $('#manifest-url').value = data.manifestUrl;
      $('#install-link').href = data.manifestUrl.replace(/^https?:\/\//,'stremio://');
      $('#install-output').hidden = false;
      $('#playlist-status').hidden = false;
      renderStatuses(data.sources);
    }
    let checked = 0;
    for (let i = 0; i < data.sources.length; i += 2) {
      await Promise.all(data.sources.slice(i,i + 2).map(async source => {
        try {
          const result = await request(`/api/status?source=${encodeURIComponent(source.id)}`, 'GET', 60000);
          Object.assign(source,result.sources[0] || {state:'error',error:'This playlist no longer exists. Reload and try again.'});
        } catch { Object.assign(source,{state:'error',error:'This playlist could not be checked. Check the host and try again.'}); }
        checked++;
        renderStatuses(data.sources);
        message('#connect-message', `Checked ${checked} of ${data.sources.length} playlists…`);
      }));
    }
    const total = data.sources.reduce((n,s) => n + (s.stats?.accepted || 0),0);
    const failed = data.sources.filter(s => s.state === 'error').length;
    message('#connect-message', data.sources.length ? `${total} live channels across ${data.sources.length} playlists.${failed ? ` ${failed} playlist(s) need attention.` : ''}` : 'No playlists configured yet. Generate settings and add them to your host.', failed > 0);
  } catch (error) {
    message('#connect-message', error.name === 'TimeoutError' ? 'The request timed out. Open the host, wait for it to wake, and try again.' : error.message, true);
  } finally { checking = false; button.disabled = false; $('#refresh').disabled = false; }
}
$('#connect-form').addEventListener('submit', event => { event.preventDefault(); accessKey = $('#access-key').value.trim(); checkPlaylists(); });
$('#refresh').addEventListener('click', () => checkPlaylists(true));
fetch('/api/info').then(r => r.json()).then(info => {
  $('#service-state').textContent = info.configured ? 'Service ready · enter your key to connect' : 'Service online · waiting for your playlists';
}).catch(() => { $('#service-state').textContent = 'Service unavailable · try again after the host wakes up'; });
