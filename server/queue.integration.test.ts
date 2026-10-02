import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import sharp from 'sharp';
import { createApp } from './app.js';
import { AccountStore } from './accounts.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';

const input = { ...DEFAULT_SETTINGS, resolution: 'square', mode: 'generate' };
const subscription = () => ({ tier: 3, expiresAt: Date.now() / 1000 + 1000, usage: { percent: 50, isNegative: false } });
const store = () => new AccountStore(undefined, ['admin', 'user', 'other'].map(username => ({ username, password: 'test-password', role: username === 'admin' ? 'admin' : 'user', quota: 50, used: 0, totalUsed: 0, bannedUntil: 0 })));
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function waitFor(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, 'queue state did not advance'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function running(accounts: AccountStore, upstream: typeof fetch, fn: (url: string) => Promise<void>) {
  const server = createApp({ accounts, token: 'test-token', imageUrl: 'https://upstream.invalid', minUsagePercent: 1 }, upstream).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function login(url: string, username: string) {
  const response = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'test-password' }) });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie')!.split(';')[0];
}
function generate(url: string, cookie: string, id: string, signal?: AbortSignal) {
  return fetch(url + '/api/generate', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Generation-ID': id }, body: JSON.stringify({ ...input, prompt: id }), signal });
}
function get(url: string, cookie: string, route = '/api/queue') { return fetch(url + route, { headers: { Cookie: cookie } }); }
async function png() { return sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#445566' } }).png().toBuffer(); }

test('HTTP accepts one active plus five waiting jobs, rejects overflow, protects positions and executes FIFO with exact charges', async () => {
  const accounts = store(), gate = deferred(), image = await png();
  const order: string[] = [];
  let runningCount = 0, maximum = 0;
  await running(accounts, async (url, init) => {
    if (String(url).endsWith('/user/subscription')) return Response.json(subscription());
    const id = JSON.parse(String(init?.body)).input.split(',')[0];
    order.push(id); maximum = Math.max(maximum, ++runningCount);
    if (id === 'first') await gate.promise;
    runningCount--; return new Response(image);
  }, async url => {
    const admin = await login(url, 'admin'), user = await login(url, 'user'), other = await login(url, 'other');
    const first = generate(url, admin, 'first');
    try {
      await waitFor(async () => order.length === 1);
      const waiting: Promise<Response>[] = [];
      for (let i = 1; i <= 5; i++) {
        waiting.push(generate(url, user, `queued-${i}`));
        await waitFor(async () => (await (await get(url, admin)).json()).waiting === i);
        assert.equal((await (await get(url, user, `/api/queue/queued-${i}`)).json()).position, i);
      }
      const full = await generate(url, other, 'overflow');
      assert.equal(full.status, 409); assert.equal((await full.json()).code, 'BUSY');
      assert.equal((await get(url, other, '/api/queue/queued-1')).status, 404);
      assert.equal((await get(url, '', '/api/queue/queued-1')).status, 401);
      assert.equal((await generate(url, user, 'queued-1')).status, 409);
      assert.equal(accounts.read('user').used, 0);
      const status = await (await get(url, user, '/api/status')).json();
      assert.equal(status.ready, true); assert.equal(status.queue.waiting, 5);
      gate.release();
      assert.equal((await first).status, 200);
      for (const request of waiting) assert.equal((await request).status, 200);
      assert.deepEqual(order, ['first', 'queued-1', 'queued-2', 'queued-3', 'queued-4', 'queued-5']);
      assert.equal(maximum, 1); assert.equal(accounts.read('user').used, 5); assert.equal(accounts.read('other').used, 0);
      assert.deepEqual(await (await get(url, admin)).json(), { generating: false, waiting: 0, capacity: 5 });
    } finally { gate.release(); }
  });
});

test('disconnecting while waiting removes the job and never generates or charges it', async () => {
  const accounts = store(), gate = deferred(), image = await png();
  let calls = 0;
  await running(accounts, async url => {
    if (String(url).endsWith('/user/subscription')) return Response.json(subscription());
    calls++; await gate.promise; return new Response(image);
  }, async url => {
    const admin = await login(url, 'admin'), user = await login(url, 'user');
    const first = generate(url, admin, 'active');
    try {
      await waitFor(async () => calls === 1);
      const controller = new AbortController();
      const pending = generate(url, user, 'cancelled', controller.signal);
      await waitFor(async () => (await (await get(url, admin)).json()).waiting === 1);
      const rejection = assert.rejects(pending, (error: any) => error.name === 'AbortError');
      controller.abort(); await rejection;
      await waitFor(async () => (await (await get(url, admin)).json()).waiting === 0);
      gate.release(); assert.equal((await first).status, 200);
      assert.equal(calls, 1); assert.equal(accounts.read('user').used, 0);
    } finally { gate.release(); }
  });
});

test('quota changes during waiting are rechecked before any upstream work and do not block the next job', async () => {
  const accounts = store(), gate = deferred(), image = await png();
  let calls = 0;
  await running(accounts, async url => {
    if (String(url).endsWith('/user/subscription')) return Response.json(subscription());
    calls++; if (calls === 1) await gate.promise; return new Response(image);
  }, async url => {
    const admin = await login(url, 'admin'), user = await login(url, 'user'), other = await login(url, 'other');
    const first = generate(url, admin, 'active');
    try {
      await waitFor(async () => calls === 1);
      const pending = generate(url, user, 'quota-changed');
      await waitFor(async () => (await (await get(url, admin)).json()).waiting === 1);
      const next = generate(url, other, 'next');
      await waitFor(async () => (await (await get(url, admin)).json()).waiting === 2);
      accounts.update('user', { quota: 0 }); gate.release();
      assert.equal((await first).status, 200);
      const rejected = await pending; assert.equal(rejected.status, 403); assert.equal((await rejected.json()).code, 'QUOTA_EXHAUSTED');
      assert.equal((await next).status, 200);
      assert.equal(calls, 2); assert.equal(accounts.read('user').used, 0); assert.equal(accounts.read('other').used, 1);
    } finally { gate.release(); }
  });
});
