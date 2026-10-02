import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { AccountStore, type AccountRecord } from './accounts.js';
import { createApp } from './app.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';

const fixtures = (): AccountRecord[] => [
  { username: 'admin', password: 'admin-test', role: 'admin', quota: 0, used: 0, totalUsed: 0, bannedUntil: 0 },
  { username: 'user', password: 'user-test', role: 'user', quota: 1, used: 0, totalUsed: 0, bannedUntil: 0 },
];
const input = { ...DEFAULT_SETTINGS, prompt: 'forest', resolution: 'square', mode: 'generate' };
const subscription = () => ({ tier: 3, expiresAt: Date.now() / 1000 + 1000, usage: { percent: 50, isNegative: false } });
async function running(store: AccountStore, upstream: typeof fetch, fn: (api: (route: string, cookie?: string, method?: string, body?: unknown) => Promise<Response>) => Promise<void>) {
  const server = createApp({ accounts: store, token: 'upstream-test', imageUrl: 'https://upstream.invalid', minUsagePercent: 1 }, upstream).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api = (route: string, cookie = '', method = 'GET', body?: unknown) => fetch(url + route, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try { await fn(api); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
type Api = Parameters<Parameters<typeof running>[2]>[0];
async function login(api: Api, username = 'admin', password = 'admin-test') {
  const response = await api('/api/auth/login', '', 'POST', { username, password });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
  assert.equal(JSON.stringify(await response.json()).includes(password), false);
  return cookie.split(';')[0];
}
const neverFetch: typeof fetch = async () => { throw new Error('upstream must not be called'); };

test('anonymous requests cannot generate or inspect status; users cannot manage accounts; logout invalidates session', async () => {
  await running(new AccountStore(undefined, fixtures()), neverFetch, async api => {
    for (const route of ['/api/status', '/api/auth/me', '/api/admin/accounts']) assert.equal((await api(route)).status, 401);
    assert.equal((await api('/api/generate', '', 'POST', input)).status, 401);
    assert.equal((await api('/api/auth/login', '', 'POST', { username: 'user', password: 'wrong' })).status, 401);
    assert.equal((await api('/api/auth/login', '', 'POST', { username: 'user', password: 'user-test', role: 'admin' })).status, 400);
    const user = await login(api, 'user', 'user-test');
    assert.equal((await api('/api/admin/accounts', user)).status, 403);
    assert.equal((await api('/api/admin/accounts/user', user, 'PATCH', { quota: 999 })).status, 403);
    assert.equal((await api('/api/auth/me', user)).status, 200);
    assert.equal((await api('/api/auth/logout', user, 'POST')).status, 200);
    assert.equal((await api('/api/auth/me', user)).status, 401);
  });
});

test('admin can set quota, refill, ban and unban; ban applies to existing sessions and login; expired bans recover', async () => {
  const store = new AccountStore(undefined, fixtures());
  await running(store, neverFetch, async api => {
    const admin = await login(api);
    const user = await login(api, 'user', 'user-test');
    let response = await api('/api/admin/accounts', admin);
    const body = await response.text();
    assert.equal(body.includes('password'), false); assert.equal(body.includes('user-test'), false);
    assert.equal((await api('/api/admin/accounts/user', admin, 'PATCH', { quota: 50 })).status, 200);
    assert.equal(store.read('user').remaining, 50);
    assert.equal((await api('/api/admin/accounts/user', admin, 'PATCH', { quota: -1 })).status, 400);
    assert.equal((await api('/api/admin/accounts/user', admin, 'PATCH', { role: 'owner' })).status, 400);
    assert.equal((await api('/api/admin/accounts/admin', admin, 'PATCH', { banMinutes: 60 })).status, 403);
    response = await api('/api/admin/accounts/user', admin, 'PATCH', { banMinutes: 60 });
    assert.equal((await response.json()).account.banned, true);
    assert.equal((await api('/api/auth/me', user)).status, 403);
    assert.equal((await api('/api/generate', user, 'POST', input)).status, 403);
    assert.equal((await api('/api/auth/login', '', 'POST', { username: 'user', password: 'user-test' })).status, 403);
    assert.equal((await api('/api/admin/accounts/user', admin, 'PATCH', { banMinutes: 0 })).status, 200);
    assert.equal((await api('/api/auth/me', user)).status, 200);
  });
  const expired = fixtures(); expired[1].bannedUntil = Date.now() - 1000;
  assert.equal(new AccountStore(undefined, expired).active('user').banned, false);
});

test('only successful images consume quota; exhausted user is rejected before upstream; admin is unlimited', async () => {
  const store = new AccountStore(undefined, fixtures());
  const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#445566' } }).png().toBuffer();
  let failure = true, calls = 0;
  const upstream: typeof fetch = async url => {
    calls++;
    if (String(url).endsWith('/user/subscription')) return Response.json(subscription());
    return failure ? new Response('', { status: 500 }) : new Response(png);
  };
  await running(store, upstream, async api => {
    const user = await login(api, 'user', 'user-test');
    assert.equal((await api('/api/generate', user, 'POST', input)).status, 502);
    assert.equal(store.read('user').used, 0);
    failure = false;
    assert.equal((await api('/api/generate', user, 'POST', input)).status, 200);
    assert.equal(store.read('user').used, 1); assert.equal(store.read('user').totalUsed, 1);
    const before = calls;
    const exhausted = await api('/api/generate', user, 'POST', input);
    assert.equal(exhausted.status, 403); assert.equal((await exhausted.json()).code, 'QUOTA_EXHAUSTED');
    assert.equal(calls, before);
    const status = await (await api('/api/status', user)).json();
    assert.equal(status.ready, false); assert.equal(status.account.remaining, 0);
    assert.equal(calls, before);
    const admin = await login(api);
    assert.equal((await api('/api/generate', admin, 'POST', input)).status, 200);
    assert.equal((await api('/api/generate', admin, 'POST', input)).status, 200);
    assert.equal(store.read('admin').remaining, null); assert.equal(store.read('admin').totalUsed, 2);
    assert.equal((await api('/api/admin/accounts/user', admin, 'PATCH', { reset: true })).status, 200);
    assert.equal(store.read('user').used, 0); assert.equal(store.read('user').totalUsed, 1); assert.equal(store.read('user').remaining, 1);
  });
});

test('parallel requests cannot spend the last slot twice; accepted work is counted if banned in flight', async () => {
  const store = new AccountStore(undefined, fixtures());
  const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#445566' } }).png().toBuffer();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  await running(store, async url => {
    if (String(url).endsWith('/user/subscription')) { entered(); await gate; return Response.json(subscription()); }
    return new Response(png);
  }, async api => {
    const user = await login(api, 'user', 'user-test');
    const admin = await login(api);
    const first = api('/api/generate', user, 'POST', input);
    await started;
    assert.equal((await api('/api/admin/accounts/user', admin, 'PATCH', { username: 'renamed' })).status, 409);
    assert.equal((await api('/api/admin/accounts/user', admin, 'DELETE')).status, 409);
    const second = api('/api/generate', user, 'POST', input);
    const deadline = Date.now() + 3000;
    while ((await (await api('/api/queue', user)).json()).waiting !== 1) {
      assert.ok(Date.now() < deadline, 'second job must enter the queue');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await api('/api/admin/accounts/user', admin, 'PATCH', { banMinutes: 60, reset: true });
    release();
    assert.equal((await first).status, 200); assert.equal(store.read('user').used, 1);
    assert.equal((await second).status, 403);
    await api('/api/admin/accounts/user', admin, 'PATCH', { banMinutes: 0 });
    assert.equal((await api('/api/generate', user, 'POST', input)).status, 403);
  });
});

test('usage, quota, reset and bans persist with private file permissions; malformed files fail closed', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'novelai-accounts-test-'));
  try {
    const file = path.join(directory, 'accounts.json');
    writeFileSync(file, JSON.stringify({ version: 1, accounts: fixtures() }), { mode: 0o600 });
    const first = new AccountStore(file);
    first.charge('user'); first.update('user', { quota: 50, banMinutes: 60 });
    const second = new AccountStore(file);
    assert.equal(second.read('user').used, 1); assert.equal(second.read('user').remaining, 49); assert.equal(second.read('user').banned, true);
    second.update('user', { reset: true });
    assert.equal(new AccountStore(file).read('user').totalUsed, 1);
    assert.equal(new AccountStore(file).read('user').remaining, 50);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    writeFileSync(file, '{}'); assert.throws(() => new AccountStore(file));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('repeated bad passwords are rate limited', async () => {
  await running(new AccountStore(undefined, fixtures()), neverFetch, async api => {
    for (let i = 0; i < 10; i++) assert.equal((await api('/api/auth/login', '', 'POST', { username: 'user', password: 'wrong' })).status, 401);
    assert.equal((await api('/api/auth/login', '', 'POST', { username: 'user', password: 'user-test' })).status, 429);
  });
});

test('account CRUD persists identity and usage, revokes sessions and protects administrators', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'novelai-crud-test-'));
  try {
    const file = path.join(directory, 'accounts.json');
    writeFileSync(file, JSON.stringify({ version: 1, accounts: fixtures() }));
    const store = new AccountStore(file);
    await running(store, neverFetch, async api => {
      const admin = await login(api), user = await login(api, 'user', 'user-test');
      assert.equal((await api('/api/admin/accounts', user, 'POST', { username: 'intruder', password: 'test' })).status, 403);
      assert.equal((await api('/api/admin/accounts/user', user, 'DELETE')).status, 403);
      let response = await api('/api/admin/accounts', admin, 'POST', { username: 'new-user', password: 'new-password' });
      assert.equal(response.status, 201);
      const created = (await response.json()).account;
      assert.equal(created.quota, 50); assert.equal(created.role, 'user'); assert.equal(created.password, undefined);
      assert.equal((await api('/api/admin/accounts', admin, 'POST', { username: 'new-user', password: 'other' })).status, 409);
      const oldSession = await login(api, 'new-user', 'new-password');
      store.charge('new-user');
      response = await api('/api/admin/accounts/new-user', admin, 'PATCH', { username: 'renamed-user', password: 'changed-password', quota: 60 });
      assert.equal(response.status, 200);
      assert.equal(store.read('renamed-user').used, 1);
      assert.equal((await api('/api/auth/me', oldSession)).status, 401);
      const renamedSession = await login(api, 'renamed-user', 'changed-password');
      assert.equal((await api('/api/admin/accounts/renamed-user', admin, 'PATCH', { username: 'admin' })).status, 409);
      assert.equal((await api('/api/admin/accounts/admin', admin, 'PATCH', { role: 'user' })).status, 409);
      assert.equal((await api('/api/admin/accounts/admin', admin, 'DELETE')).status, 409);
      assert.equal((await api('/api/admin/accounts/renamed-user', admin, 'PATCH', { role: 'admin' })).status, 200);
      assert.equal((await api('/api/auth/me', renamedSession)).status, 401);
      const promoted = await login(api, 'renamed-user', 'changed-password');
      assert.equal((await api('/api/admin/accounts', promoted)).status, 200);
      assert.equal((await api('/api/admin/accounts/renamed-user', admin, 'DELETE')).status, 200);
      assert.equal((await api('/api/auth/me', promoted)).status, 401);
      assert.equal((await api('/api/admin/accounts', admin, 'POST', { username: 'renamed-user', password: 'replacement' })).status, 201);
      assert.equal((await api('/api/auth/me', promoted)).status, 401);
      assert.equal((await api('/api/admin/accounts/admin', admin, 'PATCH', { password: 'new-admin-password' })).status, 200);
      assert.equal((await api('/api/auth/me', admin)).status, 401);
      await login(api, 'admin', 'new-admin-password');
    });
    const restored = new AccountStore(file);
    assert.equal(restored.authenticate('admin', 'new-admin-password').role, 'admin');
    assert.equal(restored.read('renamed-user').totalUsed, 0);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
