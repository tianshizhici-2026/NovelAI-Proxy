import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { ApiError } from './policy.js';

const schema = z.object({ version: z.literal(1), apiKey: z.string() }).strict();
export class ApiKeyStore {
  private saved?: string;
  constructor(private file?: string, private fallback = '') {
    this.fallback = fallback.trim().replace(/^Bearer\s+/i, '');
    if (file && existsSync(file)) this.saved = schema.parse(JSON.parse(readFileSync(file, 'utf8'))).apiKey;
  }
  get token() { return this.saved ?? this.fallback; }
  view() {
    return { configured: !!this.token, masked: this.token ? `••••${this.token.length >= 8 ? this.token.slice(-4) : ''}` : '', source: this.saved === undefined ? 'environment' : 'settings' };
  }
  save(apiKey: string) {
    let temporary = '';
    try {
      if (this.file) {
        mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
        writeFileSync(temporary, JSON.stringify({ version: 1, apiKey }) + '\n', { mode: 0o600 });
        renameSync(temporary, this.file);
      }
    } catch {
      if (temporary) rmSync(temporary, { force: true });
      throw new ApiError(503, 'API Key 保存失败，请检查数据目录权限。');
    }
    this.saved = apiKey;
    return this.view();
  }
}
