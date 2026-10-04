import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, RESOLUTIONS } from '../shared/types.js';
import { buildPayload, eligibleSubscription, inputSchema } from './policy.js';
import { DEFAULT_NEGATIVE_PROMPT } from '../shared/negative.js';

const input = { ...DEFAULT_SETTINGS, mode: 'generate' as const, prompt: '1girl, outdoors' };
test('default negative toggle merges the official preset with custom content in both caption fields', () => {
  for (const enabled of [true, false]) {
    const payload = buildPayload(inputSchema.parse({ ...input, defaultNegative: enabled, negativePrompt: 'blurry, extra fingers' }));
    const expected = enabled ? `${DEFAULT_NEGATIVE_PROMPT}, blurry, extra fingers` : 'blurry, extra fingers';
    assert.equal(payload.parameters.negative_prompt, expected);
    assert.equal(payload.parameters.v4_negative_prompt.caption.base_caption, expected);
  }
  const duplicate = buildPayload(inputSchema.parse({ ...input, negativePrompt: `${DEFAULT_NEGATIVE_PROMPT}, custom` }));
  assert.equal(duplicate.parameters.negative_prompt, `${DEFAULT_NEGATIVE_PROMPT}, custom`);
  const { defaultNegative: _unused, ...legacy } = input;
  assert.equal(inputSchema.parse(legacy).defaultNegative, false);
});
test('rejects paid dimensions, 29–30 steps, invalid seeds, sampler, sample count, and model overrides', () => {
  for (const changes of [{ steps: 29 }, { steps: 30 }, { steps: 22 }, { steps: 23.5 }, { resolution: 'custom' }, { seed: -1 }, { seed: 4294967296 }, { seed: 1.5 }, { seed: "123" }, { sampler: 'ddim' }, { n_samples: 2 }, { model: 'another' }, { guidance: 11 }, { guidance: 0 }])
    assert.equal(inputSchema.safeParse({ ...input, ...changes }).success, false, JSON.stringify(changes));
});
test('enforces exact dimensions, default sampler, and one random seed per request', () => {
  for (const resolution of Object.keys(RESOLUTIONS) as (keyof typeof RESOLUTIONS)[]) {
    const parsed = inputSchema.parse({ ...input, resolution, steps: 28 });
    const payload = buildPayload(parsed);
    assert.equal(payload.model, 'nai-diffusion-5-full');
    assert.equal(payload.action, 'generate');
    assert.equal(payload.parameters.sampler, 'k_euler_ancestral');
    assert.equal(payload.parameters.n_samples, 1);
    assert.equal(payload.parameters.width, RESOLUTIONS[resolution].width);
    assert.ok(payload.parameters.width * payload.parameters.height <= 1_048_576);
    assert.ok(payload.parameters.seed >= 0 && payload.parameters.seed <= 0xffffffff);
  }
});
test('pairs positive and negative character captions and custom positions', () => {
  const payload = buildPayload(inputSchema.parse({ ...input, useCoords: true, characters: [
    { id: 'a', name: 'A', prompt: 'girl, blue eyes', negativePrompt: 'red hair', enabled: true, x: 0.2, y: 0.4 },
    { id: 'b', name: 'B', prompt: 'boy', negativePrompt: '', enabled: false, x: 0.8, y: 0.4 },
  ] }));
  assert.deepEqual(payload.parameters.v4_prompt.caption.char_captions, [{ char_caption: 'girl, blue eyes', centers: [{ x: 0.2, y: 0.4 }] }]);
  assert.equal(payload.parameters.v4_negative_prompt.caption.char_captions[0].char_caption, 'red hair');
  assert.equal(payload.parameters.v4_prompt.use_coords, true);
});
test('uses V5 Full inpainting variant and nested img2img strength', () => {
  const data = inputSchema.parse({ ...input, mode: 'inpaint', strength: 0.55, image: 'image', mask: 'mask' });
  const payload = buildPayload(data, { image: 'canonical-image', mask: 'canonical-mask' });
  assert.equal(payload.model, 'nai-diffusion-5-full-inpainting');
  assert.equal(payload.action, 'infill');
  assert.deepEqual(payload.parameters.img2img, { strength: 0.55, color_correct: true });
  assert.equal(payload.parameters.mask, 'canonical-mask');
  assert.equal(payload.parameters.image, 'canonical-image');
  assert.equal(payload.parameters.extra_noise_seed, (payload.parameters.seed - 1) >>> 0);
  assert.equal(buildPayload({ ...data, strength: 1 }, { image: 'image', mask: 'mask' }).parameters.img2img, undefined);
  assert.equal(inputSchema.safeParse({ ...input, image: 'image' }).success, false);
  assert.equal(inputSchema.safeParse({ ...input, mode: 'inpaint' }).success, false);
});
test('fails closed on missing, expired, non-Opus, or exhausted subscription', () => {
  const now = 1_800_000_000_000;
  const subscription = { tier: 3, expiresAt: now / 1000 + 100, active: true, usage: { percent: 50, isNegative: false } };
  assert.equal(eligibleSubscription(subscription, 1, now), 50);
  for (const invalid of [{}, { ...subscription, tier: 2 }, { ...subscription, active: false }, { ...subscription, expiresAt: now / 1000 - 1 },
    { ...subscription, usage: { percent: 50, isNegative: true } }, { ...subscription, usage: { percent: 0.99, isNegative: false } }, { ...subscription, usage: undefined }]) {
    assert.throws(() => eligibleSubscription(invalid, 1, now));
  }
});

test('fixed seeds including zero reach every generation mode, and omitted/null seeds remain random', () => {
  for (const mode of ['generate', 'img2img', 'inpaint'] as const) {
    const images = mode === 'generate' ? undefined : { image: 'fixture', ...(mode === 'inpaint' ? { mask: 'fixture' } : {}) };
    for (const seed of [0, 123456, 0xffffffff]) {
      const parsed = inputSchema.parse({ ...input, mode, seed, ...images });
      assert.equal(buildPayload(parsed, images).parameters.seed, seed);
      assert.equal(buildPayload(parsed, images).parameters.seed, seed);
      if (images) assert.equal(buildPayload(parsed, images).parameters.extra_noise_seed, (seed - 1) >>> 0);
    }
  }
  const { seed: _seed, ...legacy } = input;
  assert.equal(inputSchema.parse(legacy).seed, null);
  const seeds = new Set(Array.from({ length: 8 }, () => buildPayload(inputSchema.parse({ ...input, seed: null })).parameters.seed));
  assert.ok(seeds.size > 1);
});
