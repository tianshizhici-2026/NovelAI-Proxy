export async function copyText(text: string) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Try the HTTP-compatible copy path. */ }
  }
  const previous = document.activeElement as HTMLElement | null;
  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.style.cssText = 'position:fixed;left:-9999px;top:0;font-size:16px;';
  document.body.appendChild(field);
  try {
    field.focus({ preventScroll: true }); field.select(); field.setSelectionRange(0, text.length);
    if (!document.execCommand('copy')) throw new Error('浏览器未允许复制，请长按提示词框手动复制。');
  } finally { field.remove(); previous?.focus({ preventScroll: true }); }
}
