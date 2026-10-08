import type { PromptModule } from '../shared/prompts';

export function searchPromptModules(items: PromptModule[], query: string) {
  const text = query.trim();
  if (!text) return { items, error: '' };
  try {
    const literal = /^\/(.*)\/([a-z]*)$/s.exec(text);
    const regex = literal ? new RegExp(literal[1], literal[2]) : new RegExp(text, 'i');
    const matches = (value: string) => { regex.lastIndex = 0; return regex.test(value); };
    return { items: items.filter(item => matches(item.name) || matches(item.prompt)), error: '' };
  } catch {
    return { items: [], error: '正则表达式无效，请检查括号或转义。' };
  }
}
