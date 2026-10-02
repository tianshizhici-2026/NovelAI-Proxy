import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApiKeyStore } from './apiKeys.js';
import { AccountStore } from './accounts.js';
import { createApp } from './app.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';

test('only admins can validate and save API keys; keys persist, stay private and replace the upstream token live', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'novelai-keys-'));
  const file = path.join(directory, 'settings.json');
  const keys = new ApiKeyStore(file, 'original-test-key');
  const accounts = new AccountStore(undefined, ['admin', 'user'].map(username => ({ username, password: 'test-password', role: username as 'admin' | 'user', quota: 50, used: 0, totalUsed: 0, bannedUntil: 0 })));
  const received: string[] = [];
  let release: (() => void) | undefined;
  const server = createApp({ accounts, keys, token: '', imageUrl: 'https://upstream.invalid', minUsagePercent: 1 }, async (_url, init) => {
    const authorization = new Headers(init?.headers).get('Authorization')!;
    received.push(authorization);
    if (authorization.includes('invalid-test-key')) return new Response('private rejection body', { status: 401 });
    if (authorization.includes('delayed-test-key')) await new Promise<void>(resolve => { release = resolve; });
    return Response.json({ tier: 3, expiresAt: Date.now() / 1000 + 1000, usage: { percent: 70, isNegative: false } });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api = (route: string, cookie = '', method = 'GET', body?: unknown) => fetch(base + route, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function login(username: string) { return (await api('/api/auth/login', '', 'POST', { username, password: 'test-password' })).headers.get('set-cookie')!.split(';')[0]; }
  try {
    const admin = await login('admin'), user = await login('user');
    assert.equal((await api('/api/admin/api-key')).status, 401);
    assert.equal((await api('/api/admin/api-key', user)).status, 403);
    assert.equal((await api('/api/admin/api-key', user, 'PUT', { apiKey: 'new-test-key' })).status, 403);
    assert.equal(received.length, 0);
    let response = await api('/api/admin/api-key', admin, 'PUT', { apiKey: 'Bearer new-test-key' });
    assert.equal(response.status, 200);
    let body = await response.text(); assert.equal(body.includes('new-test-key'), false); assert.ok(body.includes('configured'));
    assert.equal(new ApiKeyStore(file, 'fallback-test-key').token, 'new-test-key');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal((await api('/api/status', user)).status, 200);
    assert.equal(received.at(-1), 'Bearer new-test-key');
    response = await api('/api/admin/api-key', admin, 'PUT', { apiKey: 'invalid-test-key' });
    assert.equal(response.status, 502);
    body = await response.text(); assert.equal(body.includes('invalid-test-key'), false); assert.equal(body.includes('private rejection'), false);
    assert.equal(keys.token, 'new-test-key');
    assert.equal((await api('/api/admin/api-key', admin, 'PUT', { apiKey: 'bad\nheader' })).status, 400);
    const updating = api('/api/admin/api-key', admin, 'PUT', { apiKey: 'delayed-test-key' });
    const deadline = Date.now() + 2000;
    while (!release) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal((await api('/api/generate', user, 'POST', { ...DEFAULT_SETTINGS, mode: 'generate', prompt: 'test' })).status, 409);
    assert.equal((await api('/api/admin/api-key', admin, 'PUT', { apiKey: 'another-test-key' })).status, 409);
    release(); assert.equal((await updating).status, 200);
  } finally { release?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
