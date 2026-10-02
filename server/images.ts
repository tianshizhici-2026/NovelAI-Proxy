import sharp from 'sharp';
import { unzipSync } from 'fflate';
import { ApiError } from './policy.js';

function decodePng(data: string) {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(data))
    throw new ApiError(400, '底图和蒙版必须为 PNG。', 'INVALID_IMAGE');
  return Buffer.from(data.split(',')[1], 'base64');
}

// Inpainting operates on an 8px latent grid. Use the same centre samples as
// the official nearest-neighbour resize, without smoothing mask boundaries.
function latentMask(pixels: Buffer, width: number, height: number) {
  const smallWidth = width / 8, smallHeight = height / 8;
  const small = Buffer.alloc(smallWidth * smallHeight);
  for (let y = 0; y < smallHeight; y++) for (let x = 0; x < smallWidth; x++)
    small[y * smallWidth + x] = pixels[(y * 8 + 4) * width + x * 8 + 4] > 155 ? 255 : 0;
  return small;
}

function expandMask(pixels: Buffer, width: number, height: number) {
  const expanded = Buffer.alloc(width * height * 64);
  for (let y = 0; y < height * 8; y++) for (let x = 0; x < width * 8; x++)
    expanded[y * width * 8 + x] = pixels[Math.floor(y / 8) * width + Math.floor(x / 8)];
  return expanded;
}

function dilateMask(pixels: Buffer, width: number, height: number, radius: number) {
  const stride = width + 1, sums = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y + 1) * stride + x + 1;
    sums[i] = (pixels[y * width + x] ? 1 : 0) + sums[i - 1] + sums[i - stride] - sums[i - stride - 1];
  }
  const result = Buffer.alloc(pixels.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const left = Math.max(0, x - radius), right = Math.min(width, x + radius + 1);
    const top = Math.max(0, y - radius), bottom = Math.min(height, y + radius + 1);
    result[y * width + x] = sums[bottom * stride + right] - sums[top * stride + right]
      - sums[bottom * stride + left] + sums[top * stride + left] > 0 ? 255 : 0;
  }
  return result;
}

function featherMask(pixels: Buffer, width: number, height: number) {
  // Two radius-20 box passes, with clamped edges, match the official matte.
  // Keep horizontal sums unrounded until the vertical pass.
  const radius = 20, horizontal = new Uint16Array(pixels.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let sum = 0;
      for (let dx = -radius; dx <= radius; dx++) sum += pixels[row + Math.max(0, Math.min(width - 1, dx))];
      for (let x = 0; x < width; x++) {
        horizontal[row + x] = sum;
        sum += pixels[row + Math.min(width - 1, x + radius + 1)] - pixels[row + Math.max(0, x - radius)];
      }
    }
    const result = Buffer.alloc(pixels.length);
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = -radius; dy <= radius; dy++) sum += horizontal[Math.max(0, Math.min(height - 1, dy)) * width + x];
      for (let y = 0; y < height; y++) {
        // The official worker uses this fixed-point reciprocal for radius 20.
        result[y * width + x] = Math.min(255, Math.floor(sum * 39 / 65536));
        sum += horizontal[Math.min(height - 1, y + radius + 1) * width + x] - horizontal[Math.max(0, y - radius) * width + x];
      }
    }
    pixels = result;
  }
  return pixels;
}

export async function prepareReference(image: string, width: number, height: number, background = '#ffffff') {
  const data = decodePng(image);
  const meta = await sharp(data, { limitInputPixels: 1_048_576 }).metadata().catch(() => null);
  if (!meta || meta.format !== 'png' || meta.width !== width || meta.height !== height || (meta.pages ?? 1) !== 1)
    throw new ApiError(400, '底图、参考图和蒙版尺寸必须与所选分辨率一致。', 'INVALID_IMAGE_SIZE');
  return sharp(data).flatten({ background }).png().toBuffer();
}

export async function prepareInpaint(image: string, mask: string, width: number, height: number) {
  const normalizedImage = await prepareReference(image, width, height);
  const selection = await prepareReference(mask, width, height, '#000000');
  const pixels = await sharp(selection).flatten({ background: '#000000' }).grayscale().raw().toBuffer();
  const small = latentMask(pixels, width, height);
  if (!small.includes(255)) throw new ApiError(400, '请涂抹需要重绘的区域；笔迹过细时请加大画笔。', 'EMPTY_MASK');
  const encode = (data: Buffer) => sharp(data, { raw: { width, height, channels: 1 } }).png().toBuffer();
  const normalizedMask = await encode(expandMask(small, width / 8, height / 8));
  // The generation mask stays binary; only the returned-image matte is widened
  // and feathered. Never blank or crop the source used as model context.
  const blendMask = await encode(featherMask(expandMask(dilateMask(small, width / 8, height / 8, 4), width / 8, height / 8), width, height));
  return { original: normalizedImage, mask: normalizedMask, blendMask, image: normalizedImage.toString('base64'), maskBase64: normalizedMask.toString('base64') };
}

export async function extractImage(data: Uint8Array, width: number, height: number) {
  let result: Uint8Array = data;
  if (data[0] === 0x50 && data[1] === 0x4b) {
    let imageCount = 0;
    const files = unzipSync(data, { filter: file => {
      const valid = /^image[^/]*\.(png|webp)$/i.test(file.name);
      if (!valid) return false;
      if (++imageCount > 1) throw new ApiError(502, '上游返回了多张图片。');
      if (file.originalSize > 16 * 1024 * 1024) throw new ApiError(502, '上游图片过大。');
      return true;
    } });
    const entries = Object.values(files);
    if (entries.length !== 1) throw new ApiError(502, '上游没有返回单张有效图片。');
    result = entries[0];
  }
  const meta = await sharp(result, { limitInputPixels: 1_048_576 }).metadata().catch(() => null);
  if (!meta || !['png', 'webp'].includes(meta.format ?? '') || meta.width !== width || meta.height !== height)
    throw new ApiError(502, '上游图片格式或分辨率不匹配。', 'INVALID_UPSTREAM_IMAGE');
  return meta.format === 'png' ? Buffer.from(result) : sharp(result).png().toBuffer();
}

export async function preserveOutsideMask(generated: Buffer, original: Buffer, mask: Buffer) {
  const { data, info } = await sharp(mask).removeAlpha().grayscale().raw().toBuffer({ resolveWithObject: true });
  const alphaMask = await sharp({ create: { width: info.width, height: info.height, channels: 3, background: '#ffffff' } })
    .joinChannel(data, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
  const edited = await sharp(generated).flatten({ background: '#ffffff' }).ensureAlpha().composite([{ input: alphaMask, blend: 'dest-in' }]).png().toBuffer();
  return sharp(original).composite([{ input: edited, blend: 'over' }]).flatten({ background: '#ffffff' }).png().toBuffer();
}
