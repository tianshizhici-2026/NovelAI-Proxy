import { Gunzip, Unzlib } from 'fflate';
const MAX_METADATA = 1024 * 1024;
// Add UTF-8 PNG metadata without decoding/re-encoding the image pixels.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function chunk(keyword: string, text: string) {
  const content = encoder.encode(`${keyword}\0\0\0\0\0${text}`);
  const result = new Uint8Array(content.length + 12);
  const view = new DataView(result.buffer);
  view.setUint32(0, content.length);
  result.set(encoder.encode('iTXt'), 4); result.set(content, 8);
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, -4)) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  view.setUint32(result.length - 4, (crc ^ 0xffffffff) >>> 0);
  return result;
}
export function withPngMetadata(png: Uint8Array, metadata: Record<string, string>) {
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => png[i] === byte)) throw new Error('Invalid PNG');
  const parts = [png.subarray(0, 8)];
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let complete = false;
  for (let offset = 8; offset + 12 <= png.length;) {
    const size = view.getUint32(offset), end = offset + size + 12;
    if (end > png.length) throw new Error('Truncated PNG');
    const type = decoder.decode(png.subarray(offset + 4, offset + 8));
    if (type === 'IHDR') {
      parts.push(png.subarray(offset, end), ...Object.entries(metadata).map(([key, value]) => chunk(key, value)));
      offset = end; continue;
    }
    if (type === 'IEND') {
      parts.push(png.subarray(offset, end));
      complete = true; break;
    }
    const text = ['tEXt', 'zTXt', 'iTXt'].includes(type);
    const content = png.subarray(offset + 8, offset + 8 + size);
    const separator = content.indexOf(0);
    if (!text || !(decoder.decode(content.subarray(0, separator)) in metadata)) parts.push(png.subarray(offset, end));
    offset = end;
  }
  if (!complete) throw new Error('Incomplete PNG');
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

export function decompressMetadata(bytes: Uint8Array, gzip: boolean) {
  let size = 0;
  const chunks: Uint8Array[] = [];
  const Stream = gzip ? Gunzip : Unzlib;
  const stream = new Stream(chunk => {
    size += chunk.length;
    if (size > MAX_METADATA) throw new Error('图片元数据过大。');
    chunks.push(chunk);
  });
  for (let i = 0; i < bytes.length; i += 256) stream.push(bytes.subarray(i, i + 256), i + 256 >= bytes.length);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

// PNG tEXt, zTXt and iTXt, including compressed UTF-8 comments.
export function pngMetadata(bytes: Uint8Array): Record<string, string> {
  const metadata: Record<string, string> = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let total = 0;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = view.getUint32(offset);
    if (offset + size + 12 > bytes.length) throw new Error('PNG 文件不完整。');
    const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
    if (['tEXt', 'zTXt', 'iTXt'].includes(type)) {
      if (size > MAX_METADATA) throw new Error('图片元数据过大。');
      const data = bytes.subarray(offset + 8, offset + 8 + size);
      const end = data.indexOf(0);
      if (end < 1 || end > 79) throw new Error('PNG 元数据格式无效。');
      const key = decoder.decode(data.subarray(0, end));
      let content = data.subarray(end + 1);
      if (type === 'zTXt') {
        if (content[0] !== 0) throw new Error('不支持的 PNG 压缩格式。');
        content = decompressMetadata(content.subarray(1), false);
      } else if (type === 'iTXt') {
        const compressed = content[0], method = content[1];
        if (compressed > 1 || method !== 0) throw new Error('PNG 元数据格式无效。');
        let start = 2;
        for (let i = 0; i < 2; i++) {
          const end = content.indexOf(0, start);
          if (end < 0) throw new Error('PNG 元数据格式无效。');
          start = end + 1;
        }
        content = compressed ? decompressMetadata(content.subarray(start), false) : content.subarray(start);
      }
      total += content.length;
      if (total > MAX_METADATA) throw new Error('图片元数据过大。');
      // Older NovelAI files store UTF-8 directly in tEXt.
      metadata[key] = decoder.decode(content);
    }
    offset += size + 12;
    if (type === 'IEND') break;
  }
  return metadata;
}
