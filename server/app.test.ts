import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import sharp from 'sharp';
import { zipSync } from 'fflate';
import { createApp, type Config } from './app.js';
import { AccountStore } from './accounts.js';
import { DEFAULT_SETTINGS } from '../shared/types.js';
import { pngMetadata, normalizeMetadata } from '../src/metadata.js';
import { withPngMetadata } from '../shared/png.js';

const config: Config = { accounts: new AccountStore(undefined, [{ username: 'test-admin', password: 'test-password', role: 'admin', quota: 0, used: 0, totalUsed: 0, bannedUntil: 0 }]), token: 'test-only-secret', imageUrl: 'https://upstream.invalid', minUsagePercent: 1 };
const subscription = () => ({ tier: 3, expiresAt: Date.now() / 1000 + 1000, usage: { percent: 50, isNegative: false } });
const input = { ...DEFAULT_SETTINGS, prompt: 'forest', resolution: 'square', mode: 'generate' };
const cookies = new Map<string, string>();
const authenticatedFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  const cookie = cookies.get(new URL(String(input)).origin);
  if (cookie) headers.set('Cookie', cookie);
  return fetch(input, { ...init, headers });
};
async function running(app: ReturnType<typeof createApp>, fn: (url: string) => Promise<void>) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const login = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test-admin', password: 'test-password' }) });
  cookies.set(url, login.headers.get('set-cookie')!.split(';')[0]);
  try { await fn(url); }
  finally { cookies.delete(url); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
function post(url: string, body: unknown) { return authenticatedFetch(url + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }

test('no token gives an explicit unconfigured status and never calls upstream', async () => {
  await running(createApp({ ...config, token: '' }, async () => { throw new Error('must not call'); }), async url => {
    const status = await (await authenticatedFetch(url + '/api/status')).json();
    assert.equal(status.configured, false); assert.equal(status.ready, false);
    assert.equal((await post(url, input)).status, 503);
  });
});
test('invalid or exhausted requests never call the generation endpoint', async () => {
  const calls: string[] = [];
  const mockFetch: typeof fetch = async url => { calls.push(String(url)); return Response.json({ ...subscription(), usage: { percent: 0, isNegative: true } }); };
  await running(createApp(config, mockFetch), async url => {
    assert.equal((await post(url, { ...input, steps: 30 })).status, 400);
    assert.equal(calls.length, 0);
    assert.equal((await post(url, input)).status, 403);
    assert.deepEqual(calls, ['https://upstream.invalid/user/subscription']);
  });
});
test('untrusted origin is rejected before any upstream work', async () => {
  await running(createApp(config, async () => { throw new Error('must not call'); }), async url => {
    const response = await authenticatedFetch(url + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.invalid' }, body: JSON.stringify(input) });
    assert.equal(response.status, 403);
  });
});
test('public reverse-proxy origin is allowed alongside direct same-host requests', async () => {
  const publicOrigin = 'https://proxy.example:8443';
  await running(createApp({ ...config, publicOrigin }, async () => { throw new Error('must not call'); }), async url => {
    for (const origin of [publicOrigin, new URL(url).origin]) {
      const response = await authenticatedFetch(url + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, 'INVALID_PARAMETERS');
    }
  });
});
test('public origin allowlist keeps scheme, port and host exact and ignores forged forwarding headers', async () => {
  const publicOrigin = 'https://proxy.example:8443';
  await running(createApp({ ...config, publicOrigin }, async () => { throw new Error('must not call'); }), async url => {
    for (const origin of ['http://proxy.example:8443', 'https://proxy.example', 'https://other.example:8443', 'https://proxy.example:8443/path', 'null', 'malformed']) {
      const response = await authenticatedFetch(url + '/api/generate', { method: 'POST', headers: {
        'Content-Type': 'application/json', Origin: origin,
        'X-Forwarded-Host': new URL(publicOrigin).host,
      }, body: JSON.stringify(input) });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, 'ORIGIN_REJECTED');
    }
  });
});
test('decodes zipped upstream output, forces parameters, and keeps token off responses', async () => {
  const png = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#445566' } }).png().toBuffer();
  let payload: Record<string, any> = {};
  const mockFetch: typeof fetch = async (url, options) => {
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer test-only-secret');
    if (String(url).endsWith('/user/subscription')) return Response.json(subscription());
    payload = JSON.parse(options!.body as string);
    return new Response(zipSync({ 'image_0.png': new Uint8Array(png) }));
  };
  await running(createApp(config, mockFetch), async url => {
    const response = await post(url, input);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(payload.parameters.n_samples, 1); assert.equal(payload.parameters.sampler, 'k_euler_ancestral');
    const result = Buffer.from(await response.arrayBuffer());
    assert.equal((await sharp(result).metadata()).width, 1024);
    assert.equal(result.includes(Buffer.from('test-only-secret')), false);
    const metadata = pngMetadata(result);
    const comment = JSON.parse(String(metadata.Comment));
    assert.equal(comment.seed, payload.parameters.seed);
    assert.equal(comment.model, payload.model);
    assert.equal(comment.mode, 'generate');
    assert.equal(normalizeMetadata(metadata, 1024, 1024).settings.prompt, 'forest');
    assert.equal(normalizeMetadata(metadata, 1024, 1024).settings.qualityTags, true);
  });
});
test('optional quote refuses nonzero and unknown costs', async () => {
  for (const quote of [{ price: 5 }, {}, { price: '0' }]) {
    await running(createApp({ ...config, priceUrl: 'https://upstream.invalid/price' }, async url => Response.json(String(url).endsWith('/user/subscription') ? subscription() : quote)), async url => {
      const response = await post(url, input); assert.equal(response.status, 403);
      assert.equal((await response.json()).code, 'NONZERO_PRICE');
    });
  }
});
test('inpaint endpoint sends the complete source and a separate binary mask, then blends edges', async () => {
  const original = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const generated = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#0000ff' } }).png().toBuffer();
  const maskPixels = Buffer.alloc(1024 * 1024);
  for (let y = 384; y < 640; y++) maskPixels.fill(255, y * 1024 + 384, y * 1024 + 640);
  const mask = await sharp(maskPixels, { raw: { width: 1024, height: 1024, channels: 1 } }).png().toBuffer();
  const dataUrl = (buffer: Buffer) => `data:image/png;base64,${buffer.toString('base64')}`;
  const mockFetch: typeof fetch = async (url, options) => {
    if (String(url).endsWith('/user/subscription')) return Response.json(subscription());
    const body = JSON.parse(options!.body as string);
    assert.equal(body.action, 'infill'); assert.equal(body.model, 'nai-diffusion-5-full-inpainting');
    assert.deepEqual(body.parameters.img2img, { strength: 0.55, color_correct: true });
    const source = await sharp(Buffer.from(body.parameters.image, 'base64')).removeAlpha().raw().toBuffer();
    assert.deepEqual(source, await sharp(original).removeAlpha().raw().toBuffer());
    const upstreamMask = await sharp(Buffer.from(body.parameters.mask, 'base64')).grayscale().raw().toBuffer();
    assert.deepEqual(upstreamMask, maskPixels);
    assert.equal(body.parameters.extra_noise_seed, body.parameters.seed - 1);
    assert.equal(body.parameters.noise_schedule, undefined);
    return new Response(generated);
  };
  await running(createApp(config, mockFetch), async url => {
    const response = await post(url, { ...input, mode: 'inpaint', strength: 0.55, image: dataUrl(original), mask: dataUrl(mask) });
    assert.equal(response.status, 200);
    const png = Buffer.from(await response.arrayBuffer());
    const metadata = pngMetadata(png);
    assert.equal(JSON.parse(String(metadata.Comment)).mode, 'inpaint');
    assert.equal(normalizeMetadata(metadata, 1024, 1024).settings.strength, 0.55);
    assert.equal(normalizeMetadata(metadata, 1024, 1024).settings.prompt, 'forest');
    const output = await sharp(png).removeAlpha().raw().toBuffer();
    const pixel = (x: number, y: number) => [...output.subarray((y * 1024 + x) * 3, (y * 1024 + x) * 3 + 3)];
    assert.deepEqual(pixel(512, 512), [0, 0, 255]);
    assert.deepEqual(pixel(0, 0), [255, 0, 0]);
    const edge = pixel(670, 512);
    assert.ok(edge[0] > 0 && edge[0] < 255 && edge[2] > 0 && edge[2] < 255, `edge ${edge}`);
    assert.deepEqual([...output.subarray(-3)], [255, 0, 0]);
  });
});
test('Image2Image sends strength/noise without a mask and downloads complete importable metadata', async () => {
  const original = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const generated = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#0000ff' } }).png().toBuffer();
  for (const strength of [0.01, 0.63, 1]) {
    const noise = strength === 0.01 ? 0 : 0.27;
    let payload: Record<string, any> = {};
    const mockFetch: typeof fetch = async (url, options) => {
      if (String(url).endsWith('/user/subscription')) return Response.json(subscription());
      payload = JSON.parse(String(options?.body));
      assert.equal(payload.action, 'img2img');
      assert.equal(payload.model, 'nai-diffusion-5-full');
      assert.equal(payload.parameters.strength, strength);
      assert.equal(payload.parameters.noise, noise);
      assert.equal(payload.parameters.color_correct, false);
      assert.equal(payload.parameters.mask, undefined);
      assert.equal(payload.parameters.img2img, undefined);
      assert.deepEqual(await sharp(Buffer.from(payload.parameters.image, 'base64')).raw().toBuffer(), await sharp(original).raw().toBuffer());
      // The upstream may return a resolved prompt and seed: retain them through the proxy.
      return new Response(withPngMetadata(generated, { Comment: JSON.stringify({ seed: 123456, prompt: 'resolved prompt', upstream_marker: 'retained' }) }));
    };
    await running(createApp(config, mockFetch), async url => {
      const character = { id: 'a', name: 'A', prompt: 'blue hair', negativePrompt: 'hat', enabled: true, x: 0.2, y: 0.8 };
      const response = await post(url, { ...input, mode: 'img2img', prompt: '雨后的森林', negativePrompt: 'blurry', characters: [character], useCoords: true, strength, noise, image: `data:image/png;base64,${original.toString('base64')}` });
      assert.equal(response.status, 200);
      const png = Buffer.from(await response.arrayBuffer());
      const metadata = pngMetadata(png), comment = JSON.parse(String(metadata.Comment));
      assert.equal(comment.seed, 123456);
      assert.equal(comment.upstream_marker, 'retained');
      assert.equal(comment.image, undefined);
      assert.equal(comment.mask, undefined);
      assert.equal(comment.mode, 'img2img');
      const settings = normalizeMetadata(metadata, 1024, 1024).settings;
      assert.equal(settings.prompt, '雨后的森林');
      assert.equal(settings.strength, strength); assert.equal(settings.noise, noise);
      assert.equal(settings.negativePrompt, 'blurry');
      assert.equal(settings.characters?.[0].prompt, 'blue hair');
      assert.equal(settings.characters?.[0].negativePrompt, 'hat');
      assert.equal(settings.characters?.[0].x, 0.2); assert.equal(settings.useCoords, true);
      assert.deepEqual(await sharp(png).raw().toBuffer(), await sharp(generated).raw().toBuffer());
      assert.ok((await sharp(png).metadata()).comments?.some(c => c.keyword === 'Comment'));
    });
  }
});
test('invalid Image2Image references and ranges never call upstream', async () => {
  const small = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ff0000' } }).png().toBuffer();
  await running(createApp(config, async () => { throw new Error('must not call'); }), async url => {
    const image = `data:image/png;base64,${small.toString('base64')}`;
    for (const changes of [{}, { image, mask: image }, { image, noise: 1.01 }, { image, strength: -0.1 }, { image, strength: 0 }, { image, strength: 0.009 }, { image: 'invalid' }, { image }]) {
      assert.equal((await post(url, { ...input, mode: 'img2img', ...changes })).status, 400);
    }
  });
});
test('upstream errors are sanitized and generation is never automatically retried', async () => {
  let attempts = 0;
  const mockFetch: typeof fetch = async url => {
    if (String(url).endsWith('/user/subscription')) return Response.json(subscription());
    attempts++; return new Response('test-only-secret upstream details', { status: 500 });
  };
  await running(createApp(config, mockFetch), async url => {
    const response = await post(url, input);
    assert.equal(response.status, 502); assert.equal((await response.text()).includes('test-only-secret'), false);
    assert.equal(attempts, 1);
  });
});
test('concurrent generation waits and continues after the preceding job fails', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const mockFetch: typeof fetch = async url => {
    if (String(url).endsWith('/user/subscription')) { calls++; await held; return Response.json(subscription()); }
    return new Response('', { status: 500 });
  };
  await running(createApp(config, mockFetch), async url => {
    const first = post(url, input);
    while (!calls) await new Promise(resolve => setTimeout(resolve, 5));
    const second = post(url, input);
    const deadline = Date.now() + 3000;
    while ((await (await authenticatedFetch(url + '/api/queue')).json()).waiting !== 1) {
      assert.ok(Date.now() < deadline, 'second job must enter the queue');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    release(); assert.equal((await first).status, 502);
    assert.equal((await second).status, 502);
    assert.equal((await post(url, input)).status, 502);
  });
});
