import test from 'node:test';
import assert from 'node:assert/strict';
import { mountAwake } from '../public/awake.mjs';

const FOUR_MINUTES = 4 * 60 * 1000;
const RECOVERY_DELAY = 5000;
const ONE_HOUR = 60 * 60 * 1000;
const START_TIME = Date.UTC(2026, 0, 1, 12);
const settle = () => new Promise((resolve) => setImmediate(resolve));

class Element extends EventTarget {
  value = '';
  textContent = '';
  disabled = false;
  classes = new Set();
  classList = {
    toggle: (name, enabled) => {
      if (enabled) this.classes.add(name);
      else this.classes.delete(name);
    },
    contains: (name) => this.classes.has(name),
  };
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const healthy = () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) });

function setup(context, implementation = async () => healthy(), options = {}) {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: START_TIME });
  const elements = Object.fromEntries(['service-url', 'wake-status', 'wake', 'awake-start', 'awake-stop', 'awake-hours']
    .map((key) => [key, new Element()]));
  elements['service-url'].value = 'https://television.example.test';
  elements['awake-hours'].value = '1';
  elements['awake-stop'].disabled = true;
  const document = new EventTarget();
  document.visibilityState = 'visible';
  const window = new EventTarget();
  window.location = { origin: 'https://television.example.test' };
  const previousGlobals = new Map(['document', 'window'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  const calls = [];
  context.mock.method(globalThis, 'fetch', (url, init = {}) => {
    const call = { url, init };
    calls.push(call);
    return implementation(call, calls.length);
  });
  const controller = mountAwake({ querySelector: (selector) => elements[selector.slice(6, -1)] }, options);
  context.after(() => {
    controller.stop();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { elements, calls, document, window, controller };
}

test('mount is idle; a user wake sends one GET to health without provider URLs, tokens or auth headers', async (context) => {
  const { elements, calls } = setup(context, undefined, { defaultUrl: 'https://my-service.example.test/' });
  assert.equal(elements['service-url'].value, 'https://my-service.example.test/');
  assert.equal(calls.length, 0);
  elements.wake.click();
  assert.equal(calls.length, 1);
  const request = new URL(calls[0].url);
  assert.equal(request.origin, 'https://my-service.example.test');
  assert.equal(request.pathname, '/health');
  assert.deepEqual([...request.searchParams.keys()], ['wake']);
  assert.equal(request.searchParams.get('wake'), String(START_TIME));
  assert.equal(calls[0].init.method ?? 'GET', 'GET');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers, undefined);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  await settle();
  assert.match(elements['wake-status'].textContent, /Service awake/);
  assert.equal(elements['wake-status'].classList.contains('error'), false);
  assert.equal(elements.wake.disabled, false);
  context.mock.timers.tick(FOUR_MINUTES * 2);
  await settle();
  assert.equal(calls.length, 1, 'a one-time wake must not enable periodic requests');
});

test('service addresses containing credentials or access-key paths fail before any request', async (context) => {
  const { elements, calls } = setup(context);
  for (const address of ['https://user:synthetic@example.test', 'https://example.test/private-key/manifest.json',
    'https://example.test/?token=synthetic', 'file:///example', 'not a URL']) {
    elements['service-url'].value = address;
    elements.wake.click();
    await settle();
    assert.equal(calls.length, 0);
    assert.equal(elements['wake-status'].classList.contains('error'), true);
    assert.equal(elements.wake.disabled, false);
    assert.doesNotMatch(elements['wake-status'].textContent, /synthetic|private-key/);
  }
});

test('starting an awake session requests immediately and repeats every four minutes', async (context) => {
  const { elements, calls } = setup(context);
  elements['awake-start'].click();
  assert.equal(calls.length, 1);
  assert.equal(elements['awake-start'].disabled, true);
  assert.equal(elements['awake-stop'].disabled, false);
  assert.equal(elements['service-url'].disabled, true);
  assert.equal(elements['awake-hours'].disabled, true);
  await settle();
  assert.match(elements['wake-status'].textContent, /Next check in 4 minutes/);
  context.mock.timers.tick(FOUR_MINUTES - 1);
  await settle();
  assert.equal(calls.length, 1);
  context.mock.timers.tick(1);
  await settle();
  assert.equal(calls.length, 2);
  context.mock.timers.tick(FOUR_MINUTES);
  await settle();
  assert.equal(calls.length, 3);
});

test('invalid or unbounded session durations are rejected before any activity starts', async (context) => {
  const { elements, calls } = setup(context);
  for (const hours of ['', '0', '-1', 'NaN', 'Infinity', '0.5', '3', '24']) {
    elements['awake-hours'].value = hours;
    elements['awake-start'].click();
    await settle();
    assert.equal(calls.length, 0);
    assert.match(elements['wake-status'].textContent, /Choose a session/);
    assert.equal(elements['wake-status'].classList.contains('error'), true);
    assert.equal(elements['awake-start'].disabled, false);
    assert.equal(elements['awake-stop'].disabled, true);
    assert.equal(elements['service-url'].disabled, false);
  }
  context.mock.timers.tick(ONE_HOUR * 24);
  await settle();
  assert.equal(calls.length, 0);
});

test('stop cancels scheduled work and restores controls without later requests', async (context) => {
  const { elements, calls } = setup(context);
  elements['awake-start'].click();
  await settle();
  elements['awake-stop'].click();
  const stopped = elements['wake-status'].textContent;
  assert.match(stopped, /Keep-awake stopped/);
  assert.equal(elements['awake-start'].disabled, false);
  assert.equal(elements['awake-stop'].disabled, true);
  assert.equal(elements['service-url'].disabled, false);
  assert.equal(elements['awake-hours'].disabled, false);
  assert.equal(calls[0].init.signal.aborted, true);
  context.mock.timers.tick(ONE_HOUR * 4);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(elements['wake-status'].textContent, stopped);
});

test('a session expires at the selected absolute deadline, including after suspended time advances', async (context) => {
  const { elements, calls, document } = setup(context);
  elements['awake-hours'].value = '2';
  elements['awake-start'].click();
  await settle();
  document.visibilityState = 'hidden';
  context.mock.timers.setTime(START_TIME + ONE_HOUR * 3);
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  assert.equal(calls.length, 1, 'resuming an expired session must not ping again');
  assert.match(elements['wake-status'].textContent, /session ended/);
  assert.equal(elements['awake-start'].disabled, false);
  assert.equal(elements['awake-stop'].disabled, true);
  context.mock.timers.tick(FOUR_MINUTES);
  await settle();
  assert.equal(calls.length, 1);
});

test('expiry timer ends the session without sending a request at its deadline', async (context) => {
  const { elements, calls } = setup(context);
  elements['awake-start'].click();
  await settle();
  for (let index = 0; index < 14; index += 1) {
    context.mock.timers.tick(FOUR_MINUTES);
    await settle();
  }
  assert.equal(calls.length, 15, 'initial wake plus checks at minutes 4 through 56');
  context.mock.timers.tick(FOUR_MINUTES);
  await settle();
  assert.equal(calls.length, 15);
  assert.match(elements['wake-status'].textContent, /session ended/);
});

test('visibility resume ends an expired session even when the last success was less than four minutes ago', async (context) => {
  const { elements, calls, document } = setup(context);
  elements['awake-start'].click();
  await settle();
  context.mock.timers.setTime(START_TIME + ONE_HOUR - 60000);
  elements.wake.click();
  await settle();
  assert.equal(calls.length, 2);
  context.mock.timers.setTime(START_TIME + ONE_HOUR + 1);
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  assert.equal(calls.length, 2);
  assert.match(elements['wake-status'].textContent, /session ended/);
  assert.equal(elements['awake-start'].disabled, false);
});

test('a health response arriving after the session deadline cannot report an active session', async (context) => {
  const pending = deferred();
  const { elements, calls } = setup(context, (_call, index) => index === 1 ? Promise.resolve(healthy()) : pending.promise);
  elements['awake-start'].click();
  await settle();
  context.mock.timers.setTime(START_TIME + ONE_HOUR - 1000);
  elements.wake.click();
  assert.equal(calls.length, 2);
  context.mock.timers.setTime(START_TIME + ONE_HOUR + 1);
  pending.resolve(healthy());
  await settle();
  assert.match(elements['wake-status'].textContent, /session ended/);
  assert.equal(elements['awake-start'].disabled, false);
  assert.equal(elements['awake-stop'].disabled, true);
});

test('a request failing after the session deadline ends the session without a retry', async (context) => {
  const pending = deferred();
  const { elements, calls } = setup(context, (_call, index) => index === 1 ? Promise.resolve(healthy()) : pending.promise);
  elements['awake-start'].click();
  await settle();
  context.mock.timers.setTime(START_TIME + ONE_HOUR - 1000);
  elements.wake.click();
  context.mock.timers.setTime(START_TIME + ONE_HOUR + 1);
  pending.reject(new Error('Late network failure'));
  await settle();
  assert.match(elements['wake-status'].textContent, /session ended/);
  assert.equal(elements['wake-status'].classList.contains('error'), false);
  assert.equal(elements['awake-start'].disabled, false);
  context.mock.timers.tick(FOUR_MINUTES * 2);
  await settle();
  assert.equal(calls.length, 2);
});

test('a temporary network error retries after five seconds without exposing raw browser errors', async (context) => {
  const { elements, calls } = setup(context, async (_call, index) => {
    if (index === 1) throw new TypeError('Load failed');
    return healthy();
  });
  elements.wake.click();
  await settle();
  assert.equal(calls.length, 1);
  assert.match(elements['wake-status'].textContent, /starting|unreachable/i);
  assert.match(elements['wake-status'].textContent, /retrying/i);
  assert.doesNotMatch(elements['wake-status'].textContent, /Load failed|Service awake/);
  assert.equal(elements.wake.disabled, true);
  context.mock.timers.tick(RECOVERY_DELAY - 1);
  await settle();
  assert.equal(calls.length, 1);
  context.mock.timers.tick(1);
  await settle();
  assert.equal(calls.length, 2);
  assert.match(elements['wake-status'].textContent, /Service awake/);
  assert.equal(elements['wake-status'].classList.contains('error'), false);
  assert.equal(elements.wake.disabled, false);
  context.mock.timers.tick(FOUR_MINUTES);
  await settle();
  assert.equal(calls.length, 2, 'recovering a one-time wake must not start an awake session');
});

for (const status of [503, 429]) {
  test(`a temporary HTTP ${status} response retries until the real health endpoint is ready`, async (context) => {
    const { elements, calls } = setup(context, async (_call, index) => index === 1
      ? { ok: false, status, json: async () => ({ status: 'starting' }) } : healthy());
    elements.wake.click();
    await settle();
    assert.match(elements['wake-status'].textContent, /retrying/i);
    assert.doesNotMatch(elements['wake-status'].textContent, /Service awake/);
    context.mock.timers.tick(RECOVERY_DELAY);
    await settle();
    assert.equal(calls.length, 2);
    assert.match(elements['wake-status'].textContent, /Service awake/);
    assert.equal(elements['wake-status'].classList.contains('error'), false);
  });
}

test('a non-JSON platform loading page is retried and never mistaken for a healthy service', async (context) => {
  const { elements, calls } = setup(context, async (_call, index) => index === 1
    ? { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in platform loading HTML'); } }
    : healthy());
  elements.wake.click();
  await settle();
  assert.match(elements['wake-status'].textContent, /retrying/i);
  assert.doesNotMatch(elements['wake-status'].textContent, /Unexpected token|Service awake/);
  context.mock.timers.tick(RECOVERY_DELAY);
  await settle();
  assert.equal(calls.length, 2);
  assert.match(elements['wake-status'].textContent, /Service awake/);
});

test('a JSON starting response retries until health explicitly reports ok', async (context) => {
  const { elements, calls } = setup(context, async (_call, index) => index === 1
    ? { ok: true, status: 200, json: async () => ({ status: 'starting' }) } : healthy());
  elements.wake.click();
  await settle();
  assert.match(elements['wake-status'].textContent, /retrying/i);
  assert.doesNotMatch(elements['wake-status'].textContent, /Service awake/);
  context.mock.timers.tick(RECOVERY_DELAY);
  await settle();
  assert.equal(calls.length, 2);
  assert.match(elements['wake-status'].textContent, /Service awake/);
});

test('a terminal 404 gives an actionable wrong-address error with no automatic retry', async (context) => {
  const { elements, calls } = setup(context, async () => ({ ok: false, status: 404, json: async () => ({ status: 'ok' }) }));
  elements.wake.click();
  await settle();
  assert.match(elements['wake-status'].textContent, /address/i);
  assert.match(elements['wake-status'].textContent, /health check/i);
  assert.equal(elements['wake-status'].classList.contains('error'), true);
  assert.equal(elements.wake.disabled, false);
  assert.doesNotMatch(elements['wake-status'].textContent, /Service awake|retrying/i);
  context.mock.timers.tick(90000);
  await settle();
  assert.equal(calls.length, 1);
});

test('repeated temporary failures share one ninety-second deadline and never falsely report awake', async (context) => {
  const attemptTimes = [];
  const { elements, calls } = setup(context, async () => {
    attemptTimes.push(Date.now());
    throw new TypeError('Load failed');
  });
  elements.wake.click();
  await settle();
  for (let elapsed = 0; elapsed < 90000; elapsed += RECOVERY_DELAY) {
    context.mock.timers.tick(RECOVERY_DELAY);
    await settle();
    assert.doesNotMatch(elements['wake-status'].textContent, /Service awake/);
  }
  assert.ok(calls.length > 1, 'transient failures should have been retried');
  assert.ok(attemptTimes.every((time) => time < START_TIME + 90000), 'no attempt may start at or beyond the total deadline');
  assert.match(elements['wake-status'].textContent, /Could not confirm/i);
  assert.match(elements['wake-status'].textContent, /Open the service/i);
  assert.match(elements['wake-status'].textContent, /retry/i);
  assert.doesNotMatch(elements['wake-status'].textContent, /Load failed/);
  assert.equal(elements['wake-status'].classList.contains('error'), true);
  assert.equal(elements.wake.disabled, false);
  const finalCalls = calls.length;
  context.mock.timers.tick(FOUR_MINUTES);
  await settle();
  assert.equal(calls.length, finalCalls, 'one-time wake retries end at the deadline');
});

test('a health body finishing after the total deadline cannot turn timeout into success', async (context) => {
  const body = deferred();
  const { elements, calls } = setup(context, async () => ({ ok: true, status: 200, json: () => body.promise }));
  elements.wake.click();
  await settle();
  context.mock.timers.tick(90000);
  assert.equal(calls[0].init.signal.aborted, true);
  body.resolve({ status: 'ok' });
  await settle();
  assert.match(elements['wake-status'].textContent, /Could not confirm/i);
  assert.doesNotMatch(elements['wake-status'].textContent, /Service awake/);
  assert.equal(elements['wake-status'].classList.contains('error'), true);
  assert.equal(elements.wake.disabled, false);
  context.mock.timers.tick(FOUR_MINUTES);
  await settle();
  assert.equal(calls.length, 1);
});

test('stopping while waiting for recovery cancels retries without overwriting stopped status', async (context) => {
  const { elements, calls } = setup(context, async () => { throw new TypeError('Load failed'); });
  elements['awake-start'].click();
  await settle();
  assert.match(elements['wake-status'].textContent, /retrying/i);
  elements['awake-stop'].click();
  const stopped = elements['wake-status'].textContent;
  assert.match(stopped, /Keep-awake stopped/);
  assert.equal(calls[0].init.signal.aborted, true);
  context.mock.timers.tick(FOUR_MINUTES * 2);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(elements['wake-status'].textContent, stopped);
  assert.equal(elements['awake-start'].disabled, false);
});

test('pagehide cancels a one-time wake waiting for recovery and suppresses stale status', async (context) => {
  const { elements, calls, window } = setup(context, async () => { throw new TypeError('Load failed'); });
  elements.wake.click();
  await settle();
  window.dispatchEvent(new Event('pagehide'));
  const closed = elements['wake-status'].textContent;
  assert.match(closed, /page was closed/);
  assert.equal(calls[0].init.signal.aborted, true);
  context.mock.timers.tick(90000);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(elements['wake-status'].textContent, closed);
});

test('a session expires during a recovery wait instead of sending a late retry', async (context) => {
  const { elements, calls } = setup(context, async (_call, index) => {
    if (index === 1) return healthy();
    throw new TypeError('Load failed');
  });
  elements['awake-start'].click();
  await settle();
  context.mock.timers.setTime(START_TIME + ONE_HOUR - 1000);
  elements.wake.click();
  await settle();
  assert.match(elements['wake-status'].textContent, /retrying/i);
  context.mock.timers.tick(1000);
  await settle();
  assert.match(elements['wake-status'].textContent, /session ended/);
  assert.equal(elements['wake-status'].classList.contains('error'), false);
  assert.equal(elements['awake-start'].disabled, false);
  context.mock.timers.tick(RECOVERY_DELAY * 2);
  await settle();
  assert.equal(calls.length, 2);
});

test('same-origin mode rejects a different service before fetching and permits the current host', async (context) => {
  const { elements, calls } = setup(context, undefined, { sameOriginOnly: true });
  elements['service-url'].value = 'https://different.example.test';
  elements.wake.click();
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(elements['wake-status'].classList.contains('error'), true);
  assert.equal(elements.wake.disabled, false);
  elements['service-url'].value = 'https://television.example.test/';
  elements.wake.click();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).origin, 'https://television.example.test');
  assert.match(elements['wake-status'].textContent, /Service awake/);
});

test('a timed-out request reports failure and an active session still schedules a retry', async (context) => {
  const { elements, calls } = setup(context, (call, index) => {
    if (index > 1) return Promise.resolve(healthy());
    return new Promise((_resolve, reject) => call.init.signal.addEventListener('abort',
      () => reject(new DOMException('Timed out', 'AbortError')), { once: true }));
  });
  elements['awake-start'].click();
  context.mock.timers.tick(90000);
  await settle();
  assert.equal(calls[0].init.signal.aborted, true);
  assert.match(elements['wake-status'].textContent, /Could not confirm/i);
  assert.match(elements['wake-status'].textContent, /Open the service/i);
  assert.equal(elements['wake-status'].classList.contains('error'), true);
  context.mock.timers.tick(FOUR_MINUTES);
  await settle();
  assert.equal(calls.length, 2);
  assert.match(elements['wake-status'].textContent, /Service awake/);
});

test('late aborted results cannot overwrite stopped status or start another timer', async (context) => {
  const pending = deferred();
  const { elements, calls } = setup(context, () => pending.promise);
  elements['awake-start'].click();
  elements['awake-stop'].click();
  const stopped = elements['wake-status'].textContent;
  assert.equal(calls[0].init.signal.aborted, true);
  pending.resolve(healthy());
  await settle();
  assert.equal(elements['wake-status'].textContent, stopped);
  context.mock.timers.tick(FOUR_MINUTES * 2);
  await settle();
  assert.equal(calls.length, 1);
});

test('a stale rejected response cannot overwrite a newer successful session', async (context) => {
  const stale = deferred();
  const { elements, calls } = setup(context, (_call, index) => index === 1 ? stale.promise : Promise.resolve(healthy()));
  elements['awake-start'].click();
  elements['awake-stop'].click();
  elements['awake-start'].click();
  await settle();
  const currentStatus = elements['wake-status'].textContent;
  stale.reject(new DOMException('Old aborted request', 'AbortError'));
  await settle();
  assert.equal(elements['wake-status'].textContent, currentStatus);
  assert.equal(elements['wake-status'].classList.contains('error'), false);
  assert.equal(elements['awake-start'].disabled, true);
  context.mock.timers.tick(FOUR_MINUTES);
  await settle();
  assert.equal(calls.length, 3, 'only the current session may schedule a follow-up');
});

test('returning to a visible page refreshes overdue activity and closing the page stops it', async (context) => {
  const { elements, calls, document, window } = setup(context);
  elements['awake-start'].click();
  await settle();
  document.visibilityState = 'hidden';
  context.mock.timers.setTime(START_TIME + FOUR_MINUTES + 1);
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls.length, 1);
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  assert.equal(calls.length, 2);
  window.dispatchEvent(new Event('pagehide'));
  assert.match(elements['wake-status'].textContent, /page was closed/);
  context.mock.timers.tick(ONE_HOUR);
  await settle();
  assert.equal(calls.length, 2);
});
