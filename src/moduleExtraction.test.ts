import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composedPrompt, danbooruUrl, DEFAULT_QUALITY_MODULES, extractPromptModules, parsePromptText, quoteNumericTags, roundedPromptWeight, type PromptModule } from '../shared/prompts';
import { modularizeSettings, normalizeMetadata } from './metadata';
import { DEFAULT_SETTINGS } from '../shared/types';
import { buildPayload, inputSchema } from '../server/policy';

const artist: PromptModule = { id: 'artist-current', category: 'artist', name: 'Example', prompt: 'artist:chen bin', url: 'https://example.com' };
const artistTwo: PromptModule = { ...artist, id: 'artist-two', prompt: 'artist:nahaki' };
const library = [artist, artistTwo, ...DEFAULT_QUALITY_MODULES];

test('numeric quality modules quote the whole tag and quoted years import into the original preset', () => {
  const year: PromptModule = { ...artist, category: 'quality', id: 'year-2025', prompt: 'year 2025' };
  for (const source of ['year 2025', '"year 2025"', 'year2025', '"year2025"']) {
    const restored = normalizeMetadata({ Comment: { prompt: `1girl, .8::${source}::`, qualityToggle: false } }, 1024, 1024, [year]);
    assert.equal(restored.settings.prompt, '1girl');
    assert.deepEqual(restored.settings.promptModules, [{ id: year.id, category: 'quality', prompt: year.prompt, weight: .8 }]);
    const payload = buildPayload(inputSchema.parse({ ...DEFAULT_SETTINGS, ...restored.settings, mode: 'generate' }));
    assert.equal(payload.input, '1girl, 0.8::"year 2025"::');
    assert.equal(payload.parameters.v4_prompt.caption.base_caption, payload.input);
  }
  const selected = [{ id: year.id, category: year.category, prompt: '"year 2025"', weight: .8 }];
  assert.equal(composedPrompt('1girl', selected), '1girl, 0.8::"year 2025"::');
  assert.equal(extractPromptModules('forest', [year], selected).modules[0].prompt, 'year 2025');
  const preset = { ...year, prompt: '"year 2025"' };
  assert.equal(extractPromptModules('.8::year 2025::', [preset]).modules[0].id, preset.id);
  assert.equal(composedPrompt('forest', [{ ...selected[0], prompt: 'year 2025, year 2026, 1990s (style)' }]),
    'forest, 0.8::"year 2025", "year 2026", "1990s (style)"::');
});
test('handwritten numeric endings are protected in positive, negative and character prompts in all modes', () => {
  for (const mode of ['generate', 'img2img', 'inpaint'] as const) {
    const payload = buildPayload(inputSchema.parse({ ...DEFAULT_SETTINGS, mode, qualityTags: false, defaultNegative: false,
      prompt: '1girl, 2boys, .8::year2025::', negativePrompt: '-.5::year 2026::',
      characters: [{ id: 'character', name: 'Character', enabled: true, prompt: '1girl, .6::year 2025::', negativePrompt: '-.4::year2026::', x: .5, y: .5 }],
      ...(mode === 'generate' ? {} : { image: 'fixture-image', ...(mode === 'inpaint' ? { mask: 'fixture-mask' } : {}) }),
    }));
    assert.equal(payload.input, '1girl, 2boys, .8::"year2025"::');
    assert.equal(payload.parameters.negative_prompt, '-.5::"year 2026"::');
    assert.equal(payload.parameters.v4_prompt.caption.char_captions[0].char_caption, '1girl, .6::"year 2025"::');
    assert.equal(payload.parameters.v4_negative_prompt.caption.char_captions[0].char_caption, '-.4::"year2026"::');
  }
  const protectedText = quoteNumericTags('1girl, 2boys, .8::year 2025::, artist:docy520, -5::artist collaboration::');
  assert.equal(protectedText, '1girl, 2boys, .8::"year 2025"::, artist:"docy520", -5::artist collaboration::');
  assert.equal(quoteNumericTags(protectedText), protectedText);
  assert.equal(quoteNumericTags('1girl, 2boys, queued-1, year2025'), '1girl, 2boys, queued-1, "year2025"');
});

