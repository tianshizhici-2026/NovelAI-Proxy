import 'dotenv/config';
import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { AccountStore } from './accounts.js';
import { ApiKeyStore } from './apiKeys.js';
import { PromptStore } from './prompts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = createApp({
  prompts: new PromptStore(process.env.PROMPTS_FILE || path.join(root, 'data/prompts.json'), root),
  accounts: new AccountStore(process.env.ACCOUNTS_FILE || path.join(root, 'data/accounts.json')),
  keys: new ApiKeyStore(process.env.SETTINGS_FILE || path.join(root, 'data/settings.json'), process.env.NOVELAI_TOKEN),
  token: (process.env.NOVELAI_TOKEN ?? '').trim().replace(/^Bearer\s+/i, ''),
  imageUrl: process.env.NOVELAI_IMAGE_URL ?? 'https://image.novelai.net',
  minUsagePercent: Math.max(1, Number(process.env.NOVELAI_MIN_USAGE_PERCENT) || 1),
  priceUrl: process.env.NOVELAI_PRICE_URL || undefined,
  publicOrigin: process.env.PUBLIC_ORIGIN?.trim() || undefined,
});
if (existsSync(path.join(root, 'dist/index.html'))) {
  app.use(express.static(path.join(root, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'dist/index.html')));
}
const port = Number(process.env.PORT) || 6006;
const host = process.env.HOST || '0.0.0.0';
app.listen(port, host, () => console.log(`NovelAI proxy: http://${host}:${port}`));
