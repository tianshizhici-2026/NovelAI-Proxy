import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_QUALITY_MODULES, extractPromptModules, roundedPromptWeight, type PromptModule } from '../shared/prompts';
import { modularizeSettings, normalizeMetadata } from './metadata';
import { DEFAULT_SETTINGS } from '../shared/types';
import { buildPayload, inputSchema } from '../server/policy';

const artist: PromptModule = { id: 'artist-current', category: 'artist', name: 'Example', prompt: 'artist:chen bin', url: 'https://example.com' };
const artistTwo: PromptModule = { ...artist, id: 'artist-two', prompt: 'artist:nahaki' };
const library = [artist, artistTwo, ...DEFAULT_QUALITY_MODULES];

test('legacy numeric artist/style strings become modules, using current template IDs and rounded weights', () => {
  const result = extractPromptModules('0.21::artist:chen bin::, forest, 1.776::artist:nahaki::, .34::masterpiece::, unknown', library);
  assert.equal(result.prompt, 'forest, unknown');
  assert.deepEqual(result.modules.map(m => [m.id, m.prompt, m.weight]), [
    ['artist-current', 'artist:chen bin', 0.2], ['artist-two', 'artist:nahaki', 1.8], ['quality-1', 'masterpiece', 0.3],
  ]);
  const year = extractPromptModules('0.8::year 2026::, 0.55::sunset::', library);
  assert.equal(year.modules[0].prompt, 'year 2026'); assert.equal(year.modules[0].weight, .8); assert.equal(year.prompt, '0.55::sunset::');
  const alias = extractPromptModules('chen_bin, artist::nahaki, outdoors', library);
  assert.equal(alias.prompt, 'outdoors'); assert.equal(alias.modules.length, 2);
});
test('decimal weights round half up with a minimum of 0.1, including very small legacy values', () => {
  for (const [value, expected] of [[0, .1], [.004, .1], [.049, .1], [.05, .1], [.096, .1], [.15, .2], [.35, .4], [.55, .6], [.95, 1], [1.776, 1.8], [2.05, 2.1], [4.46, 4.5]]) {
    assert.equal(roundedPromptWeight(value), expected, String(value));
    assert.equal(extractPromptModules(`${value}::artist:chen bin::`, library).modules[0].weight, expected);
  }
});
test('brace weights and partially known weighted groups preserve unknown text and its original emphasis', () => {
  const result = extractPromptModules('{{artist:chen bin}}, 0.56::masterpiece, sunset::, [watercolor], unknown', library);
  assert.deepEqual(result.modules.map(m => [m.prompt, m.weight]), [['artist:chen bin', 1.1], ['masterpiece', .6], ['watercolor', 1]]);
  assert.equal(result.prompt, '0.56:: sunset::, unknown');
  const unclosed = extractPromptModules('{{{artist:chen bin ::, unknown', library);
  assert.equal(unclosed.prompt, 'unknown'); assert.equal(unclosed.modules[0].weight, 1.2);
});
test('match whole tags and the longest configured group, without altering substrings, escaped text or unmatched groups', () => {
  const group: PromptModule = { id: 'quality-group', category: 'quality', name: 'Quality', prompt: 'masterpiece, very aesthetic', url: 'https://example.com' };
  const result = extractPromptModules('1.25::masterpiece, very aesthetic::, ocean', [...library, group]);
  assert.equal(result.prompt, 'ocean'); assert.deepEqual(result.modules.map(m => [m.id, m.weight]), [['quality-group', 1.3]]);
  for (const prompt of ['very detailed, super-realistic, artist:chen binned', 'semi-{realistic}, unknown', String.raw`\{masterpiece\}, artist:unknown, unknown\,`, '0.21::artist:unknown, landscape painting::, ||rain|sun||']) {
    const unchanged = extractPromptModules(prompt, library); assert.equal(unchanged.prompt, prompt); assert.deepEqual(unchanged.modules, []);
  }
});
test('new module metadata is normalized and rebound by tag rather than obsolete IDs, with no duplicated tags', () => {
  const result = normalizeMetadata({ Comment: { prompt: '0.21::artist:chen bin::, forest, masterpiece', seed: 7, novelai_proxy_modules: [
    { id: 'old-server-id', category: 'artist', prompt: 'artist:chen_bin', weight: .004 },
  ] } }, 1024, 1024, library);
  assert.equal(result.settings.prompt, 'forest'); assert.equal(result.settings.seed, 7);
  assert.deepEqual(result.settings.promptModules?.map(m => [m.id, m.weight]), [['artist-current', .1], ['quality-1', 1]]);
});
test('old original captions retain scene/character/negative parameters and extract the implicit quality suffix at actual weight 1', () => {
  const result = normalizeMetadata({ Comment: {
    prompt: 'full resolved prompt', seed: 123, strength: .55, noise: .2, qualityToggle: true,
    v4_prompt_original: { caption: { base_caption: '.04::artist:chen bin::, forest', char_captions: [{ char_caption: 'girl, masterpiece', centers: [{ x: 0, y: 1 }] }] } },
    uc: 'blurry, masterpiece',
  } }, 1024, 1024, library);
  assert.equal(result.settings.prompt, 'forest'); assert.equal(result.settings.qualityTags, false);
  assert.deepEqual(result.settings.promptModules?.map(m => [m.prompt, m.weight]), [['artist:chen bin', .1], ['very aesthetic', 1], ['masterpiece', 1], ['no text', 1]]);
  assert.equal(result.settings.characters?.[0].prompt, 'girl, masterpiece'); assert.equal(result.settings.negativePrompt, 'blurry, masterpiece');
  assert.equal(result.settings.seed, 123); assert.equal(result.settings.strength, .55);
});
test('history settings use the same conversion and imported weights above 3 can generate and round-trip', () => {
  const settings = modularizeSettings({ ...DEFAULT_SETTINGS, prompt: '4.46::artist:chen bin::, forest', qualityTags: false }, library);
  const payload = buildPayload(inputSchema.parse({ ...settings, mode: 'generate' }));
  assert.equal(payload.input, '4.5::artist:chen bin::, forest');
  const twice = modularizeSettings(settings, library); assert.deepEqual(twice, settings);
});
test('module capacity does not remove tags that cannot fit, and repeated tags do not duplicate module rows', () => {
  const previous = Array.from({ length: 100 }, (_, i) => ({ id: `saved-${i}`, category: 'artist' as const, prompt: `artist:saved${i}`, weight: .8 }));
  const result = extractPromptModules('masterpiece, forest', library, previous); assert.equal(result.prompt, 'masterpiece, forest'); assert.equal(result.modules.length, 100);
  const duplicate = extractPromptModules('masterpiece, masterpiece, forest', library); assert.equal(duplicate.modules.length, 1); assert.equal(duplicate.prompt, 'forest');
});
