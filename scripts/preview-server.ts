// Isolated browser-test server. All generation and subscription responses are fixtures.
import express from 'express';
import sharp from 'sharp';
import { createApp } from '../server/app.js';
import { AccountStore } from '../server/accounts.js';
import { ApiKeyStore } from '../server/apiKeys.js';
import { PromptStore } from '../server/prompts.js';

const accounts = new AccountStore(undefined, ['preview-admin', 'preview-user', 'preview-user-two'].map((username, index) => ({ username, password: 'preview-password', role: index ? 'user' as const : 'admin' as const, quota: index ? 50 : 0, used: 0, totalUsed: 0, bannedUntil: 0 })));
const app = createApp({ accounts, prompts: new PromptStore('.run/preview-prompts.json'), keys: new ApiKeyStore(undefined, 'preview-api-key'), token: '', imageUrl: 'https://upstream.invalid', minUsagePercent: 1 }, async (url, init) => {
  if (!new Headers(init?.headers).get('Authorization')?.startsWith('Bearer preview-')) return new Response('', { status: 401 });
  if (String(url).endsWith('/user/subscription')) return Response.json({ tier: 3, expiresAt: Date.now() / 1000 + 3600, usage: { percent: 91, isNegative: false }, trainingStepsLeft: { fixedTrainingStepsLeft: 1000, purchasedTrainingSteps: 50 } });
  const body = JSON.parse(String(init?.body));
  const dimensions = String(url).endsWith('/ai/upscale') ? await sharp(Buffer.from(body.image, 'base64')).metadata() : body.parameters;
  const factor = String(url).endsWith('/ai/upscale') ? 2 : 1;
  return new Response(await sharp({ create: { width: dimensions.width * factor, height: dimensions.height * factor, channels: 3, background: '#80a8c0' } }).png().toBuffer());
});
app.use(express.static('dist'));
app.listen(6007, '127.0.0.1', () => console.log('Isolated UI preview: http://127.0.0.1:6007'));