test('negative suppression presets retain their sign in text import, metadata and generation', () => {
  const parsed = parsePromptText('-5::artist collaboration,::\n抑制画师协作\t-5::artist collaboration::', 'quality');
  assert.equal(parsed.length, 1); assert.equal(parsed[0].prompt, 'artist collaboration'); assert.equal(parsed[0].defaultWeight, -5);
  const suppression: PromptModule = { ...parsed[0], id: 'suppression' };
  const result = normalizeMetadata({ Comment: { prompt: 'forest, -5::artist collaboration,::', qualityToggle: false } }, 1024, 1024, [suppression]);
  assert.equal(result.settings.prompt, 'forest');
  assert.deepEqual(result.settings.promptModules, [{ id: 'suppression', category: 'quality', prompt: 'artist collaboration', weight: -5 }]);
  const payload = buildPayload(inputSchema.parse({ ...DEFAULT_SETTINGS, ...result.settings, mode: 'generate' }));
  assert.equal(payload.input, 'forest, -5.0::artist collaboration::');
  assert.equal(payload.parameters.v4_prompt.caption.base_caption, payload.input);
  assert.equal(roundedPromptWeight(-4.96), -5); assert.equal(roundedPromptWeight(-.004), -.1);
  const stored = normalizeMetadata({ Comment: { prompt: 'forest', qualityToggle: false, novelai_proxy_modules: result.settings.promptModules } }, 1024, 1024, [suppression]);
  assert.deepEqual(stored.settings.promptModules, result.settings.promptModules);
});

test('quoted numeric artist names import into the same preset as unquoted names, with rounded weights', () => {
  const numeric = { ...artist, id: 'artist-numeric', prompt: 'artist:docy520' };
  for (const name of ['artist:docy520', 'artist:"docy520"', 'artist: "DOCY520"', 'artist::"docy520"']) {
    const result = normalizeMetadata({ Comment: { prompt: `.34::${name}::, forest`, qualityToggle: false } }, 1024, 1024, [...library, numeric]);
    assert.equal(result.settings.prompt, 'forest');
    assert.deepEqual(result.settings.promptModules, [{ id: numeric.id, category: 'artist', prompt: numeric.prompt, weight: .3 }]);
  }
  const quotedPreset = { ...numeric, prompt: 'artist:"docy520"' };
  assert.equal(extractPromptModules('.3::artist:docy520::', [quotedPreset]).modules[0].id, numeric.id);
  const saved = extractPromptModules('forest', [numeric], [{ id: 'old', category: 'artist', prompt: 'artist:"docy520"', weight: .34 }]);
  assert.deepEqual(saved.modules, [{ id: numeric.id, category: 'artist', prompt: numeric.prompt, weight: .3 }]);
  assert.equal(danbooruUrl('artist:"docy520"'), danbooruUrl('artist:docy520'));
});
test('numeric artist modules generate quoted names and round-trip without duplicate quotation marks', () => {
  for (const prompt of ['artist:docy520', 'artist:"docy520"']) {
    const numeric = { ...artist, id: 'numeric', prompt };
    const modules = [{ id: numeric.id, category: numeric.category, prompt, weight: .3 }];
    const payload = buildPayload(inputSchema.parse({ ...DEFAULT_SETTINGS, prompt: 'forest', promptModules: modules, qualityTags: false, mode: 'generate' }));
    assert.equal(payload.input, '0.3::artist:"docy520"::, forest');
    const restored = normalizeMetadata({ Comment: { prompt: payload.input, qualityToggle: false } }, 1024, 1024, [numeric]);
    assert.equal(restored.settings.prompt, 'forest'); assert.deepEqual(restored.settings.promptModules, modules);
  }
  assert.equal(composedPrompt('forest', [{ id: 'group', category: 'artist', prompt: 'artist:docy520, artist:chen bin, artist:xxx123', weight: .8 }]),
    '0.8::artist:"docy520", artist:chen bin, artist:"xxx123"::, forest');
});
test('quoted names keep literal punctuation and unknown artists in the remaining prompt', () => {
  const literal = { ...artist, id: 'literal', prompt: 'artist:"test,{520}::name"' };
  const result = extractPromptModules('.3::artist:"test,{520}::name"::, .6::artist:"unknown520"::, forest', [literal]);
  assert.equal(result.modules[0].weight, .3);
  assert.equal(result.prompt, '.6::artist:"unknown520"::, forest');
});

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
