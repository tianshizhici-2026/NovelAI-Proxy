import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type PointerEvent } from 'react';
import { Brush, Eraser, Trash2, Undo2, Redo2, Square, FlipHorizontal, Eye, EyeOff, Move, ZoomIn, ZoomOut, Scan, Pipette, Image as ImageIcon, Upload } from 'lucide-react';

export type MaskHandle = { exportMask: () => string; exportImage: () => string };
type Props = { image: string; width: number; height: number; disabled: boolean; onChange: (hasMask: boolean) => void; allowMask?: boolean; onViewResult?: () => void; onReplaceImage?: () => void };
type Layer = 'mask' | 'paint';
type Point = { x: number; y: number };
type View = Point & { scale: number };
type Gesture = { kind: 'pan'; start: Point; view: View } | { kind: 'pinch'; center: Point; distance: number; view: View };
export default forwardRef<MaskHandle, Props>(function MaskCanvas({ image, width, height, disabled, onChange, allowMask = true, onViewResult, onReplaceImage }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const paintCanvas = useRef<HTMLCanvasElement>(null);
  const base = useRef<HTMLImageElement>(null);
  const [layer, setLayer] = useState<Layer>(allowMask ? 'mask' : 'paint');
  const [color, setColor] = useState('#c89b75');
  const [paintOpacity, setPaintOpacity] = useState(1);
  const activeLayer = allowMask ? layer : 'paint';
  const activeCanvas = () => activeLayer === 'paint' ? paintCanvas.current! : canvas.current!;
  const editor = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [artboardWidth, setArtboardWidth] = useState(300);
  const [viewportHeight, setViewportHeight] = useState(300);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef<View>(view);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const drawingPointer = useRef<number | null>(null);
  const history = useRef<Record<Layer, ImageData[]>>({ mask: [], paint: [] });
  const cursor = useRef<Record<Layer, number>>({ mask: 0, paint: 0 });
  const drawing = useRef(false);
  const start = useRef({ x: 0, y: 0 });
  const previous = useRef({ x: 0, y: 0 });
  const snapshot = useRef<ImageData | null>(null);
  const [tool, setTool] = useState<'brush' | 'eraser' | 'rectangle' | 'pan' | 'picker'>('brush');
  const [size, setSize] = useState(48);
  const [opacity, setOpacity] = useState(0.48);
  const [visible, setVisible] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => { setLayer(allowMask ? 'mask' : 'paint'); setTool('brush'); }, [allowMask]);
  useEffect(() => {
    const stage = editor.current!.closest<HTMLElement>('.stage-content');
    const resize = () => {
      const root = editor.current;
      if (!root || !root.isConnected) return;
      const stageStyle = stage && getComputedStyle(stage);
      const padding = stageStyle ? parseFloat(stageStyle.paddingTop) + parseFloat(stageStyle.paddingBottom) : 48;
      const controls = ['.mask-controls', '.mask-footer']
        .reduce((sum, selector) => sum + (root.querySelector(selector)?.getBoundingClientRect().height ?? 0), 0);
      const gaps = (parseFloat(getComputedStyle(root).rowGap) || 0) * (root.children.length - 1);
      const availableHeight = Math.max(150, (stage?.clientHeight ?? window.innerHeight - 200) - padding - controls - gaps);
      setArtboardWidth(Math.min(root.clientWidth, availableHeight * width / height));
      setViewportHeight(availableHeight);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(editor.current!);
    if (stage) observer.observe(stage);
    for (const selector of ['.mask-controls', '.mask-footer']) observer.observe(editor.current!.querySelector(selector)!);
    window.addEventListener('resize', resize); resize();
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, [width, height]);

  function updateView(next: View) {
    const scale = Math.max(0.5, Math.min(6, next.scale));
    const maxX = Math.max(0, (artboardWidth * scale - (viewport.current?.clientWidth ?? artboardWidth)) / 2);
    const maxY = Math.max(0, (artboardWidth * height / width * scale - viewportHeight) / 2);
    const updated = { scale, x: Math.max(-maxX, Math.min(maxX, next.x)), y: Math.max(-maxY, Math.min(maxY, next.y)) };
    viewRef.current = updated; setView(updated);
  }
  function resetView() { updateView({ scale: 1, x: 0, y: 0 }); }
  function zoom(scale: number, anchor: Point = { x: 0, y: 0 }) {
    const current = viewRef.current;
    const next = Math.max(0.5, Math.min(6, scale));
    const ratio = next / current.scale;
    updateView({ scale: next, x: anchor.x - (anchor.x - current.x) * ratio, y: anchor.y - (anchor.y - current.y) * ratio });
  }
  useEffect(() => { updateView(viewRef.current); }, [artboardWidth, viewportHeight]);
  useEffect(() => {
    const element = viewport.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (disabled || drawing.current || pointers.current.size) return;
      const rect = element.getBoundingClientRect();
      zoom(viewRef.current.scale * Math.exp(-event.deltaY * 0.002), { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  });

  function changed() {
    const data = canvas.current!.getContext('2d')!.getImageData(0, 0, width, height).data;
    let hasMask = false;
    for (let y = 4; y < height && !hasMask; y += 8) for (let x = 4; x < width; x += 8)
      if (data[(y * width + x) * 4 + 3] > 155) { hasMask = true; break; }
    onChange(hasMask); setVersion(v => v + 1);
  }
  function save() {
    const data = activeCanvas().getContext('2d')!.getImageData(0, 0, width, height);
    const limit = Math.max(2, Math.min(13, Math.floor(32 * 1024 * 1024 / (width * height * 4))));
    history.current[activeLayer] = [...history.current[activeLayer].slice(0, cursor.current[activeLayer] + 1), data].slice(-limit);
    cursor.current[activeLayer] = history.current[activeLayer].length - 1;
    changed();
  }
  function restore(direction: number) {
    if (drawing.current || disabled) return;
    const next = cursor.current[activeLayer] + direction;
    if (next < 0 || next >= history.current[activeLayer].length) return;
    cursor.current[activeLayer] = next;
    activeCanvas().getContext('2d')!.putImageData(history.current[activeLayer][next], 0, 0);
    changed();
  }
  useEffect(() => {
    for (const [name, element] of [['mask', canvas.current!], ['paint', paintCanvas.current!]] as const) {
      const ctx = element.getContext('2d')!;
      ctx.clearRect(0, 0, width, height);
      history.current[name] = [ctx.getImageData(0, 0, width, height)];
      cursor.current[name] = 0;
    }
    drawing.current = false; setPaintOpacity(1);
    pointers.current.clear(); gesture.current = null; drawingPointer.current = null;
    viewRef.current = { scale: 1, x: 0, y: 0 }; setView(viewRef.current);
    onChange(false); setVersion(v => v + 1);
  // onChange is a stable state setter from the parent.
  }, [image, width, height, onChange]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (target.closest('input,textarea,select') || disabled) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); restore(event.shiftKey ? 1 : -1);
      }
      if (event.key.toLowerCase() === 'b') setTool('brush');
      if (event.key.toLowerCase() === 'e') setTool('eraser');
      if (event.key.toLowerCase() === 'c') { setLayer('paint'); setTool('picker'); }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  function compositedImage() {
    if (!base.current?.complete || !base.current.naturalWidth) return null;
    const result = document.createElement('canvas');
    result.width = width; result.height = height;
    const ctx = result.getContext('2d')!;
    ctx.drawImage(base.current, 0, 0, width, height);
    ctx.globalAlpha = paintOpacity;
    ctx.drawImage(paintCanvas.current!, 0, 0);
    return result;
  }
  useImperativeHandle(ref, () => ({
    exportImage() { return compositedImage()?.toDataURL('image/png') ?? image; },
    exportMask() {
      const ctx = canvas.current!.getContext('2d')!;
      const data = ctx.getImageData(0, 0, width, height);
      for (let i = 0; i < data.data.length; i += 4) {
        const value = data.data[i + 3];
        data.data[i] = value; data.data[i + 1] = value; data.data[i + 2] = value; data.data[i + 3] = 255;
      }
      const result = document.createElement('canvas');
      result.width = width; result.height = height;
      result.getContext('2d')!.putImageData(data, 0, 0);
      return result.toDataURL('image/png');
    },
  }), [image, width, height, paintOpacity]);
  function point(event: PointerEvent<HTMLDivElement>) {
    const rect = paintCanvas.current!.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * width / rect.width, y: (event.clientY - rect.top) * height / rect.height };
  }
  function stroke(from: { x: number; y: number }, to: { x: number; y: number }) {
    const ctx = activeCanvas().getContext('2d')!;
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = activeLayer === 'paint' ? color : '#3b82f6'; ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = size;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
    ctx.beginPath(); ctx.arc(to.x, to.y, size / 2, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
  function pinchGeometry() {
    const [a, b] = [...pointers.current.values()];
    const rect = viewport.current!.getBoundingClientRect();
    return { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), center: { x: (a.x + b.x) / 2 - rect.left - rect.width / 2, y: (a.y + b.y) / 2 - rect.top - rect.height / 2 } };
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (disabled || ![0, 1].includes(event.button) || pointers.current.size >= 2) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      // A second finger starts navigation; undo the tentative first-finger mark.
      if (drawing.current && snapshot.current) activeCanvas().getContext('2d')!.putImageData(snapshot.current, 0, 0);
      drawing.current = false; drawingPointer.current = null;
      gesture.current = { kind: 'pinch', ...pinchGeometry(), view: { ...viewRef.current } };
      return;
    }
    if (tool === 'pan' || event.button === 1) {
      gesture.current = { kind: 'pan', start: { x: event.clientX, y: event.clientY }, view: { ...viewRef.current } };
      return;
    }
    const pos = point(event);
    if (pos.x < 0 || pos.x > width || pos.y < 0 || pos.y > height) return;
    if (!base.current?.complete || !base.current.naturalWidth) return;
    if (tool === 'picker' || event.ctrlKey || event.metaKey) {
      const rgb = compositedImage()!.getContext('2d')!.getImageData(Math.min(width - 1, Math.floor(pos.x)), Math.min(height - 1, Math.floor(pos.y)), 1, 1).data;
      setColor('#' + Array.from(rgb.slice(0, 3), n => n.toString(16).padStart(2, '0')).join(''));
      setLayer('paint'); setTool('brush'); return;
    }
    drawingPointer.current = event.pointerId; gesture.current = null;
    drawing.current = true; setVisible(true);
    start.current = pos; previous.current = pos;
    snapshot.current = activeCanvas().getContext('2d')!.getImageData(0, 0, width, height);
    if (tool !== 'rectangle') stroke(pos, pos);
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const active = gesture.current;
    if (active?.kind === 'pinch' && pointers.current.size === 2) {
      const current = pinchGeometry();
      const scale = Math.max(0.5, Math.min(6, active.view.scale * current.distance / active.distance));
      const ratio = scale / active.view.scale;
      updateView({ scale, x: current.center.x - (active.center.x - active.view.x) * ratio, y: current.center.y - (active.center.y - active.view.y) * ratio });
      return;
    }
    if (active?.kind === 'pan') {
      updateView({ ...active.view, x: active.view.x + event.clientX - active.start.x, y: active.view.y + event.clientY - active.start.y });
      return;
    }
    if (!drawing.current || drawingPointer.current !== event.pointerId) return;
    const pos = point(event);
    if (tool === 'rectangle') {
      const ctx = activeCanvas().getContext('2d')!;
      ctx.putImageData(snapshot.current!, 0, 0); ctx.fillStyle = activeLayer === 'paint' ? color : '#3b82f6';
      ctx.fillRect(start.current.x, start.current.y, pos.x - start.current.x, pos.y - start.current.y);
    } else stroke(previous.current, pos);
    previous.current = pos;
  }
  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    if (drawing.current && drawingPointer.current === event.pointerId) {
      drawing.current = false; drawingPointer.current = null;
      if (event.type === 'pointercancel' && snapshot.current) activeCanvas().getContext('2d')!.putImageData(snapshot.current, 0, 0);
      else save();
    }
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (pointers.current.size === 1) {
      // Remaining finger continues panning rather than accidentally painting.
      gesture.current = { kind: 'pan', start: [...pointers.current.values()][0], view: { ...viewRef.current } };
    } else gesture.current = null;
  }
  function clear() { activeCanvas().getContext('2d')!.clearRect(0, 0, width, height); save(); }
  function invert() {
    const ctx = canvas.current!.getContext('2d')!;
    const data = ctx.getImageData(0, 0, width, height);
    for (let i = 0; i < data.data.length; i += 4) {
      data.data[i] = 59; data.data[i + 1] = 130; data.data[i + 2] = 246;
      data.data[i + 3] = data.data[i + 3] > 127 ? 0 : 255;
    }
    ctx.putImageData(data, 0, 0); save();
  }
  return <div className="mask-editor" ref={editor} data-version={version}>
    <div className="mask-controls">
      <div className="paint-layer-controls">
        {allowMask && <div className="paint-layer-tabs" role="group" aria-label="编辑图层"><button className={activeLayer === 'mask' ? 'active' : ''} aria-pressed={activeLayer === 'mask'} disabled={disabled} onClick={() => { setLayer('mask'); setTool('brush'); }}>蒙版</button><button className={activeLayer === 'paint' ? 'active' : ''} aria-pressed={activeLayer === 'paint'} disabled={disabled} onClick={() => { setLayer('paint'); setTool('brush'); }}>涂色</button></div>}
        {activeLayer === 'paint' && <><label className="paint-color-control">颜色<input aria-label="涂色颜色" type="color" value={color} disabled={disabled} onChange={e => setColor(e.target.value)} /></label><button className={tool === 'picker' ? 'tool active' : 'tool'} title="取色 (C / Ctrl+点击)" aria-label="取色" disabled={disabled} onClick={() => setTool('picker')}><Pipette size={17} /></button></>}
        <small>{activeLayer === 'mask' ? '蓝色区域将被重绘' : allowMask ? '涂色后切回蒙版，选中修改区域' : '涂改后的底图用于图生图'}</small>
      </div>
      <div className="mask-toolbar" role="toolbar" aria-label="蒙版工具">
        <span className="mask-heading">{activeLayer === 'mask' ? '蒙版编辑器' : '底图涂色'}</span>
        <button title="画笔 (B)" aria-label="画笔" className={tool === 'brush' ? 'tool active' : 'tool'} onClick={() => setTool('brush')} disabled={disabled}><Brush size={17} /></button>
        <button title="橡皮 (E)" aria-label="橡皮" className={tool === 'eraser' ? 'tool active' : 'tool'} onClick={() => setTool('eraser')} disabled={disabled}><Eraser size={17} /></button>
        <button title={activeLayer === 'mask' ? '矩形蒙版' : '矩形涂色'} aria-label={activeLayer === 'mask' ? '矩形蒙版' : '矩形涂色'} className={tool === 'rectangle' ? 'tool active' : 'tool'} onClick={() => setTool('rectangle')} disabled={disabled}><Square size={16} /></button>
        <button title={activeLayer === 'mask' ? '清空蒙版' : '清空涂色'} aria-label={activeLayer === 'mask' ? '清空蒙版' : '清空涂色'} className="tool clear-mask" onClick={clear} disabled={disabled}><Trash2 size={17} /></button>
        <button className="tool" title="撤销 (Ctrl+Z)" aria-label="撤销" disabled={disabled || cursor.current[activeLayer] === 0} onClick={() => restore(-1)}><Undo2 size={17} /></button>
        <button className="tool" title="重做 (Ctrl+Shift+Z)" aria-label="重做" disabled={disabled || cursor.current[activeLayer] >= history.current[activeLayer].length - 1} onClick={() => restore(1)}><Redo2 size={17} /></button>
        {activeLayer === 'mask' && <button className="tool" title="反转蒙版" aria-label="反转蒙版" disabled={disabled} onClick={invert}><FlipHorizontal size={16} /></button>}
        {onReplaceImage && <button className="tool" title="更换参考图" aria-label="更换参考图" disabled={disabled} onClick={onReplaceImage}><Upload size={16} /></button>}
        {onViewResult && <button className="tool" title="查看结果" aria-label="查看结果" onClick={onViewResult}><ImageIcon size={17} /></button>}
      </div>
      <label className="brush-control">笔刷 <input aria-label="笔刷大小" type="range" min="4" max="200" value={size} onChange={e => setSize(Number(e.target.value))} disabled={disabled} /><span>{size}px</span></label>
    </div>
    <div className="mask-viewport" ref={viewport} style={{ height: viewportHeight, cursor: disabled ? 'wait' : tool === 'pan' ? 'grab' : 'crosshair' }}
      aria-label="重绘画布视口" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onLostPointerCapture={pointerUp}>
      <div className="mask-artboard" style={{ aspectRatio: `${width}/${height}`, width: artboardWidth, height: artboardWidth * height / width, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        <img ref={base} src={image} alt={allowMask ? '局部重绘底图' : '图生图 参考图'} draggable={false} />
        <canvas ref={paintCanvas} width={width} height={height} style={{ opacity: paintOpacity }} aria-label="底图涂色画布" />
        <canvas ref={canvas} width={width} height={height} style={{ opacity: allowMask && activeLayer === 'mask' && visible ? opacity : 0 }} aria-label="重绘蒙版画布" />
      </div>
    </div>
    <div className="mask-footer">
      <div className="mask-navigation">
        <button title="移动画布" aria-label="移动画布" className={tool === 'pan' ? 'tool active pan-control' : 'tool pan-control'} onClick={() => setTool(t => t === 'pan' ? 'brush' : 'pan')} disabled={disabled}><Move size={17} /></button>
        <div className="zoom-controls">
          <button className="tool" title="缩小画布" aria-label="缩小画布" disabled={disabled || view.scale <= 0.5} onClick={() => zoom(viewRef.current.scale / 1.25)}><ZoomOut size={17} /></button>
          <output aria-label="画布缩放比例">{Math.round(view.scale * 100)}%</output>
          <button className="tool" title="放大画布" aria-label="放大画布" disabled={disabled || view.scale >= 6} onClick={() => zoom(viewRef.current.scale * 1.25)}><ZoomIn size={17} /></button>
          <button className="tool" title="适应画布" aria-label="适应画布" disabled={disabled} onClick={resetView}><Scan size={17} /></button>
        </div>
      </div>
      <label>透明度 <input aria-label={activeLayer === 'mask' ? '蒙版透明度' : '涂色透明度'} type="range" min={activeLayer === 'mask' ? '0.15' : '0.05'} max={activeLayer === 'mask' ? '0.8' : '1'} step="0.05" value={activeLayer === 'mask' ? opacity : paintOpacity} disabled={disabled} onChange={e => activeLayer === 'mask' ? setOpacity(Number(e.target.value)) : setPaintOpacity(Number(e.target.value))} /></label>
      {activeLayer === 'mask' && <button className="tool" title={visible ? '隐藏蒙版' : '显示蒙版'} aria-label="显示或隐藏蒙版" onClick={() => setVisible(v => !v)}>{visible ? <Eye size={16} /> : <EyeOff size={16} />}</button>}
    </div>
  </div>;
});
