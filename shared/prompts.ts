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
  const tag = artistName(prompt) ?? prompt.trim();
  return `https://danbooru.donmai.us/posts?tags=${encodeURIComponent(tag.replace(/ /g, '_'))}`;
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
function weighted(module: SelectedPrompt) {
  let prompt = module.prompt.trim();
  if (module.category === 'artist') {
    // Digits next to the closing weight marker confuse the upstream parser.
    for (const token of promptTokens(prompt).reverse()) {
      const name = artistName(token.text);
      if (name !== undefined && /\d/.test(name) && !/^artist:{1,2}\s*"/i.test(token.text)) {
        prompt = prompt.slice(0, token.start) + `artist:${JSON.stringify(name)}` + prompt.slice(token.end);
      }
    }
  }
  return `${module.weight.toFixed(1)}::${prompt}::`;
}
export function roundedPromptWeight(weight: number) {
  const rounded = Math.round((weight + Number.EPSILON * Math.max(1, Math.abs(weight))) * 10) / 10;
  return Math.max(0.1, Number.isFinite(rounded) ? rounded : weight);
}

type PromptToken = { text: string; start: number; end: number; weight: number };
// Keep source ranges so extracting known tags leaves unknown weighted text intact.
function promptTokens(prompt: string): PromptToken[] {
  const tokens: PromptToken[] = [];
  let start = 0, numeric = 1, brackets = 0, textStarted = false;
  function flush(end: number) {
    const raw = prompt.slice(start, end), text = raw.trim();
    if (text) tokens.push({ text, start: start + raw.indexOf(text), end: start + raw.indexOf(text) + text.length, weight: numeric * Math.pow(1.05, brackets) });
  }
  for (let i = 0; i < prompt.length;) {
    if (prompt[i] === '\\') { textStarted = true; i += 2; continue; }
    if (prompt[i] === '"') {
      let end = i + 1;
      for (; end < prompt.length; end++) {
        if (prompt[end] === '\\') end++;
        else if (prompt[end] === '"') break;
      }
      if (end < prompt.length) { textStarted = true; i = end + 1; continue; }
    }
    const emphasis = !textStarted ? /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)::/.exec(prompt.slice(i)) : null;
    if (emphasis) {
      flush(i); numeric = Number(emphasis[0].slice(0, -2)); brackets = 0;
      i += emphasis[0].length; start = i; textStarted = false; continue;
    }
    // A few old artist lists wrote artist::name instead of artist:name.
    if (prompt.startsWith('::', i) && prompt.slice(start, i).trim().toLowerCase() === 'artist') { i += 2; continue; }
    if (prompt.startsWith('::', i)) { flush(i); numeric = 1; brackets = 0; i += 2; start = i; textStarted = false; continue; }
    if ('{},[]'.includes(prompt[i])) {
      flush(i);
      if (prompt[i] === '{' || prompt[i] === ']') brackets++;
      if (prompt[i] === '}' || prompt[i] === '[') brackets--;
      start = ++i; textStarted = false; continue;
    }
    if (!/\s/.test(prompt[i])) textStarted = true;
    i++;
  }
  flush(prompt.length); return tokens;
}
function artistName(prompt: string): string | undefined {
  const match = /^artist:{1,2}\s*(.+)$/i.exec(prompt.trim());
  if (!match) return undefined;
  return match[1].replace(/^"((?:\\.|[^"\\])*)"$/, '$1').replace(/\\(["\\])/g, '$1');
}
function tagKey(prompt: string) {
  const name = artistName(prompt);
  return (name === undefined ? prompt.trim() : `artist:${name}`).replace(/\\([(),{}\[\]])/g, '$1')
    .replace(/^artist:\(([^()]+)\)$/i, 'artist:$1')
    .replace(/_/g, ' ').replace(/\s+/g, ' ').replace(/^artist:\s*/i, 'artist:').toLowerCase();
}
function sameWeight(a: number, b: number) { return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)); }
export function extractPromptModules(prompt: string, library: PromptModule[], previous: SelectedPrompt[] = []) {
  const templates = library.map(item => ({ item, tokens: promptTokens(item.prompt) })).filter(template => template.tokens.length);
  const byFirst = new Map<string, typeof templates>();
  for (const template of templates) {
    const first = tagKey(template.tokens[0].text);
    const bare = first.replace(/^artist:/, '');
    const aliases = template.item.category === 'artist' ? [first, bare, `artist:${bare}`] : [first];
    for (const alias of new Set(aliases)) byFirst.set(alias, [...(byFirst.get(alias) ?? []), template]);
  }
  for (const choices of byFirst.values()) choices.sort((a, b) => b.tokens.length - a.tokens.length);
  const modules: SelectedPrompt[] = [];
  for (const saved of previous) {
    const savedTokens = promptTokens(saved.prompt);
    const template = templates.find(({ tokens }) => tokens.length === savedTokens.length && tokens.every((token, i) =>
      tagKey(token.text) === tagKey(savedTokens[i].text) && sameWeight(token.weight, savedTokens[i].weight)))?.item;
    const item = template ? { id: template.id, category: template.category, prompt: template.prompt, weight: roundedPromptWeight(saved.weight) } : { ...saved, weight: roundedPromptWeight(saved.weight) };
    if (!modules.some(current => current.id === item.id) && modules.length < 100) modules.push(item);
  }
  const tokens = promptTokens(prompt), removals: PromptToken[] = [];
  for (let i = 0; i < tokens.length;) {
    const first = tagKey(tokens[i].text);
    const choices = byFirst.get(first) ?? [];
    let matched = false;
    for (const template of choices) {
      if (i + template.tokens.length > tokens.length) continue;
      const last = i + template.tokens.length - 1;
      if (i > 0 && !prompt.slice(tokens[i - 1].end, tokens[i].start).includes(',')) continue;
      if (last + 1 < tokens.length && !prompt.slice(tokens[last].end, tokens[last + 1].start).includes(',')) continue;
      const weight = tokens[i].weight / template.tokens[0].weight;
      if (!Number.isFinite(weight)) continue;
      const match = template.tokens.every((tag, offset) => {
        const actual = tagKey(tokens[i + offset].text), expected = tagKey(tag.text);
        const textMatches = actual === expected || (template.item.category === 'artist' && actual.replace(/^artist:/, '') === expected.replace(/^artist:/, ''));
        return textMatches && sameWeight(tokens[i + offset].weight, tag.weight * weight);
      });
      if (!match || (modules.length >= 100 && !modules.some(item => item.id === template.item.id))) continue;
      if (!modules.some(item => item.id === template.item.id)) modules.push({ id: template.item.id, category: template.item.category, prompt: template.item.prompt, weight: roundedPromptWeight(weight) });
      removals.push(...tokens.slice(i, i + template.tokens.length)); i += template.tokens.length; matched = true; break;
    }
    if (!matched) i++;
  }
  if (!removals.length) return { prompt, modules };
  let remaining = prompt;
  for (const token of removals.reverse()) remaining = remaining.slice(0, token.start) + remaining.slice(token.end);
  // Empty emphasis wrappers and adjacent separators have no remaining content.
  for (let i = 0; i < 64; i++) {
    const cleaned = remaining.replace(/(^|(?<!\\)[,{\[])(\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)::)\s*,+/g, '$1$2')
      .replace(/((?<!\\)[{\[])\s*,+/g, '$1').replace(/(?<!\\),+\s*(::|(?<!\\)[}\]])/g, '$1')
      .replace(/(^|(?<!\\)[,{\[])\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)::\s*::/g, '$1')
      .replace(/(?<!\\)[{\[]+\s*::/g, '').replace(/(?<!\\)\{\s*\}|(?<!\\)\[\s*\]/g, '').replace(/(?<!\\),\s*,/g, ',');
    if (cleaned === remaining) break;
    remaining = cleaned;
  }
  remaining = remaining.trim().replace(/^,+\s*/, '').replace(/(?<!\\),+\s*$/, '').replace(/(?<!\\),\s*/g, ', ').trim();
  return { prompt: remaining, modules };
}
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
