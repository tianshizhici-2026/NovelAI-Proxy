import { pngMetadata, decompressMetadata as decompress } from '../shared/png';
export { pngMetadata } from '../shared/png';
import { RESOLUTIONS, type Character, type Resolution, type Settings } from '../shared/types';
import { splitNegativePrompt } from '../shared/negative';
import { newId } from './id';

const MAX_METADATA = 1024 * 1024;
const decoder = new TextDecoder();
type ObjectData = Record<string, unknown>;
export type MetadataImport = { settings: Partial<Settings>; notes: string[] };
const object = (value: unknown): ObjectData => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectData : {};
const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
function json(value: unknown): ObjectData {
  if (typeof value !== 'string') return object(value);
  if (value.length > MAX_METADATA) throw new Error('图片元数据过大。');
  try { return object(JSON.parse(value)); } catch { return {}; }
}
// NovelAI's WebP UserComment lives in the EXIF sub-IFD.
export function exifMetadata(input: Uint8Array): ObjectData {
  const bytes = decoder.decode(input.subarray(0, 6)) === 'Exif\0\0' ? input.subarray(6) : input;
  const metadata: ObjectData = {};
  if (bytes.length < 8) return metadata;
  const endian = decoder.decode(bytes.subarray(0, 2));
  if (!['II', 'MM'].includes(endian)) return metadata;
  const little = endian === 'II';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, little) !== 42) return metadata;
  const seen = new Set<number>();
  function readIfd(offset: number) {
    if (seen.has(offset) || seen.size >= 4 || offset < 8 || offset + 2 > bytes.length) return;
    seen.add(offset);
    const count = view.getUint16(offset, little);
    if (count > 256 || offset + 2 + count * 12 > bytes.length) throw new Error('EXIF 元数据格式无效。');
    for (let i = 0; i < count; i++) {
      const pos = offset + 2 + i * 12;
      const tag = view.getUint16(pos, little), type = view.getUint16(pos + 2, little);
      const length = view.getUint32(pos + 4, little);
      if (tag === 0x8769 && type === 4 && length === 1) { readIfd(view.getUint32(pos + 8, little)); continue; }
      if (![0x010e, 0x0131, 0x9286].includes(tag) || ![1, 2, 7].includes(type)) continue;
      if (length > MAX_METADATA) throw new Error('图片元数据过大。');
      const start = length <= 4 ? pos + 8 : view.getUint32(pos + 8, little);
      if (start + length > bytes.length) throw new Error('EXIF 元数据格式无效。');
      let data = bytes.subarray(start, start + length);
      let encoding = 'utf-8';
      if (tag === 0x9286 && data.length >= 8) {
        const prefix = decoder.decode(data.subarray(0, 8));
        if (prefix === 'ASCII\0\0\0' || prefix === '\0'.repeat(8)) data = data.subarray(8);
        else if (prefix === 'UNICODE\0') { data = data.subarray(8); encoding = little ? 'utf-16le' : 'utf-16be'; }
      }
      metadata[tag === 0x9286 ? 'Comment' : tag === 0x010e ? 'Description' : 'Software'] = new TextDecoder(encoding).decode(data).replace(/\0+$/, '');
    }
  }
  readIfd(view.getUint32(4, little));
  return metadata;
}
function webpMetadata(bytes: Uint8Array): ObjectData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset + 4, true);
    if (offset + size + 8 > bytes.length) throw new Error('WebP 文件不完整。');
    if (decoder.decode(bytes.subarray(offset, offset + 4)) === 'EXIF') return exifMetadata(bytes.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  return {};
}

// Official format: alpha LSBs, column first, big-endian bit length, gzip JSON.
// https://github.com/NovelAI/novelai-image-metadata/blob/main/nai_meta.py
export function stealthMetadata(pixels: Uint8ClampedArray, width: number, height: number): ObjectData | null {
  const capacity = width * height;
  if (capacity < 19 * 8) return null;
  let bit = 0;
  function read(count: number) {
    if (bit + count * 8 > capacity) throw new Error('隐藏元数据不完整。');
    const result = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < 8; j++, bit++) {
        const x = Math.floor(bit / height), y = bit % height;
        result[i] = (result[i] << 1) | (pixels[(y * width + x) * 4 + 3] & 1);
      }
    }
    return result;
  }
  const magic = decoder.decode(read(15));
  if (!['stealth_pngcomp', 'stealth_pnginfo'].includes(magic)) return null;
  const length = new DataView(read(4).buffer).getUint32(0);
  if (length % 8 || length / 8 > MAX_METADATA) throw new Error('隐藏元数据长度无效。');
  const data = read(length / 8);
  return json(decoder.decode(magic === 'stealth_pngcomp' ? decompress(data, true) : data));
}

