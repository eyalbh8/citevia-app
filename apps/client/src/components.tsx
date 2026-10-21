import { useEffect, useRef, type ReactNode } from 'react';
import { AlertCircle, ArrowUpRight, ChevronLeft, ChevronRight, FileSearch, LogIn, X } from 'lucide-react';
import { ApiError } from './api';
import { signIn } from './auth';

export function Logo() { return <div className="brand" aria-label="Citevia"><span className="brand-logo-frame"><img src="/citevia-mark.png" alt="" /></span><span>Citevia</span></div>; }
export function ErrorNotice({ error, retry }: { error?: Error | string; retry?: () => void }) {
  if (!error) return null;
  const expired = error instanceof ApiError && error.status === 401;
  return <div className="error-box" role="alert"><AlertCircle size={17} /><span>{typeof error === 'string' ? error : error.message}</span>{expired ? <button className="button button-outline" onClick={() => void signIn()}><LogIn size={13} />Sign in</button> : retry && <button className="button button-outline" onClick={retry}>Try again</button>}</div>;
}
export function Empty({ title, description, children }: { title: string; description: string; children?: ReactNode }) { return <div className="empty-state"><span className="empty-icon"><FileSearch size={23} /></span><h3>{title}</h3><p>{description}</p>{children}</div>; }
export function Badge({ value, label }: { value: string; label?: string }) { return <span className={`tag ${value.startsWith('failed') ? 'failed' : value}`}>{label || labelize(value)}</span>; }
export function labelize(value: string) { return value === 'not_applicable' ? 'Not mentioned' : value.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()); }
export function formatDate(date?: string | null, full = false) { if (!date) return '—'; const value = new Date(date); return Number.isNaN(value.getTime()) ? '—' : value.toLocaleDateString('en', { month: 'short', day: 'numeric', ...(full ? { year: 'numeric' } : {}) }); }
export function formatNumber(value?: number | null, digits = 0) { return value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en', { maximumFractionDigits: digits, minimumFractionDigits: digits }); }
export function percent(value?: number | null) { return value == null ? '—' : `${formatNumber(value, 0)}%`; }
export function safeUrl(url: string): string | undefined { try { const parsed = new URL(url); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : undefined; } catch { return undefined; } }
export function ExternalLink({ url, children }: { url: string; children: ReactNode }) { const href = safeUrl(url); return href ? <a href={href} target="_blank" rel="noreferrer noopener">{children}<ArrowUpRight size={11} /></a> : <span>{children}</span>; }
export function Pagination({ page, total, size, onChange }: { page: number; total: number; size: number; onChange: (page: number) => void }) {
  const pages = Math.ceil(total / size);
  const visiblePages = pages <= 7 ? Array.from({ length: pages }, (_, index) => index) : [...new Set([0, ...[page - 1, page, page + 1].filter(index => index > 0 && index < pages - 1), pages - 1])];
  return <div className="pagination"><span>{total ? `${page * size + 1}–${Math.min((page + 1) * size, total)} of ${total}` : 'No results'}</span><nav className="page-buttons" aria-label="Pagination"><button aria-label="Previous page" disabled={page === 0} onClick={() => onChange(page - 1)}><ChevronLeft size={15} /></button>{visiblePages.map((index, position) => <span className="page-number-group" key={index}>{position > 0 && index - visiblePages[position - 1] > 1 && <span className="pagination-gap" aria-hidden="true">…</span>}<button className={index === page ? 'active' : ''} aria-label={`Page ${index + 1}`} aria-current={index === page ? 'page' : undefined} onClick={() => onChange(index)}>{index + 1}</button></span>)}<button aria-label="Next page" disabled={page + 1 >= pages} onClick={() => onChange(page + 1)}><ChevronRight size={15} /></button></nav></div>;
}
export function Drawer({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const elements = ref.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]');
        if (!elements?.length) { event.preventDefault(); return; }
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', handleKey); previous?.focus(); };
  }, []);
  return <div className="overlay" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={ref} tabIndex={-1} className={`drawer${wide ? ' drawer-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><div className="drawer-header"><h2>{title}</h2><button className="icon-button" aria-label="Close details" onClick={onClose}><X size={20} /></button></div><div className="drawer-body">{children}</div></section></div>;
}
