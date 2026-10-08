import { pngMetadata, withPngMetadata } from '../shared/png.js';
import { buildPayload, type ValidatedInput } from './policy.js';

export async function attachGenerationMetadata(result: Buffer, generated: Buffer, input: ValidatedInput, payload: ReturnType<typeof buildPayload>) {
  let original: Record<string, string> = {};
  try { original = pngMetadata(generated); } catch { /* Fall back if upstream metadata is malformed. */ }
  let upstream: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(original.Comment ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) upstream = parsed;
  } catch { /* Fall back to the actual submitted parameters. */ }
  const { image: _image, mask: _mask, ...parameters } = payload.parameters;
  // Source images/masks stay out of metadata; retain upstream seed and resolved captions.
  const comment = {
    ...parameters, ...upstream,
    prompt: upstream.prompt ?? payload.input, uc: upstream.uc ?? parameters.negative_prompt,
    width: parameters.width, height: parameters.height,
    model: payload.model, action: payload.action, mode: input.mode,
    strength: input.mode !== 'generate' ? input.strength : undefined,
    noise: input.mode === 'img2img' ? input.noise : undefined,
    v4_prompt_original: { ...parameters.v4_prompt, caption: { ...parameters.v4_prompt.caption, base_caption: input.prompt } },
    v4_negative_prompt_original: parameters.v4_negative_prompt,
    qualityToggle: input.qualityTags,
    novelai_proxy_modules: input.promptModules,
  };
  // An upstream service may echo input images in its comment; don't embed those.
  for (const key of ['image', 'mask', 'reference_image', 'reference_image_multiple']) delete (comment as Record<string, unknown>)[key];
  return Buffer.from(withPngMetadata(result, {
    Software: 'NovelAI', Source: original.Source ?? `NovelAI Diffusion V5 (${payload.model})`,
    Description: typeof upstream.prompt === 'string' ? upstream.prompt : payload.input,
    Comment: JSON.stringify(comment),
  }));
}
