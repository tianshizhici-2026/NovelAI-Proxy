import { z } from 'zod';
import { ApiError } from './policy.js';
export function anlasBalance(raw: unknown) {
  const parsed = z.object({ trainingStepsLeft: z.object({ fixedTrainingStepsLeft: z.number().int().nonnegative(), purchasedTrainingSteps: z.number().int().nonnegative() }) }).safeParse(raw);
  if (!parsed.success) return undefined;
  const { fixedTrainingStepsLeft: subscription, purchasedTrainingSteps: purchased } = parsed.data.trainingStepsLeft;
  return { subscription, purchased, total: subscription + purchased };
}
export function requireAnlas(raw: unknown, cost: number) {
  const balance = anlasBalance(raw);
  if (!balance) throw new ApiError(503, '无法读取 Anlas 余额。', 'ANLAS_UNKNOWN');
  if (balance.total < cost) throw new ApiError(403, `Anlas 不足，本次需要 ${cost}，剩余 ${balance.total}。`, 'ANLAS_INSUFFICIENT');
  return balance;
}