export function normalizeMetadata(raw: ObjectData, width: number, height: number): MetadataImport {
  let data = 'Comment' in raw ? json(raw.Comment) : raw;
  if ('Comment' in data) data = json(data.Comment);
  const positive = object(data.v4_prompt_original ?? data.v4_prompt);
  const negative = object(data.v4_negative_prompt_original ?? data.v4_negative_prompt);
  const caption = object(positive.caption), negativeCaption = object(negative.caption);
  const prompt = text(caption.base_caption) ?? text(data.prompt_original) ?? text(data.prompt) ?? text(data.input)
    ?? (/NovelAI/i.test(String(raw.Software ?? raw.Source ?? '')) ? text(raw.Description) : undefined);
  if (prompt === undefined) throw new Error('这张图片没有可导入的 NovelAI 元数据。请使用保留元数据的原始 PNG 或 WebP 图片。');
  const notes: string[] = [];
  function limited(value: string, max: number) {
    if (value.length > max && !notes.includes('过长的提示词已截断。')) notes.push('过长的提示词已截断。');
    return value.slice(0, max);
  }
  const positives = Array.isArray(caption.char_captions) ? caption.char_captions : Array.isArray(data.characterPrompts) ? data.characterPrompts : [];
  const negatives = Array.isArray(negativeCaption.char_captions) ? negativeCaption.char_captions : [];
  if (positives.length > 22) notes.push('仅导入前 22 个角色。');
  const coord = (value: unknown) => Math.min(1, Math.max(0, number(value) ?? 0.5));
  const characters: Character[] = positives.slice(0, 22).map((value, i) => {
    const c = object(value), n = object(negatives[i]);
    const centers = Array.isArray(c.centers) ? c.centers : [];
    const center = object(centers[0]);
    if (centers.length > 1) notes.push(`角色 ${i + 1} 保留第一个位置。`);
    return { id: newId(), name: `角色 ${i + 1}`, enabled: true,
      prompt: limited(text(c.char_caption) ?? text(c.prompt) ?? '', 6000),
      negativePrompt: limited(text(n.char_caption) ?? text(c.uc) ?? text(c.negative_prompt) ?? '', 6000),
      x: coord(center.x ?? c.x), y: coord(center.y ?? c.y) };
  });
  const settings: Partial<Settings> = {
    prompt: limited(prompt, 12000), ...splitNegativePrompt(limited(text(negativeCaption.base_caption) ?? text(data.uc) ?? text(data.negative_prompt) ?? '', 12000)),
    characters, useCoords: positive.use_coords === true || data.use_coords === true,
    // Exported prompts usually already contain the quality suffix.
    qualityTags: typeof data.qualityToggle === 'boolean' ? data.qualityToggle : typeof data.quality_tags === 'boolean' ? data.quality_tags : false,
  };
  const steps = number(data.steps);
  if (steps !== undefined) {
    settings.steps = Math.min(28, Math.max(23, Math.round(steps)));
    if (settings.steps !== steps) notes.push(`原图 ${steps} steps，已调整为 ${settings.steps} steps。`);
  }
  const guidance = number(data.scale) ?? number(data.guidance);
  if (guidance !== undefined) {
    settings.guidance = Math.min(10, Math.max(0.1, guidance));
    if (settings.guidance !== guidance) notes.push(`原图 Guidance ${guidance}，已调整为 ${settings.guidance}。`);
  }
  const strength = number(data.strength) ?? number(object(data.img2img).strength);
  const seed = number(data.seed);
  settings.seed = seed !== undefined && Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff ? seed : null;
  if (strength !== undefined) settings.strength = Math.min(1, Math.max(0.01, strength));
  const noise = number(data.noise);
  if (noise !== undefined) settings.noise = Math.min(1, Math.max(0, noise));
  const w = number(data.width) ?? width, h = number(data.height) ?? height;
  if (w > 0 && h > 0) {
    const ratio = w / h;
    settings.resolution = (Object.keys(RESOLUTIONS) as Resolution[]).sort((a, b) =>
      Math.abs(Math.log(ratio / (RESOLUTIONS[a].width / RESOLUTIONS[a].height))) - Math.abs(Math.log(ratio / (RESOLUTIONS[b].width / RESOLUTIONS[b].height))))[0];
    const target = RESOLUTIONS[settings.resolution];
    if (w !== target.width || h !== target.height) notes.push(`原图 ${w} × ${h}，已适配为 ${target.width} × ${target.height}。`);
  }
  return { settings, notes };
}

export async function importImageMetadata(file: File): Promise<MetadataImport> {
  if (file.size > 20 * 1024 * 1024) throw new Error('请选择不超过 20 MB 的 PNG 或 WebP 图片。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isPng = [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
  const isWebp = decoder.decode(bytes.subarray(0, 4)) === 'RIFF' && decoder.decode(bytes.subarray(8, 12)) === 'WEBP';
  if (!isPng && !isWebp) throw new Error('请选择 NovelAI 导出的 PNG 或 WebP 原图。');
  const raw = isPng ? pngMetadata(bytes) : webpMetadata(bytes);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url; await image.decode();
    const width = image.naturalWidth, height = image.naturalHeight;
    if (width * height > 40_000_000) throw new Error('图片像素尺寸过大。');
    // Prefer editable file metadata; use alpha metadata for stripped files.
    try { return normalizeMetadata(raw, width, height); } catch { /* Try hidden metadata. */ }
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('浏览器无法读取图片元数据。');
    ctx.drawImage(image, 0, 0);
    const hidden = stealthMetadata(ctx.getImageData(0, 0, width, height).data, width, height);
    if (hidden) return normalizeMetadata(hidden, width, height);
    throw new Error('这张图片没有可导入的 NovelAI 元数据。请使用保留元数据的原始 PNG 或 WebP 图片。');
  } finally { URL.revokeObjectURL(url); }
}
