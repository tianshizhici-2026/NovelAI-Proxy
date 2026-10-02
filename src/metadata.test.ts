import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync, strToU8, zlibSync } from 'fflate';
import { exifMetadata, normalizeMetadata, pngMetadata, stealthMetadata } from './metadata';
import { DEFAULT_NEGATIVE_PROMPT, combinedNegativePrompt } from '../shared/negative';

function png(...chunks: [string, Uint8Array][]) {
  const parts = chunks.map(([type, data]) => {
    const chunk = new Uint8Array(data.length + 12);
    new DataView(chunk.buffer).setUint32(0, data.length);
    chunk.set(strToU8(type), 4); chunk.set(data, 8);
    return chunk;
  });
  const result = new Uint8Array(8 + parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 8;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function concat(...parts: Uint8Array[]) {
  const data = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const p of parts) { data.set(p, offset); offset += p.length; }
  return data;
}
const comment = { prompt: '2girls, 雨上がり', uc: 'blurry', steps: 28, scale: 6.5, width: 1024, height: 1024 };

test('metadata separates a recognised default preset and preserves custom-only negatives exactly', () => {
  for (const uc of [DEFAULT_NEGATIVE_PROMPT, `${DEFAULT_NEGATIVE_PROMPT}, glasses`, 'blurry, lowres']) {
    const settings = normalizeMetadata({ Comment: { ...comment, uc } }, 1024, 1024).settings;
    assert.equal(combinedNegativePrompt(settings.negativePrompt!, settings.defaultNegative!), uc);
    assert.equal(settings.defaultNegative, uc.startsWith(DEFAULT_NEGATIVE_PROMPT));
  }
});

test('reads NovelAI PNG tEXt, compressed zTXt and compressed/uncompressed UTF-8 iTXt', () => {
  const serialized = JSON.stringify(comment);
  for (const [type, data] of [
    ['tEXt', concat(strToU8('Comment\0'), strToU8(serialized))],
    ['zTXt', concat(strToU8('Comment\0\0'), zlibSync(strToU8(serialized)))],
    ['iTXt', concat(strToU8('Comment\0\0\0\0\0'), strToU8(serialized))],
    ['iTXt', concat(strToU8('Comment\0\x01\0\0\0'), zlibSync(strToU8(serialized)))],
  ] as [string, Uint8Array][]) {
    const imported = normalizeMetadata(pngMetadata(png([type, data])), 1024, 1024).settings;
    assert.equal(imported.prompt, comment.prompt);
    assert.equal(imported.negativePrompt, 'blurry');
    assert.equal(imported.resolution, 'square');
    assert.equal(imported.guidance, 6.5);
    assert.equal(imported.qualityTags, false);
  }
});

test('imports V4/V5 character prompts, negative captions, coordinates including zero and original prompts', () => {
  const result = normalizeMetadata({ Comment: {
    ...comment, v4_prompt: { caption: { base_caption: 'actual prompt' } },
    v4_prompt_original: { use_coords: true, caption: { base_caption: '2girls, ||rain|sun||', char_captions: [
      { char_caption: 'girl, silver hair', centers: [{ x: 0, y: 1 }] },
      { char_caption: 'girl, red hair', centers: [{ x: 0.8, y: 0.2 }] },
    ] } },
    v4_negative_prompt: { caption: { base_caption: 'lowres', char_captions: [{ char_caption: 'hat' }, { char_caption: 'glasses' }] } },
  } }, 1024, 1024);
  assert.equal(result.settings.prompt, '2girls, ||rain|sun||');
  assert.equal(result.settings.negativePrompt, 'lowres');
  assert.equal(result.settings.useCoords, true);
  assert.deepEqual(result.settings.characters?.map(c => [c.prompt, c.negativePrompt, c.x, c.y]), [
    ['girl, silver hair', 'hat', 0, 1], ['girl, red hair', 'glasses', 0.8, 0.2],
  ]);
});

test('adapts unsupported generation parameters without importing model, seed or sampler', () => {
  const result = normalizeMetadata({ Comment: JSON.stringify({ ...comment, width: 1536, height: 1024, steps: 50, scale: 20, seed: 123, model: 'other', sampler: 'other' }) }, 1536, 1024);
  assert.equal(result.settings.resolution, 'landscape');
  assert.equal(result.settings.steps, 28);
  assert.equal(result.settings.guidance, 10);
  assert.equal(result.notes.length, 3);
  assert.equal('seed' in result.settings || 'model' in result.settings || 'sampler' in result.settings, false);
  assert.deepEqual(result.settings.characters, []);
  assert.throws(() => normalizeMetadata({ Comment: '{invalid', Description: 'ordinary picture' }, 100, 100), /没有可导入/);
});

test('extracts official alpha LSB gzip metadata in column order and rejects truncated payloads', () => {
  const payload = gzipSync(strToU8(JSON.stringify({ Comment: JSON.stringify(comment) })));
  const length = new Uint8Array(4); new DataView(length.buffer).setUint32(0, payload.length * 8);
  const data = concat(strToU8('stealth_pngcomp'), length, payload);
  const width = 64, height = 64;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let bit = 0; bit < data.length * 8; bit++) {
    const x = Math.floor(bit / height), y = bit % height;
    pixels[(y * width + x) * 4 + 3] = 254 | ((data[Math.floor(bit / 8)] >> (7 - bit % 8)) & 1);
  }
  assert.equal(normalizeMetadata(stealthMetadata(pixels, width, height)!, width, height).settings.prompt, comment.prompt);
  assert.equal(stealthMetadata(new Uint8ClampedArray(4096 * 4).fill(255), 64, 64), null);
  const invalidLength = new Uint8Array(4); new DataView(invalidLength.buffer).setUint32(0, 8192);
  for (let i = 0; i < 32; i++) {
    const bit = 15 * 8 + i, x = Math.floor(bit / height), y = bit % height;
    pixels[(y * width + x) * 4 + 3] = 254 | ((invalidLength[Math.floor(i / 8)] >> (7 - i % 8)) & 1);
  }
  assert.throws(() => stealthMetadata(pixels, width, height), /不完整/);
});

test('reads WebP EXIF UserComment from the nested IFD', () => {
  const content = concat(strToU8('ASCII\0\0\0'), strToU8(JSON.stringify(comment)));
  const bytes = new Uint8Array(44 + content.length), view = new DataView(bytes.buffer);
  bytes.set(strToU8('II')); view.setUint16(2, 42, true); view.setUint32(4, 8, true);
  view.setUint16(8, 1, true); view.setUint16(10, 0x8769, true); view.setUint16(12, 4, true);
  view.setUint32(14, 1, true); view.setUint32(18, 26, true);
  view.setUint16(26, 1, true); view.setUint16(28, 0x9286, true); view.setUint16(30, 7, true);
  view.setUint32(32, content.length, true); view.setUint32(36, 44, true); bytes.set(content, 44);
  for (const type of [1, 7]) {
    view.setUint16(30, type, true);
    assert.equal(normalizeMetadata(exifMetadata(bytes), 1024, 1024).settings.prompt, comment.prompt);
  }
});

test('rejects oversized compressed metadata and incomplete PNG chunks', () => {
  const bomb = concat(strToU8('Comment\0\0'), zlibSync(strToU8('x'.repeat(1024 * 1024 + 1))));
  assert.throws(() => pngMetadata(png(['zTXt', bomb])), /过大/);
  const data = png(['tEXt', strToU8('Comment\0hello')]);
  assert.throws(() => pngMetadata(data.subarray(0, data.length - 2)), /不完整/);
});
