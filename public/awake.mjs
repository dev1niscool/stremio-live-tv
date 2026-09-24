// User-started browser activity only. No server self-ping or background scheduler.
import {normalizeServiceUrl} from './service-url.mjs';

function retryDelay(signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(new DOMException('Wake cancelled.', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort',aborted); resolve(); },5000);
    if (signal.aborted) aborted();
    else signal.addEventListener('abort',aborted,{once:true});
  });
}

export function mountAwake(root, {defaultUrl = '', intervalMs = 4 * 60000, sameOriginOnly = false} = {}) {
  const address = root.querySelector('[data-service-url]');
  const status = root.querySelector('[data-wake-status]');
  const wakeButton = root.querySelector('[data-wake]');
  const startButton = root.querySelector('[data-awake-start]');
  const stopButton = root.querySelector('[data-awake-stop]');
  const duration = root.querySelector('[data-awake-hours]');
  if (defaultUrl) address.value = defaultUrl;
  let timer, controller, expires = 0, lastSuccess = 0, generation = 0;
  const setStatus = (text, error = false) => {status.textContent = text; status.classList.toggle('error',error);};
  const getOrigin = () => normalizeServiceUrl(address.value,{pageOrigin:window.location?.origin || '',sameOriginOnly});
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
    const deadline = Date.now() + 90000;
    const timeout = setTimeout(() => thisController.abort(), Math.min(90000,activeUntil ? Math.max(0,activeUntil - Date.now()) : 90000));
    wakeButton.disabled = true;
    setStatus('Waking the service… A sleeping Free service can take about a minute.');
    try {
      const origin = getOrigin();
      address.value = origin;
      // Render can answer with a temporary loading page before the application
      // (and its CORS headers) are ready. Verify real health, retrying within one
      // total deadline instead of reporting a raw browser "Load failed" error.
      while (true) {
        if (thisController.signal.aborted || Date.now() >= deadline) throw new DOMException('Wake timed out.', 'AbortError');
        let response;
        try { response = await fetch(`${origin}/health?wake=${Date.now()}`,{cache:'no-store',credentials:'omit',signal:thisController.signal}); }
        catch (error) { if (thisController.signal.aborted) throw error; }
        if (operation !== generation) return;
        if (activeUntil && Date.now() >= activeUntil) return stop('Your keep-awake session ended. Start another when you need it.');
        if (thisController.signal.aborted) throw new DOMException('Wake timed out.', 'AbortError');
        if (response?.ok) {
          try { if ((await response.json()).status === 'ok') break; } catch {}
        } else if (response && response.status >= 400 && response.status < 500 && response.status !== 429) {
          throw new Error('The address did not return this add-on’s health check. Open your public service address and try again.');
        }
        if (operation !== generation) return;
        if (activeUntil && Date.now() >= activeUntil) return stop('Your keep-awake session ended. Start another when you need it.');
        setStatus('Service is starting or temporarily unreachable; retrying… This can take up to 90 seconds.');
        await retryDelay(thisController.signal);
      }
      if (operation !== generation) return;
      if (thisController.signal.aborted || Date.now() >= deadline) throw new DOMException('Wake timed out.', 'AbortError');
      if (activeUntil && Date.now() >= activeUntil) return stop('Your keep-awake session ended. Start another when you need it.');
      lastSuccess = Date.now();
      setStatus(`Service awake · activity refreshed at ${new Date(lastSuccess).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}.${expires ? ` Next check in 4 minutes; session ends at ${new Date(expires).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}. Keep this page and device running.` : ' The idle window is about 15 minutes from the last request.'}`);
    } catch (error) {
      if (operation !== generation) return;
      if (activeUntil && Date.now() >= activeUntil) return stop('Your keep-awake session ended. Start another when you need it.');
      setStatus(error.name === 'AbortError' || thisController.signal.aborted
        ? 'Could not confirm the service is awake within 90 seconds. Open the service directly, wait for its setup page, then retry.'
        : error.message,true);
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
