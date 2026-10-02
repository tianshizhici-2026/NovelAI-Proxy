import 'dotenv/config';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.env.ACCOUNTS_FILE || path.join(root, 'data/accounts.json');
if (existsSync(file)) {
  console.log('账号配置已存在，请登录管理中心新增或编辑账号。');
  process.exit(0);
}
let hidden = false;
const output = new Writable({ write(chunk, _encoding, callback) { if (!hidden) process.stdout.write(chunk); callback(); } });
const input = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
try {
  const username = (process.env.ADMIN_USERNAME || await input.question('管理员账号：')).trim();
  let password = process.env.ADMIN_PASSWORD;
  if (!password) { process.stdout.write('管理员密码：'); hidden = true; password = await input.question(''); hidden = false; process.stdout.write('\n'); }
  if (!/^[\p{L}\p{N}_.-]{1,80}$/u.test(username) || !password || password.length > 200) throw new Error('账号名仅支持文字、数字、下划线、点和短横线；密码长度为 1–200 个字符。');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ version: 1, accounts: [{ username, password, role: 'admin', quota: 0, used: 0, totalUsed: 0, bannedUntil: 0 }] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('管理员已创建。启动后登录管理中心，添加 NovelAI API Key 和用户账号。');
} catch (error) { console.error(error instanceof Error ? error.message : '初始化失败。'); process.exitCode = 1; }
finally { hidden = false; input.close(); }
