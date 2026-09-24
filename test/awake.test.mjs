import test from 'node:test';
import assert from 'node:assert/strict';
import { mountAwake } from '../public/awake.mjs';

const FOUR_MINUTES = 4 * 60 * 1000;
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

const healthy = () => ({ ok: true, json: async () => ({ status: 'ok' }) });

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

test('unhealthy responses and fetch failures show errors, then a scheduled retry can recover', async (context) => {
  const { elements, calls } = setup(context, async (_call, index) => {
    if (index === 1) return { ok: false, json: async () => ({ status: 'ok' }) };
    if (index === 2) throw new Error('The network is unavailable.');
    if (index === 3) return { ok: true, json: async () => ({ status: 'starting' }) };
    return healthy();
  });
  elements['awake-start'].click();
  await settle();
  assert.match(elements['wake-status'].textContent, /still starting/);
  assert.equal(elements['wake-status'].classList.contains('error'), true);
  assert.equal(elements['awake-stop'].disabled, false);
  context.mock.timers.tick(FOUR_MINUTES);
  await settle();
  assert.match(elements['wake-status'].textContent, /network is unavailable/);
  context.mock.timers.tick(FOUR_MINUTES);
  await settle();
  assert.match(elements['wake-status'].textContent, /still starting/);
  context.mock.timers.tick(FOUR_MINUTES);
  await settle();
  assert.equal(calls.length, 4);
  assert.match(elements['wake-status'].textContent, /Service awake/);
  assert.equal(elements['wake-status'].classList.contains('error'), false);
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
  assert.match(elements['wake-status'].textContent, /did not respond in time/);
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
