export const MEDIUM_STEPS = 14;
export const MEDIUM_NEGATIVE_PROMPT = 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';

export function effortSteps(effort: unknown, steps: unknown) {
  return effort === 'medium' ? MEDIUM_STEPS : Math.min(28, Math.max(23, typeof steps === 'number' && Number.isFinite(steps) ? Math.round(steps) : 23));
}
