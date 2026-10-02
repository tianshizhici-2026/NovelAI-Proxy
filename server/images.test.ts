import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { prepareInpaint, preserveOutsideMask } from './images.js';

const dataUrl = (buffer: Buffer) => `data:image/png;base64,${buffer.toString('base64')}`;
const png = (data: Buffer, width: number, height: number) => sharp(data, { raw: { width, height, channels: 1 } }).png().toBuffer();
const solid = (width: number, height: number, background: string) => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();

test('mask uses centre samples on the 8px grid and a strict 155 threshold', async () => {
  const width = 32, height = 16;
  const original = await solid(width, height, '#aabbcc');
  const selection = Buffer.alloc(width * height);
  selection[4 * width + 4] = 156;
  selection[4 * width + 12] = 155;
  selection[4 * width + 20] = 255;
  selection[0] = 255; // Off-grid pixels must not become standalone selections.
  const prepared = await prepareInpaint(dataUrl(original), dataUrl(await png(selection, width, height)), width, height);
  const mask = await sharp(prepared.mask).grayscale().raw().toBuffer();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    assert.equal(mask[y * width + x], y < 8 && (x < 8 || (x >= 16 && x < 24)) ? 255 : 0);
  assert.deepEqual(await sharp(Buffer.from(prepared.image, 'base64')).raw().toBuffer(), await sharp(original).raw().toBuffer());
});

test('feathered composition keeps source context far away and transitions gradually at the mask', async () => {
  const width = 256, height = 256;
  const original = await solid(width, height, '#ff0000'), generated = await solid(width, height, '#0000ff');
  const selection = Buffer.alloc(width * height);
  for (let y = 96; y < 160; y++) selection.fill(255, y * width + 96, y * width + 160);
  const prepared = await prepareInpaint(dataUrl(original), dataUrl(await png(selection, width, height)), width, height);
  const matte = await sharp(prepared.blendMask).grayscale().raw().toBuffer();
  const binary = await sharp(prepared.mask).grayscale().raw().toBuffer();
  const pixels = await sharp(await preserveOutsideMask(generated, prepared.original, prepared.blendMask)).removeAlpha().raw().toBuffer();
  const pixel = (x: number, y: number) => [...pixels.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
  assert.deepEqual(pixel(128, 128), [0, 0, 255]);
  assert.deepEqual(pixel(0, 0), [255, 0, 0]);
  assert.deepEqual(pixel(255, 255), [255, 0, 0]);
  assert.equal(binary[128 * width + 190], 0);
  assert.ok(matte[128 * width + 190] > 0 && matte[128 * width + 190] < 255);
  const near = pixel(180, 128), far = pixel(200, 128);
  assert.ok(near[2] > far[2] && far[2] > 0);
  assert.ok(near[0] > 0 && near[0] < 255);
  // Blending with an identical generated image must not darken the seam.
  const unchanged = await preserveOutsideMask(original, prepared.original, prepared.blendMask);
  assert.deepEqual(await sharp(unchanged).removeAlpha().raw().toBuffer(), await sharp(original).raw().toBuffer());
});

test('blank, fully transparent, off-grid-only and mismatched masks are rejected', async () => {
  const width = 32, height = 32, original = await solid(width, height, '#ff0000');
  for (const selection of [Buffer.alloc(width * height), Buffer.from([255, ...Array(width * height - 1).fill(0)])])
    await assert.rejects(prepareInpaint(dataUrl(original), dataUrl(await png(selection, width, height)), width, height), /涂抹/);
  const transparent = await sharp({ create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } }).png().toBuffer();
  await assert.rejects(prepareInpaint(dataUrl(original), dataUrl(transparent), width, height), /涂抹/);
  await assert.rejects(prepareInpaint(dataUrl(original), dataUrl(original), 64, 64), /尺寸/);
});
