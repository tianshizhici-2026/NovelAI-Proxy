import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createApp } from './app.js';
import { AccountStore } from './accounts.js';
import { PromptStore } from './prompts.js';
import { DEFAULT_SETTINGS, RESOLUTIONS } from '../shared/types.js';
import { composedPrompt, parsePromptText } from '../shared/prompts.js';
import { generationAnlas, upscaleAnlas } from '../shared/anlas.js';
import { pngMetadata, withPngMetadata } from '../shared/png.js';
import { normalizeMetadata } from '../src/metadata.js';

async function fixture(fn: (request: (route: string, body?: unknown, user?: string, method?: string) => Promise<Response>, generated: Record<string, any>[], subscription: Record<string, any>, prompts: PromptStore) => Promise<void>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nai-admin-features-'));
  const prompts = new PromptStore(path.join(dir, '.private', 'prompts.json'));
  const accounts = new AccountStore(undefined, ['admin', 'user'].map(username => ({ username, password: 'test-pass', role: username === 'admin' ? 'admin' as const : 'user' as const, quota: 50, used: 0, totalUsed: 0, bannedUntil: 0 })));
  const subscription = { tier: 3, active: true, expiresAt: Date.now() / 1000 + 3600, trainingStepsLeft: { fixedTrainingStepsLeft: 100, purchasedTrainingSteps: 10 }, usage: { percent: 50, isNegative: false } };
  const generated: Record<string, any>[] = [];
  const app = createApp({ accounts, prompts, token: 'fixture-key', imageUrl: 'https://fixture.invalid', minUsagePercent: 1 }, async (url, init) => {
    if (String(url).endsWith('/user/subscription')) return Response.json(subscription);
    const input = JSON.parse(String(init?.body)); generated.push(input);
    if (String(url).endsWith('/ai/upscale')) {
      assert.equal(input.model, 'nai-diffusion-5-curated'); assert.equal(input.declared_blur_sigma, 0);
      const meta = await sharp(Buffer.from(input.image, 'base64')).metadata();
      return new Response(await sharp({ create: { width: meta.width! * 2, height: meta.height! * 2, channels: 3, background: '#abc' } }).png().toBuffer());
    }
    return new Response(await sharp({ create: { width: input.parameters.width, height: input.parameters.height, channels: 3, background: '#abc' } }).png().toBuffer());
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cookies: Record<string, string> = {};
  for (const username of ['admin', 'user']) {
    const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'test-pass' }) });
    cookies[username] = response.headers.get('set-cookie')!.split(';')[0];
  }
  const request = (route: string, body?: unknown, user = 'admin', method = body === undefined ? 'GET' : 'POST') => fetch(base + route, { method, headers: { Cookie: cookies[user], 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try { await fn(request, generated, subscription, prompts); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
}
const baseInput = { ...DEFAULT_SETTINGS, prompt: 'forest', seed: 12, mode: 'generate' };
test('Medium works for ordinary users in all modes and restores effort/seed/modules from result metadata', async () => {
  await fixture(async (request, generated) => {
    const image = await sharp({ create: { width: 832, height: 1216, channels: 3, background: '#abc' } }).png().toBuffer();
    const mask = await sharp({ create: { width: 832, height: 1216, channels: 3, background: '#fff' } }).png().toBuffer();
    for (const mode of ['generate', 'img2img', 'inpaint']) {
      const response = await request('/api/generate', { ...baseInput, mode, effort: 'medium', steps: 14,
        ...(mode === 'generate' ? {} : { image: `data:image/png;base64,${image.toString('base64')}` }),
        ...(mode === 'inpaint' ? { mask: `data:image/png;base64,${mask.toString('base64')}` } : {}),
      }, 'user');
      assert.equal(response.status, 200);
      const result = Buffer.from(await response.arrayBuffer());
      const metadata = pngMetadata(result), comment = JSON.parse(metadata.Comment);
      assert.equal(comment.effort, 'medium'); assert.equal(comment.steps, 14); assert.equal(comment.seed, 12);
      assert.equal(comment.mode, mode); assert.equal('image' in comment || 'mask' in comment, false);
      const imported = normalizeMetadata(metadata, 832, 1216).settings;
      assert.equal(imported.effort, 'medium'); assert.equal(imported.steps, 14); assert.equal(imported.seed, 12);
      assert.equal(generated.at(-1)!.model, `nai-diffusion-5-full-medium${mode === 'inpaint' ? '-inpainting' : ''}`);
    }
    const account = (await (await request('/api/status', undefined, 'user')).json()).account;
    assert.equal(account.used, 3);
  });
});
test('Medium uses official discounted step pricing before rounding while normal Opus sizes remain free', () => {
  const medium = { ...DEFAULT_SETTINGS, effort: 'medium' as const, steps: 14 };
  assert.equal(generationAnlas(medium, 'generate', true), 0);
  assert.equal(generationAnlas({ ...medium, resolution: 'largePortrait' }, 'generate', true), 26);
  assert.equal(generationAnlas({ ...medium, resolution: 'largePortrait' }, 'img2img', true), 15);
  assert.equal(generationAnlas({ ...DEFAULT_SETTINGS, resolution: 'largePortrait' }, 'generate', true), 39);
});

test('normal users cannot spend Anlas, request large sizes, manage or submit modules, or upscale', async () => {
  await fixture(async (request, generated) => {
    for (const change of [{ useAnlas: true }, { resolution: 'largePortrait' }, { promptModules: [{ id: 'x', category: 'artist', prompt: 'artist:x', weight: 0.8 }] }]) {
      assert.equal((await request('/api/generate', { ...baseInput, ...change }, 'user')).status, 403);
    }
    for (const route of ['/api/admin/prompts', '/api/admin/upscale']) assert.equal((await request(route, {}, 'user')).status, 403);
    const status = await (await request('/api/status', undefined, 'user')).json(); assert.equal(status.anlas, undefined);
    assert.equal(generated.length, 0);
  });
});
test('admins explicitly enable paid generation; all official large presets retain dimensions and metadata', async () => {
  await fixture(async (request, generated) => {
    assert.equal((await request('/api/generate', { ...baseInput, resolution: 'largeSquare' })).status, 403);
    const modules = [{ id: 'artist-test', category: 'artist' as const, prompt: 'artist:example', weight: 0.8 }];
    for (const resolution of ['largePortrait', 'largeLandscape', 'largeSquare', 'wallpaperPortrait', 'wallpaperLandscape'] as const) {
      const response = await request('/api/generate', { ...baseInput, resolution, useAnlas: true, promptModules: modules }); assert.equal(response.status, 200);
      const buffer = Buffer.from(await response.arrayBuffer()); const image = await sharp(buffer).metadata();
      assert.equal(image.width, RESOLUTIONS[resolution].width); assert.equal(image.height, RESOLUTIONS[resolution].height);
      assert.ok(generated.at(-1)!.input.startsWith('0.8::artist:example::, forest'));
      const imported = normalizeMetadata(pngMetadata(buffer), image.width!, image.height!).settings;
      assert.equal(imported.resolution, resolution); assert.deepEqual(imported.promptModules, modules); assert.equal(imported.prompt, 'forest');
    }
  });
});
test('exhausted Opus uses credits only with explicit admin selection and sufficient balance', async () => {
  await fixture(async (request, generated, subscription) => {
    subscription.usage = { percent: 0, isNegative: true };
    const status = await (await request('/api/status')).json(); assert.equal(status.ready, false); assert.equal(status.paidReady, true); assert.equal(status.anlas.total, 110);
    assert.equal((await request('/api/generate', baseInput)).status, 403); assert.equal(generated.length, 0);
    assert.equal((await request('/api/generate', { ...baseInput, useAnlas: true })).status, 200);
    subscription.trainingStepsLeft = { fixedTrainingStepsLeft: 0, purchasedTrainingSteps: 0 };
    assert.equal((await request('/api/generate', { ...baseInput, useAnlas: true })).status, 403); assert.equal(generated.length, 1);
  });
});
test('native 2x upscale checks balance, preserves prompts/seed/modules and rejects oversized input', async () => {
  await fixture(async (request, generated, subscription) => {
    const png = await sharp({ create: { width: 832, height: 1216, channels: 3, background: '#abc' } }).png().toBuffer();
    const original = withPngMetadata(png, { Software: 'NovelAI', Comment: JSON.stringify({ prompt: 'forest', seed: 0, width: 832, height: 1216, novelai_proxy_modules: [] }) });
    const body = { image: `data:image/png;base64,${Buffer.from(original).toString('base64')}` };
    subscription.trainingStepsLeft = { fixedTrainingStepsLeft: 0, purchasedTrainingSteps: 0 };
    assert.equal((await request('/api/admin/upscale', body)).status, 403); assert.equal(generated.length, 0);
    subscription.trainingStepsLeft.purchasedTrainingSteps = 1;
    const response = await request('/api/admin/upscale', body); assert.equal(response.status, 200);
    const buffer = Buffer.from(await response.arrayBuffer()); const meta = await sharp(buffer).metadata();
    assert.equal(meta.width, 1664); assert.equal(meta.height, 2432);
    const comment = JSON.parse(pngMetadata(buffer).Comment); assert.equal(comment.seed, 0); assert.equal(comment.prompt, 'forest'); assert.equal(comment.upscale.factor, 2);
    const large = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: '#abc' } }).png().toBuffer();
    assert.equal((await request('/api/admin/upscale', { image: `data:image/png;base64,${large.toString('base64')}` })).status, 400);
    assert.equal(generated.length, 1);
  });
});
test('prompt CRUD, text import, custom URL and uploaded local preview survive reload', async () => {
  await fixture(async (request, _generated, _subscription, prompts) => {
    const body = { category: 'artist', name: 'Example', prompt: 'artist:example', url: 'https://danbooru.donmai.us/posts?tags=example' };
    const created = await (await request('/api/admin/prompts', body)).json(); const id = created.prompt.id;
    assert.equal((await request(`/api/admin/prompts/${id}`, { ...body, url: 'javascript:alert(1)' }, 'admin', 'PUT')).status, 400);
    assert.equal((await request(`/api/admin/prompts/${id}`, { ...body, name: 'New name' }, 'admin', 'PUT')).status, 200);
    const image = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#abc' } }).png().toBuffer();
    assert.equal((await request(`/api/admin/prompts/${id}/preview`, { image: `data:image/png;base64,${image.toString('base64')}` }, 'admin', 'PUT')).status, 200);
    const preview = await request(`/api/admin/prompts/${id}/preview`); assert.equal(preview.status, 200); assert.equal(preview.headers.get('content-type'), 'image/webp');
    assert.equal((await request(`/api/admin/prompts/${id}/preview`, undefined, 'user')).status, 403);
    assert.ok(prompts.read(id).preview);
    const added = await (await request('/api/admin/prompts/import', { category: 'artist', text: '0.2::artist:example::,备注\nartist:new，备注' })).json(); assert.equal(added.added, 1);
    assert.equal((await request(`/api/admin/prompts/${id}`, undefined, 'admin', 'DELETE')).status, 200);
    assert.equal((await request(`/api/admin/prompts/${id}/preview`)).status, 404);
  });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nai-library-'));
  try {
    writeFileSync(path.join(dir, 'artists.txt'), '0.2::artist:foo::,备注\nfoo，重复\nbar');
    writeFileSync(path.join(dir, 'styles.txt'), 'watercolor 水彩\npainterly 厚涂');
    const file = path.join(dir, 'library.json'); const store = new PromptStore(file, dir);
    assert.equal(store.list().filter(item => item.category === 'artist').length, 2);
    assert.ok(store.list().some(item => item.prompt === 'painterly'));
    assert.equal(store.import('抑制画师协作\t-5::artist collaboration::', 'quality'), 1);
    assert.equal(store.list().find(item => item.prompt === 'artist collaboration')?.defaultWeight, -5);
    assert.deepEqual(new PromptStore(file, dir).list(), store.list());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('weight assembly and current official Anlas formulas cover standard, large and upscale sizes', () => {
  assert.equal(composedPrompt('forest', [{ id: 'x', category: 'artist', prompt: 'artist:x', weight: 0.8 }, { id: 'y', category: 'quality', prompt: 'masterpiece', weight: 0.9 }]), '0.8::artist:x::, forest, 0.9::masterpiece::');
  assert.equal(parsePromptText('1.8::artist::foo::,备注\nbar，备注', 'artist')[0].prompt, 'artist:foo');
  assert.equal(generationAnlas(DEFAULT_SETTINGS, 'generate', true), 0);
  assert.equal(generationAnlas({ ...DEFAULT_SETTINGS, resolution: 'largePortrait' }, 'generate', true), 39);
  assert.equal(upscaleAnlas(832, 1216), 1); assert.equal(upscaleAnlas(1472, 1472), 3); assert.equal(upscaleAnlas(2048, 2048), null);
});
