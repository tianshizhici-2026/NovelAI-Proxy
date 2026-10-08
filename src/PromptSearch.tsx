import { useId } from 'react';
import { Search } from 'lucide-react';

export default function PromptSearch({ label, query, onChange, count, error }: {
  label: string; query: string; onChange: (query: string) => void; count: number; error: string;
}) {
  const errorId = useId();
  return <div className="module-search">
    <label><Search size={14} /><input type="search" aria-label={label} aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
      value={query} maxLength={200} onChange={e => onChange(e.target.value)} placeholder="搜索名称或 tag · 支持正则" /><small>{count} 项</small></label>
    {error && <p id={errorId} className="module-search-error" role="alert">{error}</p>}
  </div>;
}
