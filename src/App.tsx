import { useEffect, useMemo, useRef, useState } from 'react';
import { Aperture, ArrowDownToLine, ArrowRight, Check, Copy, Expand, FileImage, History, ImagePlus, Images, Info, Layers, LoaderCircle, LockKeyhole, UnlockKeyhole, LogOut, Moon, Paintbrush, Plus, RotateCcw, Settings2, ShieldCheck, Sparkles, Sun, Trash2, Upload, WandSparkles, X } from 'lucide-react';
import { zipSync, strToU8 } from 'fflate';
import { DEFAULT_SETTINGS, RESOLUTIONS, type GenerationMode, type GenerationJobStatus, type HistoryEntry, type Resolution, type ServiceStatus, type Settings } from '../shared/types';
import { DEFAULT_NEGATIVE_PROMPT, splitNegativePrompt } from '../shared/negative';
import Characters from './Characters';
import MaskCanvas, { type MaskHandle } from './MaskCanvas';
import PromptSheet from './PromptSheet';
import ImageViewport from './ImageViewport';
import { importImageMetadata, pngMetadata } from './metadata';
import { newId } from './id';
import { clearHistory, deleteHistory, downloadBlob, fitImage, imageToDataUrl, loadHistory, saveHistory } from './storage';
import type { AccountView } from '../shared/accounts';
import { accountFetch } from './accountApi';

