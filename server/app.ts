import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RESOLUTIONS } from '../shared/types.js';
import { ApiError, buildPayload, eligibleSubscription, inputSchema } from './policy.js';
import { extractImage, prepareInpaint, prepareReference, preserveOutsideMask } from './images.js';
import { attachGenerationMetadata } from './metadata.js';
import { AccountStore } from './accounts.js';
import { installAuth } from './auth.js';
import { GenerationQueue } from './queue.js';
import { ApiKeyStore } from './apiKeys.js';

export type Config = { token: string; keys?: ApiKeyStore; imageUrl: string; minUsagePercent: number; priceUrl?: string; publicOrigin?: string; accounts: AccountStore };
export function createApp(config: Config, upstreamFetch: typeof fetch = fetch) {
  const publicOrigin = config.publicOrigin ? new URL(config.publicOrigin).origin : undefined;
  if (publicOrigin && !/^https?:\/\//.test(publicOrigin)) throw new Error('PUBLIC_ORIGIN 必须是 HTTP 或 HTTPS 访问地址。');
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  const queue = new GenerationQueue();
  const keys = config.keys ?? new ApiKeyStore(undefined, config.token);
  let updatingKey = false;
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use('/api', (req, _res, next) => {
    const origin = req.get('origin');
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error();
        if (parsed.host !== req.get('host') && parsed.origin !== publicOrigin) throw new Error();
      } catch { return next(new ApiError(403, '此请求来源不被允许。', 'ORIGIN_REJECTED')); }
    }
    next();
  });
  app.use(express.json({ limit: '26mb' }));
  const auth = installAuth(app, config.accounts, username => queue.hasJobs(username));
  app.get('/api/queue', (_req, res) => res.json(queue.status()));
  app.get('/api/queue/:id', (req, res, next) => {
    const job = queue.job(String(req.params.id), res.locals.account.username);
    if (!job) return next(new ApiError(404, '排队任务不存在或已完成。', 'JOB_NOT_FOUND'));
    res.json(job);
  });

  async function request(path: string, init: RequestInit = {}, timeout = 15_000, token = keys.token) {
    if (!token) throw new ApiError(503, '请管理员在 API Key 设置中配置 NovelAI API Key。', 'TOKEN_MISSING');
    const url = path.startsWith('https://') || path.startsWith('http://') ? path : `${config.imageUrl.replace(/\/$/, '')}${path}`;
    try {
      const response = await upstreamFetch(url, {
        ...init, redirect: 'error', signal: AbortSignal.timeout(timeout),
        headers: { 'Authorization': `Bearer ${token}`, 'x-correlation-id': randomUUID().slice(0, 6), 'x-initiated-at': new Date().toISOString(), ...init.headers },
      });
      if (!response.ok) {
        await response.body?.cancel();
        const messages: Record<number, string> = {
          401: 'NovelAI Token 无效或已过期。', 403: '上游拒绝请求，请检查订阅与额度。',
          429: '上游请求过于频繁，请稍后重试。',
        };
        throw new ApiError(response.status === 429 ? 429 : 502, messages[response.status] ?? `上游请求失败（HTTP ${response.status}）。`, 'UPSTREAM_REJECTED');
      }
      return response;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, '上游连接失败或超时，请稍后重试。', 'UPSTREAM_UNAVAILABLE');
    }
  }
  async function eligibility() {
    const response = await request('/user/subscription');
    let raw: unknown;
    try { raw = await response.json(); } catch { throw new ApiError(502, '上游订阅信息格式无效。'); }
    // Official endpoint returns the subscription object directly.
    return eligibleSubscription(raw, config.minUsagePercent);
  }
  app.get('/api/admin/api-key', (_req, res) => res.json(keys.view()));
  app.put('/api/admin/api-key', async (req, res, next) => {
    const parsed = z.object({ apiKey: z.string().trim().transform(value => value.replace(/^Bearer\s+/i, '')).pipe(z.string().min(8).max(8192).regex(/^\S+$/)) }).strict().safeParse(req.body);
    if (!parsed.success) return next(new ApiError(400, '请输入有效的 NovelAI API Key。'));
    if (updatingKey || queue.status().generating) return next(new ApiError(409, '请等待当前生成队列或 API Key 保存完成后再修改。'));
    updatingKey = true;
    try {
      const response = await request('/user/subscription', {}, 15_000, parsed.data.apiKey);
      const subscription = z.object({ tier: z.number() }).safeParse(await response.json().catch(() => null));
      if (!subscription.success) throw new ApiError(502, 'API Key 验证失败，上游返回了未知订阅信息。');
      res.json(keys.save(parsed.data.apiKey));
    } catch (error) { next(error); }
    finally { updatingKey = false; }
  });
  app.get('/api/status', async (_req, res) => {
    const account = config.accounts.read(res.locals.account.username);
    if (!keys.token) return res.json({ configured: false, ready: false, message: '请管理员配置 API Key', account });
    try {
      auth.check(res);
      const usagePercent = await eligibility();
      const currentQueue = queue.status();
      res.json({ configured: true, ready: true, usagePercent, queue: currentQueue, message: currentQueue.waiting >= currentQueue.capacity ? '等待队列已满，请稍后再试。' : currentQueue.generating ? `正在生成 · ${currentQueue.waiting} 张排队，可提交等待` : '已连接 · Opus 可用', account });
    } catch (error) {
      res.json({ configured: true, ready: false, message: error instanceof ApiError ? error.message : '服务暂不可用', account });
    }
  });
  app.post('/api/generate', async (req, res, next) => {
    if (updatingKey) return next(new ApiError(409, 'API Key 正在更新，请稍后再生成。'));
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success) return next(new ApiError(400, parsed.error.issues[0].message, 'INVALID_PARAMETERS'));
    try { auth.check(res); } catch (error) { return next(error); }
    const id = req.get('X-Generation-ID') || randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return next(new ApiError(400, '任务编号格式无效。'));
    const username = res.locals.account.username as string;
    const disconnected = () => { queue.cancel(id, username); };
    let release: (() => void) | undefined;
    try {
      const admitted = queue.acquire(id, username);
      res.on('close', disconnected);
      release = await admitted;
      if (res.destroyed) return;
      // Quotas and bans may change while this request is waiting.
      auth.check(res);
      const input = parsed.data;
      const { width, height } = RESOLUTIONS[input.resolution];
      const prepared = input.mode === 'inpaint' ? await prepareInpaint(input.image!, input.mask!, width, height) : undefined;
      const reference = input.mode === 'img2img' ? await prepareReference(input.image!, width, height) : undefined;
      const payload = buildPayload(input, prepared ? { image: prepared.image, mask: prepared.maskBase64 } : reference ? { image: reference.toString('base64') } : undefined);
      // Recheck immediately before every generation; never fall back to paid requests.
      await eligibility();
      if (config.priceUrl) {
        const priceResponse = await request(config.priceUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const quote = await priceResponse.json().catch(() => null) as { price?: unknown; cost?: unknown } | null;
        if (!quote || (quote.price ?? quote.cost) !== 0)
          throw new ApiError(403, '上游未确认本次费用为 0 Anlas，已停止生成。', 'NONZERO_PRICE');
      }
      const response = await request('/ai/generate-image', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }, 120_000);
      const reader = response.body?.getReader();
      if (!reader) throw new ApiError(502, '上游没有返回图片。');
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 32 * 1024 * 1024) { await reader.cancel(); throw new ApiError(502, '上游响应过大。'); }
        chunks.push(value);
      }
      const generated = await extractImage(Buffer.concat(chunks), width, height);
      const composed = prepared ? await preserveOutsideMask(generated, prepared.original, prepared.blendMask) : generated;
      const result = await attachGenerationMetadata(composed, generated, input, payload);
      auth.charge(res);
      res.type('image/png').set('Content-Disposition', `inline; filename="novelai-${Date.now()}.png"`).send(result);
    } catch (error) { if (!res.destroyed) next(error); }
    finally { res.off('close', disconnected); release?.(); }
  });
  app.use('/api', (_req, _res, next) => next(new ApiError(404, '接口不存在。')));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) return res.status(error.status).json({ error: error.message, code: error.code });
    if (error instanceof z.ZodError) return res.status(400).json({ error: '参数格式无效。' });
    const bodyError = error as { type?: string };
    if (bodyError.type === 'entity.too.large') return res.status(413).json({ error: '上传内容过大。' });
    if (bodyError.type === 'entity.parse.failed') return res.status(400).json({ error: '请求 JSON 格式无效。' });
    res.status(500).json({ error: '处理失败，请检查图片格式或稍后重试。', code: 'PROCESSING_FAILED' });
  });
  return app;
}
