import { extractPromptModules, roundedPromptWeight, type PromptCategory, type PromptModule, type SelectedPrompt } from '../shared/prompts';
import { newId } from './id';

export function exportModuleSelection(category: PromptCategory, selected: SelectedPrompt[]) {
  return JSON.stringify({ version: 1, category, modules: selected.filter(item => item.category === category).map(({ prompt, weight }) => ({ prompt, weight })) }, null, 2);
}

export function importModuleSelection(text: string, category: PromptCategory, library: PromptModule[]): SelectedPrompt[] {
  if (text.length > 2_000_000) throw new Error('组合文件最大 2 MB。');
  let data: unknown;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('请选择导出的 JSON 组合文件。'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('组合文件格式无效。');
  const value = data as Record<string, unknown>;
  if (value.version !== 1 || !['artist', 'quality'].includes(String(value.category)) || !Array.isArray(value.modules) || value.modules.length > 100)
    throw new Error('组合文件格式无效，最多 100 项。');
  if (value.category !== category) throw new Error(`请在${value.category === 'artist' ? '画师串' : '质量风格'}模块中导入此文件。`);
  const selected = value.modules.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('组合中含有无效模块。');
    const entry = item as Record<string, unknown>;
    if (typeof entry.prompt !== 'string' || !entry.prompt.trim() || entry.prompt.length > 6000 || typeof entry.weight !== 'number' || !Number.isFinite(entry.weight))
      throw new Error('模块提示词或权重无效。');
    return { id: newId(), category, prompt: entry.prompt.trim(), weight: roundedPromptWeight(entry.weight) };
  });
  const rebound = extractPromptModules('', library.filter(item => item.category === category), selected).modules;
  const seen = new Set<string>();
  return rebound.filter(item => { const key = item.prompt.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
}
