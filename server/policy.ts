import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { RESOLUTIONS } from '../shared/types.js';
import { combinedNegativePrompt } from '../shared/negative.js';
import { composedPrompt } from '../shared/prompts.js';

const character = z.object({
  id: z.string().max(80), name: z.string().max(100),
  prompt: z.string().max(6000), negativePrompt: z.string().max(6000),
  enabled: z.boolean(), x: z.number().min(0).max(1), y: z.number().min(0).max(1),
}).strict();
export const inputSchema = z.object({
  mode: z.enum(['generate', 'inpaint', 'img2img']),
  prompt: z.string().max(12000), negativePrompt: z.string().max(12000),
  qualityTags: z.boolean(), resolution: z.enum(Object.keys(RESOLUTIONS) as [keyof typeof RESOLUTIONS, ...(keyof typeof RESOLUTIONS)[]]),
  defaultNegative: z.boolean().default(false),
  steps: z.number().int().min(23).max(28), guidance: z.number().min(0.1).max(10),
  characters: z.array(character).max(22), useCoords: z.boolean(),
  strength: z.number().min(0).max(1),
  noise: z.number().min(0).max(1).default(0.2),
  seed: z.number().int().min(0).max(0xffffffff).nullable().default(null),
  useAnlas: z.boolean().default(false),
  promptModules: z.array(z.object({ id: z.string().max(80), category: z.enum(['artist', 'quality']), prompt: z.string().trim().min(1).max(6000), weight: z.number().min(0.1).max(3) }).strict()).max(100).default([]),
  image: z.string().max(12_000_000).optional(), mask: z.string().max(12_000_000).optional(),
}).strict().superRefine((data, ctx) => {
  if (!data.prompt.trim() && !data.characters.some(c => c.enabled && c.prompt.trim()) && !data.promptModules.length)
    ctx.addIssue({ code: 'custom', path: ['prompt'], message: '请填写场景或角色提示词。' });
  if (data.mode === 'inpaint' && (!data.image || !data.mask))
    ctx.addIssue({ code: 'custom', path: ['image'], message: '局部重绘需要底图和蒙版。' });
  if (data.mode !== 'generate' && data.strength < 0.01)
    ctx.addIssue({ code: 'custom', path: ['strength'], message: '重绘和图生图强度至少为 0.01。' });
  if (data.mode === 'img2img' && (!data.image || data.mask))
    ctx.addIssue({ code: 'custom', path: ['image'], message: 'Image2Image 需要参考图，不能附带蒙版。' });
  if (data.mode === 'generate' && (data.image || data.mask))
    ctx.addIssue({ code: 'custom', path: ['image'], message: '文生图不能附带底图或蒙版。' });
  if (composedPrompt(data.prompt, data.promptModules).length > 24000)
    ctx.addIssue({ code: 'custom', path: ['prompt'], message: '拼装后的提示词过长，请减少模块。' });
});
export type ValidatedInput = z.infer<typeof inputSchema>;
export class ApiError extends Error {
  constructor(public status: number, message: string, public code = 'REQUEST_FAILED') { super(message); }
}

export function eligibleSubscription(raw: unknown, minUsagePercent = 1, now = Date.now()) {
  const subscription = z.object({
    tier: z.number(), active: z.boolean().optional(), expiresAt: z.number(),
    usage: z.object({ percent: z.number().min(0).max(1000), isNegative: z.boolean() }),
  }).safeParse(raw);
  if (!subscription.success)
    throw new ApiError(503, '无法确认上游订阅和 V5 额度，已停止生成。', 'ELIGIBILITY_UNKNOWN');
  const s = subscription.data;
  if (s.tier !== 3 || s.active === false || s.expiresAt * 1000 <= now)
    throw new ApiError(403, '上游需要有效的 Opus 订阅才能使用 0 Anlas 生图。', 'OPUS_REQUIRED');
  if (s.usage.isNegative || s.usage.percent < Math.max(1, minUsagePercent))
    throw new ApiError(403, 'V5 可用额度不足，已停止生成，等待额度恢复。', 'USAGE_EXHAUSTED');
  return s.usage.percent;
}

export function buildPayload(input: ValidatedInput, images?: { image: string; mask?: string }) {
  const { width, height } = RESOLUTIONS[input.resolution];
  const prompt = [composedPrompt(input.prompt, input.promptModules), input.qualityTags ? 'very aesthetic, masterpiece, no text' : ''].filter(Boolean).join(', ');
  const negativePrompt = combinedNegativePrompt(input.negativePrompt, input.defaultNegative);
  const characters = input.characters.filter(c => c.enabled && c.prompt.trim());
  const seed = input.seed ?? randomInt(0, 0x1_0000_0000);
  const captions = (negative: boolean) => characters.map(c => ({
    char_caption: negative ? c.negativePrompt : c.prompt,
    centers: [{ x: c.x, y: c.y }],
  }));
  const imageParameters: { image?: string; mask?: string; extra_noise_seed?: number; strength?: number; noise?: number; color_correct?: boolean; img2img?: { strength: number; color_correct: boolean } } = images ? {
    ...images, extra_noise_seed: (seed - 1) >>> 0,
    ...(input.mode === 'img2img' ? { strength: input.strength, noise: input.noise, color_correct: false }
      : input.strength < 1 ? { img2img: { strength: input.strength, color_correct: true } } : {}),
  } : {};
  return {
    input: prompt,
    model: input.mode === 'inpaint' ? 'nai-diffusion-5-full-inpainting' : 'nai-diffusion-5-full',
    action: input.mode === 'inpaint' ? 'infill' : input.mode === 'img2img' ? 'img2img' : 'generate',
    parameters: {
      params_version: 4, width, height, steps: input.steps, scale: input.guidance,
      n_samples: 1, sampler: 'k_euler_ancestral', seed,
      cfg_rescale: 0, dynamic_thresholding: false,
      negative_prompt: negativePrompt,
      deliberate_euler_ancestral_bug: false, prefer_brownian: true,
      use_coords: input.useCoords, legacy: false, legacy_uc: false,
      add_original_image: false, image_format: 'png',
      v4_prompt: { caption: { base_caption: prompt, char_captions: captions(false) }, use_coords: input.useCoords, use_order: true },
      v4_negative_prompt: { caption: { base_caption: negativePrompt, char_captions: captions(true) }, legacy_uc: false },
      ...imageParameters,
    },
  };
}
