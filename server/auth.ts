import type { Express, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AccountStore } from './accounts.js';
import { ApiError } from './policy.js';

const COOKIE = 'novelai_session';
const LIFETIME = 7 * 24 * 60 * 60_000;
const loginSchema = z.object({ username: z.string().trim().min(1).max(80), password: z.string().min(1).max(200) }).strict();
const usernameSchema = z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N}_.-]+$/u);
const createSchema = z.object({ username: usernameSchema, password: z.string().min(1).max(200), role: z.enum(['admin', 'user']).default('user'), quota: z.number().int().min(0).max(1_000_000).default(50) }).strict();
const updateSchema = z.object({ username: usernameSchema.optional(), password: z.string().min(1).max(200).optional(), role: z.enum(['admin', 'user']).optional(), quota: z.number().int().min(0).max(1_000_000).optional(), reset: z.literal(true).optional(), banMinutes: z.number().int().min(0).max(43_200).optional() }).strict().refine(value => Object.keys(value).length > 0);

export function installAuth(app: Express, accounts: AccountStore, hasJobs: (username: string) => boolean = () => false) {
  const sessions = new Map<string, { username: string; expires: number }>();
  const attempts = new Map<string, { count: number; expires: number }>();
  function cookie(req: Request) {
    return (req.headers.cookie ?? '').split(';').map(p => p.trim()).find(p => p.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';
  }
  function options(req: Request) { return { httpOnly: true, sameSite: 'lax' as const, secure: req.secure, path: '/' }; }
  function sweep() {
    const now = Date.now();
    for (const [key, session] of sessions) if (session.expires <= now) sessions.delete(key);
    for (const [key, attempt] of attempts) if (attempt.expires <= now) attempts.delete(key);
  }
  app.post('/api/auth/login', (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, '请填写有效的账号和密码。');
      sweep();
      const key = `${req.ip}:${parsed.data.username}`;
      const attempt = attempts.get(key);
      if (attempt && attempt.count >= 10) throw new ApiError(429, '登录尝试过于频繁，请在 15 分钟后重试。', 'LOGIN_LIMITED');
      let account;
      try { account = accounts.authenticate(parsed.data.username, parsed.data.password); }
      catch (error) {
        if (error instanceof ApiError && error.code === 'INVALID_CREDENTIALS') attempts.set(key, { count: (attempt?.count ?? 0) + 1, expires: attempt?.expires ?? Date.now() + 15 * 60_000 });
        throw error;
      }
      attempts.delete(key);
      sessions.delete(cookie(req));
      const token = randomBytes(32).toString('hex');
      sessions.set(token, { username: account.username, expires: Date.now() + LIFETIME });
      res.cookie(COOKIE, token, { ...options(req), maxAge: LIFETIME }).json({ account });
    } catch (error) { next(error); }
  });
  app.post('/api/auth/logout', (req, res) => {
    sessions.delete(cookie(req));
    res.clearCookie(COOKIE, options(req)).json({ ok: true });
  });
  app.use('/api', (req, res, next) => {
    try {
      sweep();
      const session = sessions.get(cookie(req));
      if (!session) throw new ApiError(401, '请先登录 NovelAI。', 'AUTH_REQUIRED');
      res.locals.account = accounts.active(session.username);
      next();
    } catch (error) { next(error); }
  });
  app.get('/api/auth/me', (_req, res) => res.json({ account: res.locals.account }));
  app.use('/api/admin', (_req, res, next) => {
    if (res.locals.account.role !== 'admin') return next(new ApiError(403, '仅管理员可以访问账号管理。', 'ADMIN_REQUIRED'));
    next();
  });
  app.get('/api/admin/accounts', (_req, res) => res.json({ accounts: accounts.list() }));
  function revoke(username: string) {
    for (const [key, session] of sessions) if (session.username === username) sessions.delete(key);
  }
  function editable(username: string) {
    if (hasJobs(username)) throw new ApiError(409, '该账号有生成或排队任务，请完成后再修改身份或删除。', 'ACCOUNT_BUSY');
  }
  app.post('/api/admin/accounts', (req, res, next) => {
    try {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, '请检查账号、密码、角色和额度；账号名仅支持文字、数字、下划线、点和短横线。');
      res.status(201).json({ account: accounts.create(parsed.data) });
    } catch (error) { next(error); }
  });
  app.patch('/api/admin/accounts/:username', (req, res, next) => {
    try {
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, '账号设置格式无效，请检查账号名、密码、额度和封禁时间。');
      const username = String(req.params.username), change = parsed.data;
      const identityChanged = (change.username !== undefined && change.username !== username) || change.password !== undefined || (change.role !== undefined && change.role !== accounts.read(username).role);
      if (identityChanged) editable(username);
      const account = accounts.update(username, change);
      if (identityChanged) revoke(username);
      res.json({ account, requiresLogin: identityChanged && res.locals.account.username === username });
    } catch (error) { next(error); }
  });
  app.delete('/api/admin/accounts/:username', (req, res, next) => {
    try {
      const username = String(req.params.username);
      if (username === res.locals.account.username) throw new ApiError(409, '不能删除当前登录的账号。');
      editable(username); accounts.delete(username); revoke(username);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });
  return {
    check: (res: Response) => accounts.canGenerate(res.locals.account.username),
    charge: (res: Response) => accounts.charge(res.locals.account.username),
  };
}
