import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, ImageIcon, Minus, Plus, Upload, X } from 'lucide-react';
import { roundedPromptWeight, type PromptModule, type SelectedPrompt, type PromptCategory } from '../shared/prompts';
import { accountJson } from './accountApi';
import PromptSearch from './PromptSearch';
import { searchPromptModules } from './promptSearch';
import { exportModuleSelection, importModuleSelection } from './moduleTransfer';
import { downloadBlob } from './storage';

export default function PromptModules({ selected, onChange }: { selected: SelectedPrompt[]; onChange: (items: SelectedPrompt[]) => void }) {
  const [library, setLibrary] = useState<PromptModule[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [importing, setImporting] = useState(false);
  const artistFile = useRef<HTMLInputElement>(null);
  const qualityFile = useRef<HTMLInputElement>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [preview, setPreview] = useState<PromptModule>();
  const [queries, setQueries] = useState({ artist: '', quality: '' });
  useEffect(() => { accountJson<{ prompts: PromptModule[] }>('/api/admin/prompts').then(result => setLibrary(result.prompts)).catch(error => setError(error.message)); }, []);
  function add(item: PromptModule) {
    if (!selected.some(current => current.id === item.id) && selected.length < 100)
      onChange([...selected, { id: item.id, category: item.category, prompt: item.prompt, weight: roundedPromptWeight(item.defaultWeight ?? 0.8) }]);
  }
  function weight(item: SelectedPrompt, delta: number) {
    onChange(selected.map(current => current.id === item.id ? { ...current, weight: roundedPromptWeight(current.weight + delta) } : current));
  }
  async function importSelection(file: File, category: PromptCategory) {
    if (importing) return;
    setImporting(true); setError(''); setNotice('');
    try {
      if (file.size > 2_000_000) throw new Error('组合文件最大 2 MB。');
      const currentLibrary = (await accountJson<{ prompts: PromptModule[] }>('/api/admin/prompts')).prompts;
      const items = importModuleSelection(await file.text(), category, currentLibrary);
      const others = selectedRef.current.filter(item => item.category !== category);
      if (others.length + items.length > 100) throw new Error('画师串和质量风格合计最多 100 项。');
      setLibrary(currentLibrary); onChange([...others, ...items]);
      setNotice(`已导入${category === 'artist' ? '画师串' : '质量风格'}组合，共 ${items.length} 项。`);
    } catch (error) { setError(error instanceof Error ? error.message : '组合导入失败。'); }
    finally { setImporting(false); }
  }
  function module(category: PromptCategory) {
    const title = category === 'artist' ? '画师串' : '质量风格';
    const chosen = selected.filter(item => item.category === category);
    const available = library.filter(item => item.category === category && !selected.some(current => current.id === item.id));
    const search = searchPromptModules(available, queries[category]);
    return <details className="prompt-module" open={category === 'artist' ? true : undefined}>
      <summary>{title}<small>{chosen.length} 项</small></summary>
      <div className="module-transfer-controls"><span>当前组合</span><button type="button" className="secondary" aria-label={`导出${title}组合`} disabled={!chosen.length || importing} onClick={() => { downloadBlob(new Blob([exportModuleSelection(category, selected)], { type: 'application/json' }), `${category}-modules.json`); }}><Download size={13} />导出</button><button type="button" className="secondary" aria-label={`导入${title}组合`} disabled={importing} onClick={() => (category === 'artist' ? artistFile : qualityFile).current?.click()}><Upload size={13} />导入</button><input ref={category === 'artist' ? artistFile : qualityFile} className="hidden-input" type="file" aria-label={`导入${title}组合文件`} accept=".json,application/json" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void importSelection(file, category); }} /></div>
      <div className="module-selected">{chosen.map(item => {
        const source = library.find(current => current.id === item.id);
        return <div className="module-row" key={item.id}>
          {source?.preview ? <button type="button" className="module-preview" aria-label={`预览 ${source.name}`} onClick={() => setPreview(source)}><img src={`/api/admin/prompts/${source.id}/preview?v=${source.preview}`} alt={source.name} /></button> : <span className="module-placeholder"><ImageIcon size={16} /></span>}
          <span className="module-name" title={item.prompt}>{source?.name ?? item.prompt}</span>
          {source && <a className="tool module-link" href={source.url} target="_blank" rel="noopener noreferrer" aria-label={`Danbooru ${source.name}`}><ExternalLink size={13} /></a>}
          <div className="module-weight"><button type="button" className="tool" aria-label={`${item.prompt} 权重减 0.1`} disabled={item.weight > 0 && item.weight <= 0.1} onClick={() => weight(item, -0.1)}><Minus size={12} /></button><output aria-label={`${item.prompt} 权重`}>{item.weight.toFixed(1)}</output><button type="button" className="tool" aria-label={`${item.prompt} 权重加 0.1`} disabled={item.weight < 0 && item.weight >= -0.1} onClick={() => weight(item, 0.1)}><Plus size={12} /></button></div>
          <button type="button" className="tool" aria-label={`移除 ${item.prompt}`} onClick={() => onChange(selected.filter(current => current.id !== item.id))}><X size={13} /></button>
        </div>;
      })}</div>
      <details className="module-library"><summary><Plus size={13} />添加{title}</summary><PromptSearch label={`搜索${title}`} query={queries[category]} onChange={query => setQueries(current => ({ ...current, [category]: query }))} count={search.items.length} error={search.error} /><div className="module-options">{search.items.map(item => <div className="module-option" key={item.id}><button type="button" className="module-add" onClick={() => add(item)} disabled={selected.length >= 100}>{item.preview && <img src={`/api/admin/prompts/${item.id}/preview?v=${item.preview}`} alt="" />}<span>{item.name}</span><Plus size={13} /></button><a className="tool" href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`Danbooru ${item.name}`}><ExternalLink size={13} /></a>{item.preview && <button className="tool" type="button" aria-label={`预览 ${item.name}`} onClick={() => setPreview(item)}><ImageIcon size={14} /></button>}</div>)}{!search.items.length && !search.error && <p className="setting-hint">{queries[category] ? '没有匹配的提示词。' : available.length ? '' : library.some(item => item.category === category) ? '已全部添加。' : '在管理中心添加或导入 txt。'}</p>}</div></details>
    </details>;
  }
  return <div className="prompt-modules">{module('artist')}{module('quality')}{error && <p className="setting-hint" role="alert">{error}</p>}{notice && <p className="setting-hint" role="status">{notice}</p>}{preview && <div className="module-preview-modal" role="dialog" aria-modal="true" aria-label="提示词预览" onClick={() => setPreview(undefined)}><button className="tool" aria-label="关闭提示词预览"><X size={24} /></button><img src={`/api/admin/prompts/${preview.id}/preview?v=${preview.preview}`} alt={preview.name} /><span>{preview.name}</span></div>}</div>;
}
