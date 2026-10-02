import { useState, type PointerEvent } from 'react';
import { ArrowDown, ArrowUp, Check, MapPin, Plus, Trash2, Users, X } from 'lucide-react';
import type { Character } from '../shared/types';
import { newId } from './id';

const COLORS = ['#c86c97', '#6999c8', '#e28eac', '#7eafd4', '#bc718e', '#8aacc8'];
type Props = { characters: Character[]; useCoords: boolean; disabled: boolean; onChange: (characters: Character[]) => void; onCoordsChange: (enabled: boolean) => void; aspectRatio: number };
export default function Characters({ characters, useCoords, disabled, onChange, onCoordsChange, aspectRatio }: Props) {
  const [positions, setPositions] = useState(false);
  const [selected, setSelected] = useState<string>('');
  function update(id: string, change: Partial<Character>) { onChange(characters.map(c => c.id === id ? { ...c, ...change } : c)); }
  function move(index: number, direction: number) {
    const next = [...characters];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    onChange(next);
  }
  function position(event: PointerEvent<HTMLDivElement>, id = selected) {
    if (disabled || !id || !(event.buttons & 1)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    update(id, { x: Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * 100) / 100,
      y: Math.round(Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) * 100) / 100 });
  }
  return <section className="characters-section">
    <div className="section-title"><span><Users size={16} />角色提示词 <small>{characters.length} / 22</small></span>
      <button className="tool" aria-label="添加角色" title="添加角色" disabled={disabled || characters.length >= 22} onClick={() => {
        onChange([...characters, { id: newId(), name: '', prompt: '', negativePrompt: '', enabled: true, x: 0.5, y: 0.5 }]);
      }}><Plus size={18} /></button>
    </div>
    {!characters.length && <button className="add-character" disabled={disabled} onClick={() => onChange([{ id: newId(), name: '', prompt: '', negativePrompt: '', enabled: true, x: 0.5, y: 0.5 }])}><Plus size={18} /><span>添加角色</span></button>}
    {characters.map((c, index) => <div className={`character-card ${c.enabled ? '' : 'muted'}`} key={c.id} style={{ '--character-color': COLORS[index % COLORS.length] } as React.CSSProperties}>
      <div className="character-header"><button className={`character-toggle ${c.enabled ? 'on' : ''}`} aria-label={`${c.enabled ? '禁用' : '启用'}角色 ${index + 1}`} onClick={() => update(c.id, { enabled: !c.enabled })} disabled={disabled}>{c.enabled && <Check size={12} />}</button>
        <span className="character-number">{String(index + 1).padStart(2, '0')}</span>
        <input aria-label={`角色 ${index + 1} 名称`} maxLength={100} placeholder={`角色 ${index + 1}`} value={c.name} onChange={e => update(c.id, { name: e.target.value })} disabled={disabled} />
        <button className="tool small" aria-label={`上移角色 ${index + 1}`} disabled={disabled || index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} /></button>
        <button className="tool small" aria-label={`下移角色 ${index + 1}`} disabled={disabled || index === characters.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} /></button>
        <button className="tool small" aria-label={`删除角色 ${index + 1}`} disabled={disabled} onClick={() => onChange(characters.filter(x => x.id !== c.id))}><X size={15} /></button>
      </div>
      <textarea aria-label={`角色 ${index + 1} 提示词`} maxLength={6000} rows={3} placeholder="girl, silver hair, blue eyes, ..." value={c.prompt} onChange={e => update(c.id, { prompt: e.target.value })} disabled={disabled} />
      <details className="character-negative"><summary>角色负面提示词</summary><textarea aria-label={`角色 ${index + 1} 负面提示词`} maxLength={6000} rows={2} placeholder="不希望出现在该角色上的特征" value={c.negativePrompt} onChange={e => update(c.id, { negativePrompt: e.target.value })} disabled={disabled} /></details>
    </div>)}
    {!!characters.length && <div className="position-setting"><label htmlFor="position-mode">角色位置</label><select id="position-mode" value={useCoords ? 'custom' : 'auto'} disabled={disabled} onChange={e => onCoordsChange(e.target.value === 'custom')}><option value="auto">AI 决定</option><option value="custom">自定义位置</option></select>
      {useCoords && <button className="text-button" disabled={disabled} onClick={() => { setPositions(true); setSelected(characters.find(c => c.enabled)?.id ?? characters[0].id); }}><MapPin size={13} />设置位置</button>}
    </div>}
    {positions && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setPositions(false); }}><section className="position-modal" role="dialog" aria-modal="true" aria-label="角色位置设置">
      <div className="modal-header"><span><MapPin size={17} />角色位置</span><button className="tool" aria-label="关闭位置设置" onClick={() => setPositions(false)}><X size={18} /></button></div>
      <p>选择角色，然后点击或拖动，设置角色在画面中的中心位置。</p>
      <div className="position-chips">{characters.map((c, i) => <button key={c.id} className={selected === c.id ? 'active' : ''} onClick={() => setSelected(c.id)} style={{ '--character-color': COLORS[i % COLORS.length] } as React.CSSProperties}>{i + 1} · {c.name || `角色 ${i + 1}`}</button>)}</div>
      <div className="position-grid" style={{ aspectRatio, width: `min(100%, ${48 * aspectRatio}vh)` }} onPointerDown={e => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const id = (e.target as HTMLElement).closest('[data-character-id]')?.getAttribute('data-character-id') ?? selected;
        setSelected(id); position(e, id);
      }} onPointerMove={e => position(e)} onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}>
        {characters.filter(c => c.enabled).map(c => { const index = characters.findIndex(x => x.id === c.id); return <button aria-label={`选择角色 ${index + 1} 的位置`} key={c.id} data-character-id={c.id} className={`position-dot ${selected === c.id ? 'selected' : ''}`} style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, background: COLORS[index % COLORS.length] }} onClick={() => setSelected(c.id)}>{index + 1}</button>; })}
      </div>
      <div className="modal-footer"><button className="text-button" onClick={() => { onChange(characters.map(c => ({ ...c, x: 0.5, y: 0.5 }))); }}><Trash2 size={14} />重置位置</button><button className="primary small-primary" onClick={() => setPositions(false)}><Check size={15} />完成</button></div>
    </section></div>}
  </section>;
}
