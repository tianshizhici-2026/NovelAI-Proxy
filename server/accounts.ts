import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AccountView } from '../shared/accounts.js';
import { ApiError } from './policy.js';

const accountSchema = z.object({
  username: z.string().min(1).max(80), password: z.string().min(1).max(200),
  role: z.enum(['admin', 'user']), quota: z.number().int().min(0).max(1_000_000),
  used: z.number().int().nonnegative(), totalUsed: z.number().int().nonnegative(),
  bannedUntil: z.number().int().nonnegative(),
}).strict();
const fileSchema = z.object({ version: z.literal(1), accounts: z.array(accountSchema).min(1) }).strict();
export type AccountRecord = z.infer<typeof accountSchema>;
export type AccountChange = { username?: string; password?: string; role?: 'admin' | 'user'; quota?: number; reset?: boolean; banMinutes?: number };

export class AccountStore {
  private records: AccountRecord[];
  constructor(private file?: string, initial: AccountRecord[] = []) {
    if (file && !existsSync(file)) throw new Error('缺少账号配置文件，请创建 data/accounts.json。');
    this.records = fileSchema.parse(file ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, accounts: initial }).accounts;
    if (new Set(this.records.map(a => a.username)).size !== this.records.length || !this.records.some(a => a.role === 'admin'))
      throw new Error('账号配置必须包含管理员，且账号名不能重复。');
  }
  private get(username: string) {
    const account = this.records.find(a => a.username === username);
    if (!account) throw new ApiError(401, '登录已失效，请重新登录。', 'AUTH_REQUIRED');
    return account;
  }
  private view(account: AccountRecord): AccountView {
    const { password: _password, ...publicAccount } = account;
    return { ...publicAccount, remaining: account.role === 'admin' ? null : Math.max(0, account.quota - account.used), banned: account.role === 'user' && account.bannedUntil > Date.now() };
  }
  list() { return this.records.map(a => this.view(a)); }
  read(username: string) { return this.view(this.get(username)); }
  authenticate(username: string, password: string) {
    const account = this.records.find(a => a.username === username);
    const expected = Buffer.from(account?.password ?? randomBytes(32).toString('hex'));
    const supplied = Buffer.from(password);
    if (!account || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new ApiError(401, '账号或密码不正确。', 'INVALID_CREDENTIALS');
    return this.active(username);
  }
  active(username: string) {
    const account = this.read(username);
    if (account.banned) throw new ApiError(403, `账号已暂停使用，将于 ${new Date(account.bannedUntil).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 恢复。`, 'ACCOUNT_BANNED');
    return account;
  }
  canGenerate(username: string) {
    const account = this.active(username);
    if (account.role === 'user' && account.remaining === 0)
      throw new ApiError(403, '账号额度已用完，请联系管理员补充额度。', 'QUOTA_EXHAUSTED');
    return account;
  }
  private persist(records: AccountRecord[]) {
    if (!records.some(account => account.role === 'admin')) throw new ApiError(409, '至少保留一个管理员账号。', 'LAST_ADMIN');
    let temporary = '';
    try {
      if (this.file) {
        mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
        writeFileSync(temporary, JSON.stringify({ version: 1, accounts: records }, null, 2) + '\n', { mode: 0o600 });
        renameSync(temporary, this.file);
      }
    } catch { if (temporary) rmSync(temporary, { force: true }); throw new ApiError(503, '账号数据保存失败，请稍后再试。', 'ACCOUNT_SAVE_FAILED'); }
    this.records = records;
  }
  private mutate(username: string, change: (record: AccountRecord) => void) {
    const record = { ...this.get(username) };
    change(record);
    this.persist(this.records.map(item => item.username === username ? record : item));
    return this.view(record);
  }
  create(input: { username: string; password: string; role: 'admin' | 'user'; quota: number }) {
    if (this.records.some(account => account.username === input.username)) throw new ApiError(409, '账号名已存在。', 'ACCOUNT_EXISTS');
    const record = accountSchema.parse({ ...input, quota: input.role === 'admin' ? 0 : input.quota, used: 0, totalUsed: 0, bannedUntil: 0 });
    this.persist([...this.records, record]);
    return this.view(record);
  }
  delete(username: string) {
    this.get(username);
    this.persist(this.records.filter(account => account.username !== username));
  }
  charge(username: string) {
    // Accepted jobs still count if an admin edits the quota or bans the user while they run.
    return this.mutate(username, account => { account.used++; account.totalUsed++; });
  }
  update(username: string, change: AccountChange) {
    const role = change.role ?? this.get(username).role;
    if (role === 'admin' && (change.quota !== undefined || change.reset || change.banMinutes !== undefined)) throw new ApiError(403, '管理员账号不受额度和封禁设置限制。');
    if (change.username && change.username !== username && this.records.some(account => account.username === change.username)) throw new ApiError(409, '账号名已存在。', 'ACCOUNT_EXISTS');
    return this.mutate(username, account => {
      if (change.username !== undefined) account.username = change.username;
      if (change.password !== undefined) account.password = change.password;
      if (change.role !== undefined) { account.role = change.role; if (change.role === 'admin') { account.quota = 0; account.bannedUntil = 0; } }
      if (change.quota !== undefined) account.quota = change.quota;
      if (change.reset) account.used = 0;
      if (change.banMinutes !== undefined) account.bannedUntil = change.banMinutes === 0 ? 0 : Date.now() + change.banMinutes * 60_000;
    });
  }
}
