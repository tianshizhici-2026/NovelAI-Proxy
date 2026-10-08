import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { DEFAULT_QUALITY_MODULES, parsePromptText, type PromptModule, type PromptCategory } from '../shared/prompts.js';
import { ApiError } from './policy.js';

export const promptSchema = z.object({
  category: z.enum(['artist', 'quality']), name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(6000),
  url: z.string().max(2000).url().refine(value => /^https?:\/\//i.test(value)),
}).strict();
const itemSchema = promptSchema.extend({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), preview: z.string().max(200).optional() });
export class PromptStore {
  private items: PromptModule[];
  constructor(private file?: string, root?: string) {
    this.items = [...DEFAULT_QUALITY_MODULES];
    if (file && existsSync(file)) this.items = z.array(itemSchema).max(3000).parse(JSON.parse(readFileSync(file, 'utf8')));
    else if (root) {
      for (const filename of readdirSync(root).filter(name => /\.txt$/i.test(name))) {
        const category = /quality|style|质量|风格/i.test(filename) ? 'quality' : 'artist';
        this.import(readFileSync(path.join(root, filename), 'utf8'), category);
      }
    }
  }
  list() { return structuredClone(this.items); }
  read(id: string) {
    const item = this.items.find(item => item.id === id);
    if (!item) throw new ApiError(404, '提示词不存在。');
    return structuredClone(item);
  }
  private save(items: PromptModule[]) {
    if (items.length > 3000) throw new ApiError(400, '提示词最多 3000 条。');
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try { writeFileSync(temporary, JSON.stringify(items, null, 2) + '\n', { mode: 0o600 }); renameSync(temporary, this.file); }
      catch { rmSync(temporary, { force: true }); throw new ApiError(503, '提示词保存失败。'); }
    }
    this.items = items;
  }
  create(data: z.infer<typeof promptSchema>) {
    const item = { ...promptSchema.parse(data), id: randomUUID() };
    this.save([...this.items, item]); return item;
  }
  update(id: string, data: z.infer<typeof promptSchema>) {
    const item = { ...this.read(id), ...promptSchema.parse(data) };
    this.save(this.items.map(current => current.id === id ? item : current)); return item;
  }
  delete(id: string) { const item = this.read(id); this.save(this.items.filter(item => item.id !== id)); this.removeFile(item.preview); }
  import(text: string, category: PromptCategory) {
    const parsed = parsePromptText(text, category);
    const items = parsed.filter(item => !this.items.some(current => current.category === category && current.prompt === item.prompt)).map(item => ({ ...item, id: randomUUID() }));
    this.save([...this.items, ...items]); return items.length;
  }
  private removeFile(preview?: string) { if (preview && this.file) rmSync(path.join(path.dirname(this.file), 'prompt-previews', path.basename(preview)), { force: true }); }
  async preview(id: string, data: string) {
    this.read(id);
    if (!this.file) throw new ApiError(503, '预览图目录未配置。');
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new ApiError(400, '请选择 PNG、JPEG 或 WebP 图片。');
    const bytes = Buffer.from(data.split(',')[1], 'base64');
    if (bytes.length > 8 * 1024 * 1024) throw new ApiError(400, '预览图不能超过 8 MB。');
    const image = sharp(bytes, { limitInputPixels: 40_000_000 });
    const meta = await image.metadata().catch(() => null);
    if (!meta || !['png', 'jpeg', 'webp'].includes(meta.format ?? '') || (meta.pages ?? 1) !== 1) throw new ApiError(400, '图片格式无效。');
    const output = await image.rotate().resize({ width: 1000, height: 1000, fit: 'inside', withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
    const item = this.read(id);
    const dir = path.join(path.dirname(this.file), 'prompt-previews'); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const filename = `${randomUUID()}.webp`; const destination = path.join(dir, filename);
    writeFileSync(destination, output, { mode: 0o600 });
    const updated = { ...item, preview: filename };
    try { this.save(this.items.map(current => current.id === id ? updated : current)); }
    catch (error) { rmSync(destination, { force: true }); throw error; }
    this.removeFile(item.preview); return updated;
  }
  previewPath(id: string) {
    const item = this.read(id);
    if (!item.preview || !this.file) throw new ApiError(404, '尚未设置预览图。');
    return path.resolve(path.dirname(this.file), 'prompt-previews', path.basename(item.preview));
  }
}
