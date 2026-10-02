import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';

type Point = { x: number; y: number };
type View = Point & { scale: number };
type Gesture = { view: View; center: Point; distance?: number };

export default function ImageViewport({ src, alt, children, fullscreen = false }: { src: string; alt: string; children?: ReactNode; fullscreen?: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const fitted = useRef(size);
  const current = useRef(view);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const dragged = useRef(false);

  function update(next: View) {
    const root = viewport.current, image = picture.current;
    if (!root || !image) return;
    const scale = Math.min(6, Math.max(0.5, next.scale));
    const maxX = Math.max(0, (fitted.current.width * scale - root.clientWidth) / 2);
    const maxY = Math.max(0, (fitted.current.height * scale - root.clientHeight) / 2);
    const value = { scale, x: Math.min(maxX, Math.max(-maxX, next.x)), y: Math.min(maxY, Math.max(-maxY, next.y)) };
    if (value.scale === current.current.scale && value.x === current.current.x && value.y === current.current.y) return;
    current.current = value; setView(value);
  }
  function reset() { update({ scale: 1, x: 0, y: 0 }); }
  function resize() {
    const root = viewport.current, image = picture.current;
    if (!root || !image?.naturalWidth || !root.clientWidth || !root.clientHeight) return;
    const ratio = Math.min(root.clientWidth / image.naturalWidth, root.clientHeight / image.naturalHeight);
    const next = { width: image.naturalWidth * ratio, height: image.naturalHeight * ratio };
    fitted.current = next;
    setSize(previous => previous.width === next.width && previous.height === next.height ? previous : next);
    update(current.current);
  }
  function center(point: Point) {
    const bounds = viewport.current!.getBoundingClientRect();
    return { x: point.x - bounds.left - bounds.width / 2, y: point.y - bounds.top - bounds.height / 2 };
  }
  function zoom(scale: number, anchor: Point) {
    const before = current.current;
    const next = Math.min(6, Math.max(0.5, scale)), ratio = next / before.scale;
    update({ scale: next, x: anchor.x - (anchor.x - before.x) * ratio, y: anchor.y - (anchor.y - before.y) * ratio });
  }
  function beginGesture() {
    const [first, second] = [...pointers.current.values()];
    if (!first) { gesture.current = null; return; }
    gesture.current = second ? {
      view: { ...current.current },
      center: center({ x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }),
      distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
    } : { view: { ...current.current }, center: center(first) };
  }
  function down(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, a, input') || pointers.current.size >= 2) return;
    if (!pointers.current.size) dragged.current = false;
    // Keep the native image context menu and long-press save action.
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    beginGesture();
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const [first, second] = [...pointers.current.values()], initial = gesture.current;
    const nextCenter = center(second ? { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 } : first);
    if (second || Math.hypot(nextCenter.x - initial.center.x, nextCenter.y - initial.center.y) > 6) dragged.current = true;
    const scale = second && initial.distance ? Math.min(6, Math.max(0.5, initial.view.scale * Math.hypot(first.x - second.x, first.y - second.y) / initial.distance)) : initial.view.scale;
    const ratio = scale / initial.view.scale;
    update({ scale, x: nextCenter.x - (initial.center.x - initial.view.x) * ratio, y: nextCenter.y - (initial.center.y - initial.view.y) * ratio });
  }
  function up(event: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.delete(event.pointerId)) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    beginGesture();
  }
  useEffect(() => {
    pointers.current.clear(); gesture.current = null; dragged.current = false; resize(); reset();
  }, [src]);
  useEffect(() => {
    const root = viewport.current!;
    const observer = new ResizeObserver(resize);
    observer.observe(root); resize();
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('button, a, input')) return;
      event.preventDefault();
      zoom(current.current.scale * Math.exp(-event.deltaY * 0.002), center({ x: event.clientX, y: event.clientY }));
    };
    root.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); root.removeEventListener('wheel', wheel); };
  }, []);

  return <div ref={viewport} className={`result-image image-viewport${fullscreen ? ' fullscreen-image' : ''}`} role="group" aria-label={`${alt}缩放区域`} data-scale={view.scale} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up} onClick={event => event.stopPropagation()} onClickCapture={event => {
    if (dragged.current && !(event.target as HTMLElement).closest('button')) { event.preventDefault(); event.stopPropagation(); dragged.current = false; }
  }} onDoubleClick={event => { if (!(event.target as HTMLElement).closest('button')) { event.preventDefault(); reset(); } }}>
    <img ref={picture} src={src} alt={alt} draggable={false} onLoad={resize} style={{ width: size.width, height: size.height, visibility: size.width ? 'visible' : 'hidden', transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} />
    {children}
  </div>;
}
