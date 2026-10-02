// NovelAI V5 Full Light UC preset:
// https://docs.novelai.net/en/image/undesiredcontent/
export const DEFAULT_NEGATIVE_PROMPT = 'lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::';

export function splitNegativePrompt(prompt: string) {
  const trimmed = prompt.trim();
  if (trimmed === DEFAULT_NEGATIVE_PROMPT) return { defaultNegative: true, negativePrompt: '' };
  if (trimmed.startsWith(DEFAULT_NEGATIVE_PROMPT + ','))
    return { defaultNegative: true, negativePrompt: trimmed.slice(DEFAULT_NEGATIVE_PROMPT.length + 1).trim() };
  return { defaultNegative: false, negativePrompt: prompt };
}

export function combinedNegativePrompt(custom: string, enabled: boolean) {
  if (!enabled) return custom;
  return [DEFAULT_NEGATIVE_PROMPT, splitNegativePrompt(custom).negativePrompt.trim()].filter(Boolean).join(', ');
}
