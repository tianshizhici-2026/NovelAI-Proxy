import { useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink, ImageIcon, Plus, Trash2 } from 'lucide-react';
import { danbooruUrl, type PromptModule, type PromptCategory } from '../shared/prompts';
import { accountJson } from './accountApi';
import { imageToDataUrl } from './storage';
import PromptSearch from './PromptSearch';
import { searchPromptModules } from './promptSearch';

export default function PromptManager() {
  const [items, setItems] = useState<PromptModule[]>([]);
  const [category, setCategory] = useState<PromptCategory>('artist');
  const [editing, setEditing] = useState<PromptModule>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<File>();
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [queries, setQueries] = useState({ artist: '', quality: '' });
  const search = searchPromptModules(items.filter(item => item.category === category), queries[category]);
  async function load() { const result = await accountJson<{ prompts: PromptModule[] }>('/api/admin/prompts'); setItems(result.prompts); }
  useEffect(() => { load().catch(error => setError(error.message)); }, []);
  function edit(item: PromptModule) { setEditing({ ...item }); setImage(undefined); setDeleteConfirm(false); setError(''); setNotice(''); }
  async function run(action: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); setNotice(''); try { await action(); } catch (error) { setError(error instanceof Error ? error.message : '操作失败。'); } finally { setBusy(false); } }
  return <section className="prompt-manager">
    {error && <p className="admin-notice is-error" role="alert">{error}</p>}{notice && <p className="admin-notice" role="status">{notice}</p>}
    {editing ? <form className="account-card admin-form" onSubmit={event => { event.preventDefault(); void run(async () => {
      const { id, preview: _preview, ...body } = editing;
      const result = await accountJson<{ prompt: PromptModule }>(`/api/admin/prompts${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      // Keep the saved ID if image upload fails, so retrying updates the same item.
      setEditing(result.prompt);
      if (image) await accountJson(`/api/admin/prompts/${result.prompt.id}/preview`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: await imageToDataUrl(image) }) });
      await load(); setEditing(undefined); setImage(undefined); setNotice('提示词已保存。');
    }); }}>
      <div className="admin-form-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setEditing(undefined)}><ArrowLeft size={14} />返回列表</button></div>
      <label htmlFor="module-category">模块</label><select id="module-category" value={editing.category} disabled={busy} onChange={e => setEditing({ ...editing, category: e.target.value as PromptCategory })}><option value="artist">画师串</option><option value="quality">质量风格</option></select>
      <label htmlFor="module-name">显示名称</label><input id="module-name" required maxLength={120} value={editing.name} disabled={busy} onChange={e => setEditing({ ...editing, name: e.target.value })} />
      <label htmlFor="module-prompt">提示词</label><textarea id="module-prompt" required maxLength={6000} rows={4} value={editing.prompt} disabled={busy} onChange={e => setEditing({ ...editing, prompt: e.target.value })} placeholder="artist:xxx 或一组提示词" />
      <label htmlFor="module-url">跳转 URL</label><div className="module-url-input"><input id="module-url" type="url" required maxLength={2000} value={editing.url} disabled={busy} onChange={e => setEditing({ ...editing, url: e.target.value })} /><button type="button" className="secondary" disabled={busy} onClick={() => setEditing({ ...editing, url: danbooruUrl(editing.prompt) })}>Danbooru</button></div>
      <label htmlFor="module-preview-file">演示预览</label>{editing.preview && <img className="manager-preview" src={`/api/admin/prompts/${editing.id}/preview?v=${editing.preview}`} alt="当前演示预览" />}<input id="module-preview-file" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e => { const file = e.target.files?.[0]; if (file && file.size > 8 * 1024 * 1024) { setError('预览图不能超过 8 MB。'); e.target.value = ''; return; } setImage(file); }} /><small className="admin-form-hint">PNG、JPEG 或 WebP，最大 8 MB，保存到服务器本地。</small>
      <div className="admin-form-actions">{editing.id && <button type="button" className="secondary" disabled={busy} onClick={() => setDeleteConfirm(true)}><Trash2 size={14} />删除</button>}<button className="primary" disabled={busy}>{busy ? '保存中…' : '保存提示词'}</button></div>
      {deleteConfirm && <div className="admin-delete-confirm"><p>删除 {editing.name}？</p><button type="button" className="secondary" disabled={busy} onClick={() => setDeleteConfirm(false)}>取消</button><button type="button" className="danger-button" disabled={busy} onClick={() => void run(async () => { await accountJson(`/api/admin/prompts/${editing.id}`, { method: 'DELETE' }); await load(); setEditing(undefined); setNotice('提示词已删除。'); })}>确认删除</button></div>}
    </form> : <>
      <div className="module-manager-toolbar"><div className="admin-tabs"><button className={category === 'artist' ? 'active' : ''} onClick={() => setCategory('artist')}>画师串</button><button className={category === 'quality' ? 'active' : ''} onClick={() => setCategory('quality')}>质量风格</button></div><button className="primary" onClick={() => edit({ id: '', category, name: '', prompt: '', url: danbooruUrl('') })}><Plus size={14} />新增提示词</button></div>
      <label className="module-import secondary">导入 txt<input type="file" accept=".txt,text/plain" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; void run(async () => { if (file.size > 2_000_000) throw new Error('txt 最大 2 MB。'); const result = await accountJson<{ added: number; prompts: PromptModule[] }>('/api/admin/prompts/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category, text: await file.text() }) }); setItems(result.prompts); setNotice(`已导入 ${result.added} 条提示词。`); }); }} /></label><p className="admin-form-hint">每行一个模块；也支持“名称、提示词、URL”以 Tab 分隔。普通模块初始权重为 0.8；负权重串保留导入值。</p>
      <PromptSearch label="搜索管理提示词" query={queries[category]} onChange={query => setQueries(current => ({ ...current, [category]: query }))} count={search.items.length} error={search.error} />
      <div className="module-manager-list">{search.items.map(item => <div className="module-manager-item" key={item.id}><button onClick={() => edit(item)}>{item.preview ? <img src={`/api/admin/prompts/${item.id}/preview?v=${item.preview}`} alt={item.name} /> : <span className="module-placeholder"><ImageIcon size={20} /></span>}<span><strong>{item.name}</strong><small>{item.prompt}</small></span></button><a className="tool" href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`Danbooru ${item.name}`}><ExternalLink size={16} /></a></div>)}{!search.items.length && !search.error && <p className="account-card admin-form-hint">{queries[category] ? '没有匹配的提示词。' : '尚无提示词，可新增或导入 txt。'}</p>}</div>
    </>}
  </section>;
}
