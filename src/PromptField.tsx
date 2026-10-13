import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

type Props = {
  id: string;
  label: string;
  subtitle: string;
  value: string;
  onChange: (value: string) => void;
  collapsible?: boolean;
  disabled?: boolean;
  placeholder?: string;
  help?: ReactNode;
};

export default function PromptField({ id, label, subtitle, value, onChange, collapsible, disabled, placeholder = '', help }: Props) {
  const heading = <><span className="prompt-field-title">{collapsible && <ChevronRight size={13} />}{label}</span><span>{subtitle}</span></>;
  const content = <>
    <div className="prompt-editor"><textarea id={id} aria-label={label} maxLength={12000} rows={7} placeholder={placeholder} value={value} disabled={disabled} onChange={e => onChange(e.target.value)} /><div className="editor-footer"><span /><span>{value.length.toLocaleString()} 字符</span></div></div>
    {help}
  </>;
  return collapsible
    ? <details className="prompt-field global-negative"><summary className="prompt-label">{heading}</summary>{content}</details>
    : <div className="prompt-field"><div className="prompt-label"><label htmlFor={id}>{label}</label><span>{subtitle}</span></div>{content}</div>;
}
