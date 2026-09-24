// User-started browser activity only. No server self-ping or background scheduler.
export function mountAwake(root, {defaultUrl = '', intervalMs = 4 * 60000} = {}) {
  const address = root.querySelector('[data-service-url]');
  const status = root.querySelector('[data-wake-status]');
  const wakeButton = root.querySelector('[data-wake]');
  const startButton = root.querySelector('[data-awake-start]');
  const stopButton = root.querySelector('[data-awake-stop]');
  const duration = root.querySelector('[data-awake-hours]');
  if (defaultUrl) address.value = defaultUrl;
  let timer, controller, expires = 0, lastSuccess = 0, generation = 0;
  const setStatus = (text, error = false) => {status.textContent = text; status.classList.toggle('error',error);};
  const getOrigin = () => {
    const url = new URL(address.value.trim());
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Enter just your service address, without an access key or other path.');
    return url.origin;
  };
  function stop(text = 'Keep-awake stopped. Render may sleep after 15 minutes without another request.') {
    expires = 0; generation++; clearTimeout(timer); controller?.abort(); wakeButton.disabled = false;
    startButton.disabled = false; stopButton.disabled = true; address.disabled = false; duration.disabled = false;
    setStatus(text);
  }
  async function ping() {
    const activeUntil = expires;
    if (activeUntil && Date.now() >= activeUntil) return stop('Your keep-awake session ended. Start another when you need it.');
    const operation = ++generation;
    clearTimeout(timer); controller?.abort(); controller = new AbortController();
    const thisController = controller;
    const timeout = setTimeout(() => thisController.abort(), 90000);
    wakeButton.disabled = true;
    setStatus('Waking the service… A sleeping Free service can take about a minute.');
    try {
      const origin = getOrigin();
      const response = await fetch(`${origin}/health?wake=${Date.now()}`,{cache:'no-store',signal:thisController.signal});
      if (!response.ok || (await response.json()).status !== 'ok') throw new Error('The service is still starting. Try again in a minute.');
      if (operation !== generation) return;
      if (activeUntil && Date.now() >= activeUntil) return stop('Your keep-awake session ended. Start another when you need it.');
      lastSuccess = Date.now();
      setStatus(`Service awake · activity refreshed at ${new Date(lastSuccess).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}.${expires ? ` Next check in 4 minutes; session ends at ${new Date(expires).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}. Keep this page and device running.` : ' The idle window is about 15 minutes from the last request.'}`);
    } catch (error) {
      if (operation !== generation) return;
      if (activeUntil && Date.now() >= activeUntil) return stop('Your keep-awake session ended. Start another when you need it.');
      setStatus(error.name === 'AbortError' ? 'The service did not respond in time. Check its address and try again.' : error.message,true);
    } finally {
      clearTimeout(timeout);
      if (operation === generation) {
        wakeButton.disabled = false;
        if (expires && expires === activeUntil) timer = setTimeout(ping, Math.min(intervalMs,Math.max(0,expires - Date.now())));
      }
    }
  }
  wakeButton.addEventListener('click',ping);
  startButton.addEventListener('click',() => {
    try { getOrigin(); } catch(error) {setStatus(error.message,true); return;}
    const hours = Number(duration.value);
    if (![1,2,4,8].includes(hours)) return setStatus('Choose a session of 1, 2, 4 or 8 hours.',true);
    expires = Date.now() + hours * 3600000;
    startButton.disabled = true; stopButton.disabled = false; address.disabled = true; duration.disabled = true;
    ping();
  });
  stopButton.addEventListener('click',() => stop());
  const resume = () => {
    if (expires && document.visibilityState === 'visible' && (Date.now() >= expires || Date.now() - lastSuccess >= intervalMs)) ping();
  };
  document.addEventListener('visibilitychange',resume);
  window.addEventListener('pagehide',() => stop('This page was closed. Keep-awake has stopped.'),{once:true});
  return {stop};
}