function initialSettings(draftKey: string): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(draftKey) ?? 'null');
    if (saved && typeof saved.prompt === 'string' && typeof saved.negativePrompt === 'string' && Array.isArray(saved.characters)) {
      const negative = typeof saved.defaultNegative === 'boolean'
        ? { negativePrompt: saved.negativePrompt, defaultNegative: saved.defaultNegative }
        : splitNegativePrompt(saved.negativePrompt);
      return { ...DEFAULT_SETTINGS,
        prompt: saved.prompt.slice(0, 12000), negativePrompt: negative.negativePrompt.slice(0, 12000), defaultNegative: negative.defaultNegative,
        qualityTags: saved.qualityTags !== false, useCoords: saved.positionDefaultsVersion === 1 && saved.useCoords === true,
        strength: Math.min(1, Math.max(0.01, Number.isFinite(saved.strength) ? saved.strength : DEFAULT_SETTINGS.strength)),
        noise: Math.min(1, Math.max(0, Number.isFinite(saved.noise) ? saved.noise : DEFAULT_SETTINGS.noise)),
        seed: Number.isInteger(saved.seed) && saved.seed >= 0 && saved.seed <= 0xffffffff ? saved.seed : null,
        resolution: saved.resolution in RESOLUTIONS ? saved.resolution : 'portrait',
        steps: Math.min(28, Math.max(23, Math.round(Number(saved.steps) || 23))),
        guidance: Math.min(10, Math.max(0.1, Number(saved.guidance) || 7)),
        characters: saved.characters.filter((c: Record<string, unknown>) => typeof c?.id === 'string' && typeof c.prompt === 'string' && typeof c.negativePrompt === 'string').slice(0, 22).map((c: Record<string, unknown>) => ({
          id: String(c.id).slice(0, 80), name: String(c.name ?? '').slice(0, 100), prompt: String(c.prompt).slice(0, 6000), negativePrompt: String(c.negativePrompt).slice(0, 6000), enabled: c.enabled !== false,
          x: Math.max(0, Math.min(1, Number.isFinite(Number(c.x)) ? Number(c.x) : 0.5)), y: Math.max(0, Math.min(1, Number.isFinite(Number(c.y)) ? Number(c.y) : 0.5)),
        })),
      };
    }
  } catch { /* An unavailable browser store must not prevent use. */ }
  return { ...DEFAULT_SETTINGS };
}
function nextRandomSeed() { return crypto.getRandomValues(new Uint32Array(1))[0]; }
function initialDisplayedSeed(draftKey: string) {
  try {
    const seed = JSON.parse(localStorage.getItem(draftKey) ?? 'null')?.displayedSeed;
    if (Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff) return seed as number;
  } catch { /* Start with a fresh random seed when storage is unavailable. */ }
  return nextRandomSeed();
}
function humanTime(createdAt: number) { return new Date(createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
function initialInpaintStrength(draftKey: string) {
  try {
    const saved = JSON.parse(localStorage.getItem(`${draftKey}:inpaint-strength`) ?? 'null');
    if (typeof saved === 'number' && Number.isFinite(saved)) return Math.min(1, Math.max(0.01, saved));
  } catch { /* Use the recommended strength if storage is unavailable. */ }
  return DEFAULT_SETTINGS.strength;
}
function filename(entry: HistoryEntry) { return `novelai-${new Date(entry.createdAt).toISOString().replace(/[:.]/g, '-')}.png`; }
const modeName = (mode: GenerationMode) => mode === 'inpaint' ? '局部重绘' : mode === 'img2img' ? '图生图' : '文生图';

export default function App({ user, onAdmin, onLogout }: { user: AccountView; onAdmin: () => void; onLogout: () => void }) {
  const storageOwner = user.role === 'admin' ? undefined : user.username;
  const draftKey = storageOwner ? `novelai-draft:${storageOwner}` : 'novelai-draft';
  const [theme, setTheme] = useState<'white-pink' | 'black-pink'>(() => {
    try { return localStorage.getItem('novelai-theme') === 'black-pink' ? 'black-pink' : 'white-pink'; }
    catch { return 'white-pink'; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'black-pink' ? '#17131b' : '#fff9fb');
    try { localStorage.setItem('novelai-theme', theme); } catch { /* Keep the current theme without storage. */ }
  }, [theme]);
  const [settings, setSettings] = useState<Settings>(() => initialSettings(draftKey));
  const [randomSeed, setRandomSeed] = useState(() => initialDisplayedSeed(draftKey));
  const [inpaintStrength, setInpaintStrength] = useState(() => initialInpaintStrength(draftKey));
  const [mode, setMode] = useState<GenerationMode>('generate');
  const [status, setStatus] = useState<ServiceStatus>({ configured: false, ready: false, message: '正在连接服务…' });
  const [statusLoading, setStatusLoading] = useState(true);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [baseSource, setBaseSource] = useState('');
  const [baseImage, setBaseImage] = useState('');
  const [fitting, setFitting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [hasMask, setHasMask] = useState(false);
  const [showEditor, setShowEditor] = useState(true);
  const [busy, setBusy] = useState(false);
  const [queuePosition, setQueuePosition] = useState(0);
  const busyText = queuePosition > 0 ? `排队中 · 第 ${queuePosition} 位` : '正在生成…';
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<'prompts' | 'settings' | 'history' | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 980px)').matches);
  const maskRef = useRef<MaskHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const referenceFileRef = useRef<HTMLInputElement>(null);
  const metadataFileRef = useRef<HTMLInputElement>(null);
  const importingRef = useRef(false);
  const busyRef = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  const resolution = RESOLUTIONS[settings.resolution];
  const selected = entries.find(e => e.id === selectedId);
  const urls = useMemo(() => new Map(entries.map(e => [e.id, URL.createObjectURL(e.blob)])), [entries]);
  useEffect(() => () => { urls.forEach(url => URL.revokeObjectURL(url)); }, [urls]);
  const selectedUrl = selected ? urls.get(selected.id) : undefined;
  const hasPrompt = !!settings.prompt.trim() || settings.characters.some(c => c.enabled && c.prompt.trim());
  const canGenerate = status.ready && !busy && !fitting && !importing && hasPrompt && (mode === 'generate' || (!!baseImage && (mode === 'img2img' || hasMask)));
  const patch = (change: Partial<Settings>) => setSettings(s => ({ ...s, ...change }));
  function restoreEntrySettings(entry: HistoryEntry) {
    setSettings(current => structuredClone({ ...DEFAULT_SETTINGS, ...entry.settings,
      strength: entry.mode === 'img2img' ? entry.settings.strength : current.strength,
      noise: entry.mode === 'img2img' ? entry.settings.noise : current.noise,
    }));
    if (entry.mode === 'inpaint') setInpaintStrength(Math.max(0.01, entry.settings.strength));
  }
  useEffect(() => {
    if (mode !== 'generate' && settings.strength < 0.01) patch({ strength: 0.01 });
  }, [mode, settings.strength]);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 980px)');
    const changed = () => { setIsMobile(query.matches); setMobilePanel(null); };
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);

  async function refreshStatus() {
    setStatusLoading(true);
    try {
      const response = await accountFetch('/api/status', { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error();
      setStatus(await response.json());
    } catch { setStatus({ configured: false, ready: false, message: '服务连接失败' }); }
    finally { setStatusLoading(false); }
  }
  useEffect(() => { void refreshStatus(); }, [user.quota, user.used]);
  useEffect(() => {
    const interval = setInterval(() => { if (!busyRef.current) void refreshStatus(); }, 60_000);
    loadHistory(storageOwner).then(history => { setEntries(history); setSelectedId(history[0]?.id ?? ''); })
      .catch(() => setNotice({ text: '浏览器历史存储不可用，生成后请及时下载。', error: true }));
    return () => { clearInterval(interval); requestRef.current?.abort(); };
  }, []);
  useEffect(() => {
    try { localStorage.setItem(draftKey, JSON.stringify({ ...settings, displayedSeed: settings.seed ?? randomSeed, positionDefaultsVersion: 1 })); } catch { /* Continue without persistence. */ }
  }, [settings, randomSeed]);
  useEffect(() => {
    try { localStorage.setItem(`${draftKey}:inpaint-strength`, JSON.stringify(inpaintStrength)); } catch { /* Continue without persistence. */ }
  }, [inpaintStrength]);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), notice.error || notice.text.length > 70 ? 10_000 : 3500);
    return () => clearTimeout(id);
  }, [notice]);
  useEffect(() => {
    if (!baseSource) { setBaseImage(''); setHasMask(false); return; }
    let current = true;
    setFitting(true); setHasMask(false);
    fitImage(baseSource, resolution.width, resolution.height).then(image => { if (current) setBaseImage(image); })
      .catch(() => { if (current) { setBaseImage(''); setNotice({ text: '无法处理这张图片，请使用有效的 PNG、JPEG 或 WebP。', error: true }); } })
      .finally(() => { if (current) setFitting(false); });
    return () => { current = false; };
  }, [baseSource, resolution.width, resolution.height]);
  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') { setFullscreen(false); setMobilePanel(null); setConfirmClear(false); }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (canGenerate) void generate(); }
    }
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  });

  async function importFile(file: File, target: 'inpaint' | 'img2img' = 'inpaint') {
    if (busyRef.current || importingRef.current) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) {
      setNotice({ text: '请选择不超过 20 MB 的 PNG、JPEG 或 WebP 图片。', error: true }); return;
    }
    importingRef.current = true; setImporting(true);
    try {
      const source = await imageToDataUrl(file);
      const image = new Image(); image.src = source; await image.decode();
      if (image.width * image.height > 40_000_000) throw new Error();
      const ratio = image.width / image.height;
      const closest = (Object.keys(RESOLUTIONS) as Resolution[]).sort((a, b) => Math.abs(Math.log(ratio / (RESOLUTIONS[a].width / RESOLUTIONS[a].height))) - Math.abs(Math.log(ratio / (RESOLUTIONS[b].width / RESOLUTIONS[b].height))))[0];
      const metadata = target === 'img2img' && ['image/png', 'image/webp'].includes(file.type)
        ? await importImageMetadata(file).catch(() => null) : null;
      patch({ resolution: closest, ...metadata?.settings }); setBaseSource(source); setMode(target); setShowEditor(true); setMobilePanel(null);
      setNotice({ text: metadata ? `参考图已载入，并覆盖提示词、角色和生成参数。${metadata.notes.join('')}` : target === 'img2img' ? '参考图已载入，可调整 Strength 和 Noise。' : '底图已载入。', error: false });
    } catch { setNotice({ text: '图片读取失败，或像素尺寸过大。', error: true }); }
    finally { importingRef.current = false; setImporting(false); }
  }
  async function importMetadata(file: File) {
    if (busyRef.current || importingRef.current) return;
    importingRef.current = true; setImporting(true);
    try {
      const result = await importImageMetadata(file);
      patch(result.settings); setMode('generate');
      setNotice({ text: `已导入提示词、角色和生成设置。${result.notes.join('')}`, error: false });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : '图片元数据读取失败。', error: true });
    } finally { importingRef.current = false; setImporting(false); }
  }
  async function generate() {
    if (!canGenerate || busyRef.current || importingRef.current) return;
    let seed = settings.seed;
    if (seed === null) {
      seed = nextRandomSeed();
      if (seed === randomSeed) seed = (seed + 1) >>> 0;
      setRandomSeed(seed);
    }
    const snapshot = structuredClone({ ...settings, seed, strength: mode === 'inpaint' ? inpaintStrength : Math.max(0.01, settings.strength) });
    const requestMode = mode;
    const input = { ...snapshot, mode: requestMode, ...(requestMode === 'inpaint' ? { image: baseImage, mask: maskRef.current!.exportMask() } : requestMode === 'img2img' ? { image: baseImage } : {}) };
    busyRef.current = true; setBusy(true); setQueuePosition(0); setMobilePanel(null); setNotice(null);
    const controller = new AbortController(); requestRef.current = controller;
    const generationId = newId();
    let polling = false;
    const poll = async () => {
      if (polling || controller.signal.aborted) return;
      polling = true;
      try {
        const response = await accountFetch(`/api/queue/${generationId}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
        if (response.ok && !controller.signal.aborted) {
          const job = await response.json() as GenerationJobStatus;
          if (!controller.signal.aborted) setQueuePosition(job.state === 'waiting' ? job.position : 0);
        }
      } catch { /* A temporary polling failure must not resubmit the generation. */ }
      finally { polling = false; }
    };
    const queuePoll = setInterval(() => void poll(), 1500);
    try {
      const response = await accountFetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Generation-ID': generationId }, body: JSON.stringify(input), signal: controller.signal });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error ?? `生成失败（HTTP ${response.status}）。`);
      }
      if (!response.headers.get('content-type')?.includes('image/')) throw new Error('服务器没有返回有效图片。');
      const blob = await response.blob();
      try {
        const metadata = pngMetadata(new Uint8Array(await blob.arrayBuffer()));
        const seed = JSON.parse(metadata.Comment ?? '{}').seed;
        if (Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff) { snapshot.seed = seed; if (settings.seed === null) setRandomSeed(seed); }
      } catch { /* Keep the submitted seed when the result has no readable metadata. */ }
      const entry: HistoryEntry = { id: newId(), createdAt: Date.now(), blob, settings: snapshot, mode: requestMode };
      setEntries(es => [entry, ...es]); setSelectedId(entry.id); setShowEditor(false);
      try { await saveHistory(entry, storageOwner); } catch { setNotice({ text: '图片已生成，但本地存储空间不足，请及时下载。', error: true }); }
    } catch (error) {
      if (!controller.signal.aborted) setNotice({ text: error instanceof Error ? error.message : '生成失败，请稍后重试。', error: true });
    } finally { clearInterval(queuePoll); controller.abort(); busyRef.current = false; setBusy(false); setQueuePosition(0); requestRef.current = null; void refreshStatus(); }
  }
  async function useForInpaint(entry: HistoryEntry, target: 'inpaint' | 'img2img' = 'inpaint') {
    if (busy) return;
    const source = await imageToDataUrl(entry.blob);
    restoreEntrySettings(entry);
    if (target === 'inpaint' && entry.mode !== 'inpaint') setInpaintStrength(DEFAULT_SETTINGS.strength);
    setBaseSource(source); setMode(target); setShowEditor(true);
  }
  async function removeEntry(entry: HistoryEntry) {
    try { await deleteHistory(entry.id, storageOwner); } catch { setNotice({ text: '无法删除本地历史。', error: true }); return; }
    setEntries(es => es.filter(e => e.id !== entry.id));
    if (selectedId === entry.id) setSelectedId(entries.find(e => e.id !== entry.id)?.id ?? '');
  }
  async function downloadAll() {
    if (!entries.length || exporting) return;
    setExporting(true);
    try {
      const files: Record<string, Uint8Array> = {};
      for (const entry of entries) {
        files[filename(entry)] = new Uint8Array(await entry.blob.arrayBuffer());
        files[filename(entry).replace('.png', '.json')] = strToU8(JSON.stringify({ ...entry.settings, mode: entry.mode }, null, 2));
      }
      downloadBlob(new Blob([new Uint8Array(zipSync(files, { level: 0 }))], { type: 'application/zip' }), 'novelai-history.zip');
    } catch { setNotice({ text: '导出失败，请尝试逐张下载。', error: true }); }
    finally { setExporting(false); }
  }
  const promptPanel = <>
    <div className="panel-heading"><span><Layers size={16} />创作提示词</span><button className="tool mobile-only" onClick={() => setMobilePanel(null)} aria-label="关闭提示词面板"><X size={18} /></button></div>
    <div className="prompt-scroll">
      <div className="prompt-label"><label htmlFor="base-prompt">场景提示词</label><span>Prompt</span></div>
      <div className="prompt-editor"><textarea id="base-prompt" maxLength={12000} rows={7} placeholder={'描述你想创作的画面…\n\n例如：1girl, outdoors, cherry blossoms, soft lighting'} value={settings.prompt} onChange={e => patch({ prompt: e.target.value })} /><div className="editor-footer"><span /><span>{settings.prompt.length.toLocaleString()} 字符</span></div></div>
      <label className="toggle-row quality-row"><span><Sparkles size={15} />添加质量词</span><input type="checkbox" checked={settings.qualityTags} onChange={e => patch({ qualityTags: e.target.checked })} /><i className="switch" /></label>
      <Characters characters={settings.characters} useCoords={settings.useCoords} disabled={false} onChange={characters => patch({ characters })} onCoordsChange={useCoords => patch({ useCoords })} aspectRatio={resolution.width / resolution.height} />
      <div className="prompt-label negative-label"><label htmlFor="negative-prompt">负面提示词</label></div>
      <label className="toggle-row default-negative-row"><span>默认负面</span><input aria-label="默认负面提示词" type="checkbox" checked={settings.defaultNegative} onChange={e => patch({ defaultNegative: e.target.checked })} /><i className="switch" /></label>
      <details className="default-negative-details"><summary>V5 Light</summary><p>{DEFAULT_NEGATIVE_PROMPT}</p></details>
      <div className="prompt-editor negative"><textarea id="negative-prompt" maxLength={12000} rows={4} placeholder="自定义负面提示词" value={settings.negativePrompt} onChange={e => patch({ negativePrompt: e.target.value })} /><div className="editor-footer"><span>自定义</span><span>{settings.negativePrompt.length.toLocaleString()}</span></div></div>
    </div>
    <div className="prompt-bottom"><button className="secondary upload-button" onClick={() => referenceFileRef.current?.click()} disabled={busy}><ImagePlus size={17} />参考 · 图生图<Plus size={15} /></button><button className="secondary upload-button" onClick={() => fileRef.current?.click()} disabled={busy}><Paintbrush size={17} />上传图片进行重绘<Plus size={15} /></button></div>
  </>;
  const settingsPanel = <>
    <div className="panel-heading"><span><Settings2 size={16} />生成设置</span><button className="tool" title="恢复默认生成设置" aria-label="恢复默认生成设置" disabled={busy} onClick={() => { patch({ resolution: 'portrait', steps: 23, guidance: 7, seed: null, strength: DEFAULT_SETTINGS.strength, noise: DEFAULT_SETTINGS.noise }); setInpaintStrength(DEFAULT_SETTINGS.strength); }}><RotateCcw size={14} /></button><button className="tool mobile-only" aria-label="关闭设置面板" onClick={() => setMobilePanel(null)}><X size={18} /></button></div>
    <div className="settings-scroll">
      <div className="setting-label">图像尺寸</div>
      <div className="resolution-list">{(Object.keys(RESOLUTIONS) as Resolution[]).map(key => { const r = RESOLUTIONS[key]; return <button key={key} disabled={busy || fitting} className={`resolution-card ${settings.resolution === key ? 'selected' : ''}`} onClick={() => { patch({ resolution: key }); if (mode === 'inpaint') setShowEditor(true); }}>
        <span className={`aspect-icon ${key}`} /><span><strong>{r.name}</strong><small>{r.width} × {r.height}</small></span>{settings.resolution === key && <Check size={14} />}
      </button>; })}</div>
      <div className="setting-divider" />
      <div className="setting-label"><label htmlFor="steps">迭代步数</label><span>Steps</span></div>
      <div className="steps-grid">{[23, 24, 25, 26, 27, 28].map(step => <button id={step === 23 ? 'steps' : undefined} className={settings.steps === step ? 'selected' : ''} key={step} disabled={busy} onClick={() => patch({ steps: step })}>{step}</button>)}</div>
      <p className="setting-hint">23 为 V5 推荐默认值</p>
      <div className="setting-label guidance-label"><label htmlFor="guidance">提示词引导</label><span>Guidance</span></div>
      <div className="guidance-value"><strong>{settings.guidance.toFixed(1)}</strong><input id="guidance" aria-label="Guidance 数值" type="number" min="0.1" max="10" step="0.1" value={settings.guidance} disabled={busy} onChange={e => { const value = Number(e.target.value); if (Number.isFinite(value) && value >= 0.1 && value <= 10) patch({ guidance: value }); }} /></div>
      <input className="guidance-slider" aria-label="Guidance 滑块" type="range" min="0.1" max="10" step="0.1" value={settings.guidance} disabled={busy} onChange={e => patch({ guidance: Number(e.target.value) })} />
      <div className="range-labels"><span>自由创作</span><span>贴合提示词</span></div>
      <div className="setting-divider" />
      <div className="fixed-setting"><span>采样器 <small>Sampler</small></span><LockKeyhole size={13} /><strong>Euler Ancestral</strong></div>
      <div className="seed-setting"><label htmlFor="seed-value">Seed:</label><input id="seed-value" aria-label="Seed 数值" type="number" min="0" max="4294967295" step="1" value={settings.seed ?? randomSeed} readOnly={settings.seed === null} disabled={busy} onChange={e => { const value = Number(e.target.value); if (settings.seed !== null && e.target.value !== '' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff) patch({ seed: value }); }} /><button className={`tool seed-lock${settings.seed !== null ? ' active' : ''}`} type="button" aria-label={settings.seed === null ? '锁定 Seed' : '解锁 Seed'} aria-pressed={settings.seed !== null} title={settings.seed === null ? '锁定当前 Seed，启用编辑' : '解锁后每次生成随机 Seed'} disabled={busy} onClick={() => { if (settings.seed === null) patch({ seed: randomSeed }); else { setRandomSeed(settings.seed); patch({ seed: null }); } }}>{settings.seed === null ? <UnlockKeyhole size={17} /> : <LockKeyhole size={17} />}</button></div>
      <div className="fixed-setting"><span>生成数量 <small>Images</small></span><LockKeyhole size={13} /><strong>1 张</strong></div>
      {mode === 'inpaint' && <div className="inpaint-settings"><p className="setting-hint">{inpaintStrength === 1 ? '强度 1 会完全重画涂抹部分，不保留该部分原有结构。' : '以完整底图为上下文；强度越低，越保留涂抹部分的原有结构。'}</p><p className="setting-hint">边缘会柔化融合。修改分辨率会重新适配底图并清空蒙版。</p></div>}
    </div>
    <div className="generate-area"><div className="generation-summary"><span>{resolution.width} × {resolution.height} · {settings.steps} steps</span></div><button className="primary generate-button" onClick={() => void generate()} disabled={!canGenerate} title={!status.ready ? status.message : !hasPrompt ? '请先填写提示词' : mode !== 'generate' && !baseImage ? '请先上传图片' : mode === 'inpaint' && !hasMask ? '请先绘制蒙版' : 'Ctrl + Enter'}>{busy ? <LoaderCircle size={19} className="spin" /> : <WandSparkles size={19} />}<span>{busy ? busyText : mode === 'inpaint' ? '生成局部重绘' : mode === 'img2img' ? '生成 图生图' : '生成图像'}</span>{!busy && <ArrowRight size={17} />}</button>{!status.ready && !busy && <p className="service-hint">{status.message}</p>}</div>
  </>;
  const historyPanel = <>
    <div className="history-heading"><History size={16} /><span>历史</span><small>{entries.length}</small><button className="tool mobile-only" aria-label="关闭历史面板" onClick={() => setMobilePanel(null)}><X size={16} /></button></div>
    <div className="history-list">{entries.map((entry, index) => <div key={entry.id} className={`history-item ${selectedId === entry.id ? 'selected' : ''}`}><button className="history-thumb" title={`${humanTime(entry.createdAt)} · ${modeName(entry.mode)}`} aria-label={`查看历史图像 ${index + 1}`} onClick={() => { setSelectedId(entry.id); setShowEditor(false); setMobilePanel(null); }}><img src={urls.get(entry.id)} alt={`生成图像 ${index + 1}`} /><span>{entry.mode === 'inpaint' ? <Paintbrush size={10} /> : <Images size={10} />}</span></button><div className="history-meta"><span>{humanTime(entry.createdAt)}</span><button className="tool" aria-label={`删除历史图像 ${index + 1}`} title="删除" disabled={busy} onClick={() => void removeEntry(entry)}><X size={12} /></button></div></div>)}{!entries.length && <div className="history-empty"><FileImage size={23} /><span>暂无历史</span></div>}</div>
    <div className="history-bottom"><button className="tool" title="下载全部图片与提示词 ZIP" aria-label="下载全部历史" disabled={!entries.length || exporting} onClick={() => void downloadAll()}>{exporting ? <LoaderCircle size={16} className="spin" /> : <ArrowDownToLine size={16} />}</button><button className="tool" title="清空历史" aria-label="清空历史" disabled={!entries.length || busy} onClick={() => setConfirmClear(true)}><Trash2 size={15} /></button></div>
  </>;
  return <div className="app-shell">
    <input type="file" ref={fileRef} aria-label="上传重绘底图" className="hidden-input" accept="image/png,image/jpeg,image/webp" onChange={e => { const file = e.target.files?.[0]; if (file) void importFile(file); e.target.value = ''; }} />
    <input type="file" ref={referenceFileRef} aria-label="上传 图生图 参考图" className="hidden-input" accept="image/png,image/jpeg,image/webp" onChange={e => { const file = e.target.files?.[0]; if (file) void importFile(file, 'img2img'); e.target.value = ''; }} />
    <input type="file" ref={metadataFileRef} aria-label="上传图片导入元数据" className="hidden-input" accept="image/png,image/webp" onChange={e => { const file = e.target.files?.[0]; if (file) void importMetadata(file); e.target.value = ''; }} />
    <header className="topbar"><a className="brand" href="/" aria-label="NovelAI 图像工作台"><Aperture size={24} /><strong>Novel<span>AI</span></strong><i /> <small>图像工作台</small></a><div className="topbar-right">{user.role === 'admin' && <button className="secondary manage-entry" onClick={onAdmin} disabled={busy}><ShieldCheck size={15} /><span>账号管理</span></button>}<div className="workspace-account" title={`${user.username} · ${user.role === 'admin' ? `NAI 官方 Opus 剩余额度 ${status.usagePercent === undefined ? '读取中' : `${Math.floor(status.usagePercent)}%`}` : `剩余 ${user.remaining} / ${user.quota} 张`}`}><span>{user.username}</span><small>{user.role === 'admin' ? `Opus 剩余 ${status.usagePercent === undefined ? '—' : `${Math.floor(status.usagePercent)}%`}` : `剩余 ${status.account?.remaining ?? user.remaining ?? 0} 张`}</small></div><button className="tool account-logout" aria-label="退出登录" title="退出登录" disabled={busy} onClick={onLogout}><LogOut size={16} /></button><button className="tool theme-toggle" aria-label={theme === 'white-pink' ? '切换黑粉主题' : '切换白粉主题'} title={theme === 'white-pink' ? '黑粉主题' : '白粉主题'} onClick={() => setTheme(t => t === 'white-pink' ? 'black-pink' : 'white-pink')}>{theme === 'white-pink' ? <Moon size={18} /> : <Sun size={18} />}</button><button className={`connection-status ${status.ready ? 'connected' : ''}`} title={status.message} onClick={() => void refreshStatus()} disabled={statusLoading}><i className={`dot ${status.ready ? 'green' : ''}`} /><span>{statusLoading ? '连接中' : status.ready ? '已连接' : status.configured ? '服务待就绪' : '等待连接'}</span>{status.usagePercent !== undefined && <small>{Math.floor(status.usagePercent)}%</small>}</button></div></header>
    <div className="workspace">
      <nav className="nav-rail"><button className={`rail-button ${mode === 'generate' ? 'active' : ''}`} title="文生图" aria-label="切换文生图" disabled={busy} onClick={() => { setMode('generate'); setMobilePanel(null); }}><Images size={21} /></button><button className={`rail-button ${mode === 'inpaint' ? 'active' : ''}`} title="局部重绘" aria-label="切换局部重绘" disabled={busy} onClick={() => { setMode('inpaint'); setShowEditor(true); }}><Paintbrush size={21} /></button><button className={`rail-button ${mode === 'img2img' ? 'active' : ''}`} title="图生图" aria-label="切换 图生图" disabled={busy} onClick={() => { setMode('img2img'); setShowEditor(true); }}><ImagePlus size={21} /></button><div className="rail-divider" /><button className="rail-button" title="上传图片" aria-label="上传底图" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={20} /></button><div className="rail-spacer" /><span className="rail-version">V5</span></nav>
      {!isMobile && <aside className="prompt-panel desktop-panel">{promptPanel}</aside>}
      <main className="stage" onDragOver={e => { e.preventDefault(); }} onDrop={e => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file) void importFile(file, mode === 'img2img' ? 'img2img' : 'inpaint'); }}>
        <div className="stage-header"><div className="stage-tabs"><button className={mode === 'generate' ? 'active' : ''} disabled={busy || importing} onClick={() => setMode('generate')}><Sparkles size={14} />文生图</button><button className={mode === 'inpaint' ? 'active' : ''} disabled={busy || importing} onClick={() => { setMode('inpaint'); setShowEditor(true); }}><Paintbrush size={14} />局部重绘</button><button className={mode === 'img2img' ? 'active' : ''} disabled={busy || importing} onClick={() => { setMode('img2img'); setShowEditor(true); }}><ImagePlus size={14} />图生图</button></div>{mode === 'generate' ? <button className="secondary metadata-import" disabled={busy || importing} onClick={() => metadataFileRef.current?.click()} title="上传 NovelAI 原图，直接导入提示词、角色和生成设置">{importing ? <LoaderCircle size={14} className="spin" /> : <FileImage size={14} />}<span>{importing ? '正在导入…' : '导入元数据'}</span></button> : null}</div>
        {mode === 'inpaint' && <div className="img2img-controls inpaint-controls" aria-label="局部重绘参数">
          <div className="reference-control"><div className="reference-control-label"><label htmlFor="inpaint-strength">Strength</label><input id="inpaint-strength" aria-label="重绘 Strength 数值" type="number" min="0.01" max="1" step="0.01" value={inpaintStrength} disabled={busy} onChange={e => { const value = Number(e.target.value); if (Number.isFinite(value) && value >= 0.01 && value <= 1) setInpaintStrength(value); }} /></div><input aria-label="重绘强度" className="guidance-slider" type="range" min="0.01" max="1" step="0.01" value={inpaintStrength} disabled={busy} onChange={e => setInpaintStrength(Number(e.target.value))} /></div>
        </div>}
        {mode === 'img2img' && <div className="img2img-controls" aria-label="图生图参数">
          {(['strength', 'noise'] as const).map(key => <div className="reference-control" key={key}>
            <div className="reference-control-label"><label htmlFor={`reference-${key}`}>{key === 'strength' ? 'Strength' : 'Noise'}</label><input id={`reference-${key}`} aria-label={`图生图 ${key === 'strength' ? 'Strength' : 'Noise'} 数值`} type="number" min={key === 'strength' ? 0.01 : 0} max="1" step="0.01" value={settings[key]} disabled={busy} onChange={e => { const value = Number(e.target.value); if (Number.isFinite(value) && value >= (key === 'strength' ? 0.01 : 0) && value <= 1) patch({ [key]: value }); }} /></div>
            <input className="guidance-slider" aria-label={`图生图 ${key === 'strength' ? 'Strength' : 'Noise'} 滑块`} type="range" min={key === 'strength' ? 0.01 : 0} max="1" step="0.01" value={settings[key]} disabled={busy} onChange={e => patch({ [key]: Number(e.target.value) })} />
          </div>)}
        </div>}
        <div className={`stage-content${(mode === 'img2img' && baseImage && showEditor) || (selected && (mode === 'generate' || !showEditor)) ? ' image-stage-content' : ''}`}>
          {mode === 'img2img' && baseImage && showEditor && <div className="reference-editor"><ImageViewport src={baseImage} alt="图生图 参考图" /><div className="reference-caption"><p>参考图</p><button className="secondary" disabled={busy || fitting} onClick={() => referenceFileRef.current?.click()}><Upload size={15} />更换参考图</button></div></div>}
          {mode === 'img2img' && !baseImage && <div className="empty-stage"><div className="empty-emblem"><ImagePlus size={47} strokeWidth={1} /></div><h1>参考 · 图生图</h1><button className="secondary empty-upload" onClick={() => referenceFileRef.current?.click()} disabled={busy}><Upload size={16} />上传参考图</button></div>}
          {mode === 'inpaint' && baseImage && <div className={`editor-container ${showEditor ? '' : 'hidden'}`}><MaskCanvas ref={maskRef} image={baseImage} width={resolution.width} height={resolution.height} disabled={busy || fitting} onChange={setHasMask} onViewResult={selected ? () => setShowEditor(false) : undefined} /></div>}
          {((mode === 'generate' && !selected) || (mode === 'inpaint' && !baseImage)) && <div className="empty-stage"><div className="empty-emblem"><Aperture size={47} strokeWidth={1} /><i /><i /></div><h1>{mode === 'inpaint' ? '局部重绘' : '文生图'}</h1>{mode === 'inpaint' && <button className="secondary empty-upload" onClick={() => fileRef.current?.click()} disabled={busy}><Upload size={16} />上传底图</button>}</div>}
          {selected && (mode === 'generate' || !showEditor) && <div className="result-container"><ImageViewport src={selectedUrl!} alt="当前生成结果"><button className="image-expand tool" title="全屏预览" aria-label="全屏预览" onClick={() => setFullscreen(true)}><Expand size={17} /></button></ImageViewport><div className="result-meta"><span><i className="dot pink" />{modeName(selected.mode)}<i className="meta-separator" />{RESOLUTIONS[selected.settings.resolution].width} × {RESOLUTIONS[selected.settings.resolution].height}</span><span>{selected.settings.steps} steps · CFG {selected.settings.guidance}</span></div></div>}
          {(busy || fitting) && <div className="working-overlay"><div><LoaderCircle className="spin" size={28} /><strong>{fitting ? '正在适配底图' : queuePosition > 0 ? busyText : mode === 'inpaint' ? '正在重绘选中区域' : '正在生成你的图像'}</strong></div></div>}
        </div>
        {selected && (mode === 'generate' || !showEditor) && <div className="result-controls"><div className="result-actions"><button className="secondary" disabled={busy} onClick={() => void useForInpaint(selected)}><Paintbrush size={15} />继续重绘</button><button className="secondary" disabled={busy} onClick={() => { restoreEntrySettings(selected); setNotice({ text: '已恢复这张图片的提示词和生成设置。', error: false }); }}><Copy size={15} />复制提示词</button><button className="secondary" disabled={busy} onClick={() => void useForInpaint(selected, 'img2img')}><ImagePlus size={15} />用作参考图</button></div>{mode === 'inpaint' && baseImage && <button className="text-button return-editor" onClick={() => setShowEditor(true)}>返回原蒙版编辑器<ArrowRight size={13} /></button>}{mode === 'img2img' && baseImage && <button className="text-button return-editor" onClick={() => setShowEditor(true)}>查看参考图<ArrowRight size={13} /></button>}</div>}
      </main>
      {!isMobile && <><aside className="settings-panel desktop-panel">{settingsPanel}</aside><aside className="history-panel desktop-panel">{historyPanel}</aside></>}
    </div>
    <nav className="mobile-nav">{isMobile && <PromptSheet open={mobilePanel === 'prompts'} hidden={mobilePanel !== null && mobilePanel !== 'prompts'} onOpen={() => setMobilePanel('prompts')} onClose={() => setMobilePanel(null)}>{promptPanel}</PromptSheet>}<button onClick={() => setMobilePanel('prompts')}><Layers size={19} />提示词</button><button onClick={() => setMobilePanel('settings')}><Settings2 size={19} />设置</button><button onClick={() => setMobilePanel('history')}><History size={19} />历史</button><button className="mobile-generate" disabled={!canGenerate} onClick={() => void generate()}>{busy ? <LoaderCircle className="spin" size={19} /> : <WandSparkles size={19} />}{busy && queuePosition > 0 ? `排队 ${queuePosition}` : '生成'}</button></nav>
    {mobilePanel && mobilePanel !== 'prompts' && <div className="mobile-backdrop" onClick={e => { if (e.target === e.currentTarget) setMobilePanel(null); }}><aside className={`mobile-drawer ${mobilePanel}-panel`}>{mobilePanel === 'settings' ? settingsPanel : historyPanel}</aside></div>}
    {notice && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <Info size={17} /> : <Check size={17} />}<span>{notice.text}</span><button className="tool" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={15} /></button></div>}
    {fullscreen && selectedUrl && <div className="fullscreen-view" role="dialog" aria-modal="true" aria-label="图片全屏预览" onClick={() => setFullscreen(false)}><button className="tool" aria-label="关闭全屏"><X size={24} /></button><ImageViewport src={selectedUrl} alt="生成结果全屏预览" fullscreen /></div>}
    {confirmClear && <div className="modal-backdrop"><section className="confirm-modal" role="dialog" aria-modal="true" aria-label="确认清空历史"><Trash2 size={25} /><h2>清空本地历史？</h2><p>将删除当前浏览器中的 {entries.length} 张图片。<br />请先下载需要保留的创作。</p><div className="modal-footer"><button className="secondary" onClick={() => setConfirmClear(false)}>取消</button><button className="danger-button" onClick={async () => { try { await clearHistory(storageOwner); setEntries([]); setSelectedId(''); setConfirmClear(false); } catch { setNotice({ text: '清空历史失败。', error: true }); } }}>清空历史</button></div></section></div>}
  </div>;
}
