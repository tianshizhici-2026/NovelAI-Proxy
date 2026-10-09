import { RESOLUTIONS, type Settings, type GenerationMode } from './types.js';
import { effortSteps } from './effort.js';
// NovelAI's V5 Euler Ancestral price formula, one sample, no SMEA.
export function generationAnlas(settings: Settings, mode: GenerationMode, freeAvailable: boolean) {
  const { width, height } = RESOLUTIONS[settings.resolution];
  if (width * height <= 1_048_576 && freeAvailable) return 0;
  const strength = mode === 'generate' ? 1 : settings.strength;
  // Official Medium discount applies to the step term before rounding.
  const stepFactor = settings.effort === 'medium' ? 1 / 1.06521739 : 1;
  return Math.max(2, Math.ceil(Math.ceil(2.951823174884865e-6 * width * height + 5.753298233447344e-7 * width * height * effortSteps(settings.effort, settings.steps) * stepFactor) * 1.5 * strength));
}
export function upscaleAnlas(width: number, height: number) {
  const pixels = width * height;
  if (pixels <= 0 || pixels > 3_145_728) return null;
  return pixels <= 1_048_576 ? 1 : pixels <= 1_747_627 ? 2 : pixels <= 2_446_678 ? 3 : 4;
}
