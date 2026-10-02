import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronUp } from 'lucide-react';

type Props = { open: boolean; hidden: boolean; onOpen: () => void; onClose: () => void; children: ReactNode };
type Drag = { id: number; y: number; height: number; fromPeek: boolean; started: number };

export default function PromptSheet({ open, hidden, onOpen, onClose, children }: Props) {
  const [viewportHeight, setViewportHeight] = useState(window.innerHeight);
  const [preview, setPreview] = useState<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const grip = useRef<HTMLButtonElement>(null);
  const peek = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const maximum = Math.max(160, viewportHeight);
  const height = preview ?? maximum;

  useEffect(() => {
    const resize = () => { setViewportHeight(window.innerHeight); drag.current = null; setPreview(null); };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (open) grip.current?.focus({ preventScroll: true });
    else {
      setPreview(null);
      if (wasOpen.current) peek.current?.focus({ preventScroll: true });
    }
    wasOpen.current = open;
  }, [open]);

  function start(event: PointerEvent<HTMLElement>, fromPeek: boolean) {
    if (!event.isPrimary || event.button !== 0 || hidden) return;
    const target = event.target as HTMLElement;
    if (!fromPeek && (!target.closest('.sheet-grip, .panel-heading') || target.closest('button:not(.sheet-grip), input, textarea, select, a'))) return;
    event.preventDefault();
    suppressClick.current = false;
    drag.current = { id: event.pointerId, y: event.clientY, height: fromPeek ? 0 : height, fromPeek, started: performance.now() };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLElement>) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const distance = current.y - event.clientY;
    if (Math.abs(distance) < 6 && preview === null) return;
    suppressClick.current = true;
    setPreview(Math.max(current.fromPeek ? 0 : 60, Math.min(maximum, current.height + distance)));
  }
  function finish(event: PointerEvent<HTMLElement>, cancelled = false) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    drag.current = null;
    const distance = current.y - event.clientY;
    const elapsed = Math.max(1, performance.now() - current.started);
    setPreview(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancelled || Math.abs(distance) < 6) return;
    if (current.fromPeek) {
      if (distance > 40 || (distance > 15 && distance / elapsed > 0.4)) {
        onOpen();
      }
    } else if (distance < -90 || (distance < -25 && -distance / elapsed > 0.65) || current.height + distance < maximum * 0.55) {
      onClose();
    }
  }
  function click(fromPeek: boolean) {
    if (suppressClick.current) { suppressClick.current = false; return; }
    if (fromPeek) onOpen();
  }
  const visible = open || (preview !== null && preview > 0);
  return <>
    <button ref={peek} className="prompt-sheet-peek" style={{ visibility: open || hidden ? 'hidden' : 'visible' }} aria-label="上滑展开提示词面板" aria-expanded={open} aria-controls="mobile-prompt-sheet" onPointerDown={event => start(event, true)} onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)} onClick={() => click(true)}><span />提示词<ChevronUp size={12} /></button>
    {visible && createPortal(<div className="mobile-backdrop prompt-sheet-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }} style={{ backgroundColor: preview !== null ? `color-mix(in srgb, var(--backdrop) ${Math.min(100, height / maximum * 100)}%, transparent)` : undefined }}>
      <aside id="mobile-prompt-sheet" className={`mobile-drawer prompt-panel prompt-sheet ${preview !== null ? 'sheet-dragging' : ''}`} style={{ height }} role="dialog" aria-modal="true" aria-label="创作提示词面板" onPointerDown={event => start(event, false)} onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}>
        <button ref={grip} type="button" className="sheet-grip" aria-label="拖动提示词面板：上滑展开，下拖收起" title="上滑展开 · 下拖收起" onClick={() => click(false)} onKeyDown={event => {
          if (event.key === 'ArrowUp') { event.preventDefault(); }
          if (event.key === 'ArrowDown' || event.key === 'Escape') { event.preventDefault(); onClose(); }
        }}><span /></button>
        {children}
      </aside>
    </div>, document.body)}
  </>;
}
