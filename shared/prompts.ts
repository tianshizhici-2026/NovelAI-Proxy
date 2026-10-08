export type PromptCategory = 'artist' | 'quality';
export type PromptModule = { id: string; category: PromptCategory; name: string; prompt: string; url: string; preview?: string };
export type SelectedPrompt = Pick<PromptModule, 'id' | 'category' | 'prompt'> & { weight: number };
export const QUALITY_PROMPTS = [
  'very aesthetic', 'masterpiece', 'no text', 'best quality', 'high quality',
  'amazing quality', 'highres', 'absurdres', 'incredibly absurdres', 'newest',
  'year 2026', 'detailed', 'beautiful color', 'cinematic lighting', 'soft lighting',
  'backlighting', 'depth of field', 'sharp focus', 'illustration', 'anime coloring',
  'watercolor', 'oil painting', 'sketch', 'lineart', 'realistic', 'semi-realistic',
  'flat color', 'limited palette', 'vibrant colors', 'pastel colors', 'monochrome',
];
export function danbooruUrl(prompt: string) {
  const tag = prompt.trim().replace(/^artist:/i, '').replace(/ /g, '_');
  return `https://danbooru.donmai.us/posts?tags=${encodeURIComponent(tag)}`;
}
export const DEFAULT_QUALITY_MODULES: PromptModule[] = QUALITY_PROMPTS.map((prompt, index) => ({
  id: `quality-${index}`, category: 'quality', name: prompt, prompt, url: danbooruUrl(prompt),
}));
export function defaultQualitySelection(): SelectedPrompt[] {
  return DEFAULT_QUALITY_MODULES.slice(0, 3).map(({ id, category, prompt }) => ({ id, category, prompt, weight: 0.8 }));
}
export function composedPrompt(prompt: string, modules: SelectedPrompt[] = []) {
  return [...modules.filter(m => m.category === 'artist').map(weighted), prompt.trim(),
    ...modules.filter(m => m.category === 'quality').map(weighted)].filter(Boolean).join(', ');
}
function weighted(module: SelectedPrompt) { return `${module.weight.toFixed(1)}::${module.prompt.trim()}::`; }
export function parsePromptText(text: string, category: PromptCategory): Omit<PromptModule, 'id'>[] {
  const seen = new Set<string>();
  return text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).flatMap(line => {
    const parts = line.split(/\t+/);
    let prompt = (parts.length > 1 ? parts[1] : parts[0]).trim();
    if (parts.length === 1) {
      // Notes in existing artist/style lists are descriptions, not generation tags.
      prompt = prompt.replace(/^[\d.]+::/, '').replace(/^artist::/, 'artist:');
      prompt = prompt.split('::')[0].split(/[\u3400-\u9fff\uff00-\uffef]/)[0].replace(/[,\s]+$/, '').trim();
      if (category === 'artist') {
        prompt = prompt.split(',')[0].trim().replace(/\s+BA$/i, '');
        prompt = prompt.replace(/^artist:\(([^()]+)\)$/, 'artist:$1');
        if (!prompt.startsWith('artist:')) prompt = `artist:${prompt}`;
      }
    }
    if (!prompt || prompt.length > 6000 || seen.has(prompt)) return [];
    seen.add(prompt);
    const url = parts[2] && /^https?:\/\//i.test(parts[2]) ? parts[2] : danbooruUrl(prompt);
    return [{ category, name: (parts.length > 1 ? parts[0] : prompt).slice(0, 120), prompt, url }];
  }).slice(0, 1000);
}
