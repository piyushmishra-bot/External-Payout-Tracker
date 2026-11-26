import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ratingBucket, type PayoutStatus } from '@eh/core';
import { ICONS, type IconName } from './icons';

export function Icon({ name, size = 20, className, label }: { name: IconName; size?: number; className?: string; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      {ICONS[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

/**
 * Same ISIN and date already saved: pick one option (radio), then Continue. Cancel goes back without saving.
 */
export function DupeChoices({ many, busy, onReplace, onKeep, onCancel, track }: { many: boolean; busy?: boolean; onReplace: () => void; onKeep: () => void; onCancel: () => void; track: string }) {
  const [pick, setPick] = useState<'replace' | 'keep' | null>(null);
  const opt = (k: 'replace' | 'keep', title: string, text: string) => (
    <button type="button" role="radio" aria-checked={pick === k} className={`dupe-opt ${pick === k ? 'on' : ''}`} onClick={() => setPick(k)} data-track={`${track}_pick_${k}`}>
      <span className="dupe-radio" aria-hidden="true" />
      <span className="dupe-t">
        <b>{title}</b>
        <span>{text}</span>
      </span>
    </button>
  );
  return (
    <>
      <div className="dupe-opts" role="radiogroup" aria-label="What would you like to do?">
        {opt('replace', 'Replace existing details', `Update ${many ? 'these bonds' : 'this bond'} with the new details. The earlier details will be removed.`)}
        {opt('keep', 'Keep both', `Add the new details as ${many ? 'separate entries' : 'a separate entry'}. The earlier details stay as they are.`)}
      </div>
      <div className="modal-actions">
        <button className="btn btn-outline" disabled={busy} onClick={onCancel} data-track={`${track}_dupe_cancel`}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={busy || !pick} onClick={() => (pick === 'replace' ? onReplace() : onKeep())} data-track={`${track}_${pick === 'replace' ? 'replace' : 'keep_both'}`}>
          {busy ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </>
  );
}

/** Phosphor icons (regular weight, MIT), the set BondScanner uses on its platform. */
const PH = {
  'plus-circle':
    'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm48-88a8,8,0,0,1-8,8H136v32a8,8,0,0,1-16,0V136H88a8,8,0,0,1,0-16h32V88a8,8,0,0,1,16,0v32h32A8,8,0,0,1,176,128Z',
  eye: 'M247.31,124.76c-.35-.79-8.82-19.58-27.65-38.41C194.57,61.26,162.88,48,128,48S61.43,61.26,36.34,86.35C17.51,105.18,9,124,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208s66.57-13.26,91.66-38.34c18.83-18.83,27.3-37.61,27.65-38.4A8,8,0,0,0,247.31,124.76ZM128,192c-30.78,0-57.67-11.19-79.93-33.25A133.47,133.47,0,0,1,25,128,133.33,133.33,0,0,1,48.07,97.25C70.33,75.19,97.22,64,128,64s57.67,11.19,79.93,33.25A133.46,133.46,0,0,1,231.05,128C223.84,141.46,192.43,192,128,192Zm0-112a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Z',
  'eye-closed': 'M228,175a8,8,0,0,1-10.92-3l-19-33.2A123.23,123.23,0,0,1,162,155.46l5.87,35.22a8,8,0,0,1-6.58,9.21A8.4,8.4,0,0,1,160,200a8,8,0,0,1-7.88-6.69l-5.77-34.58a133.06,133.06,0,0,1-36.68,0l-5.77,34.58A8,8,0,0,1,96,200a8.4,8.4,0,0,1-1.32-.11,8,8,0,0,1-6.58-9.21L94,155.46a123.23,123.23,0,0,1-36.06-16.69L39,172A8,8,0,1,1,25.06,164l20-35a153.47,153.47,0,0,1-19.3-20A8,8,0,1,1,38.22,99c16.6,20.54,45.64,45,89.78,45s73.18-24.49,89.78-45A8,8,0,1,1,230.22,109a153.47,153.47,0,0,1-19.3,20l20,35A8,8,0,0,1,228,175Z',
  table:
    'M224,48H32a8,8,0,0,0-8,8V192a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A8,8,0,0,0,224,48ZM40,112H80v32H40Zm56,0H216v32H96ZM216,64V96H40V64ZM40,160H80v32H40Zm176,32H96V160H216v32Z',
  plus: 'M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z',
  'pencil-simple':
    'M227.31,73.37,182.63,28.68a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96a16,16,0,0,0,0-22.63ZM92.69,208H48V163.31l88-88L180.69,120ZM192,108.68,147.31,64l24.68-24.69,44.69,44.68Z',
} as const;
export function PhIcon({ name, size = 24 }: { name: keyof typeof PH; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d={PH[name]} />
    </svg>
  );
}

/** Official BondScanner compass mark (from the design system assets). */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" style={{ color: 'var(--brand)' }}>
      <path d="M 23.563 25.832 C 23.325 25.594 22.952 25.556 22.675 25.746 C 20.666 27.126 18.212 27.903 15.575 27.81 C 9.396 27.592 4.388 22.571 4.188 16.39 C 3.968 9.566 9.566 3.968 16.39 4.188 C 22.571 4.388 27.592 9.396 27.81 15.575 C 27.903 18.211 27.127 20.666 25.746 22.675 C 25.556 22.952 25.594 23.325 25.832 23.563 L 28.391 26.123 C 30.647 23.365 32 19.841 32 16 C 32 7.163 24.837 0 16 0 C 7.163 0 0 7.163 0 16 C 0 24.837 7.164 32 16 32 C 19.841 32 23.365 30.646 26.123 28.391 L 23.563 25.832 Z" fill="currentColor" />
      <path transform="translate(7.389 7.391)" d="M 17.21 8.205 C 17.007 3.788 13.431 0.212 9.014 0.009 C 3.948 -0.224 -0.224 3.948 0.009 9.014 C 0.213 13.431 3.789 17.007 8.206 17.209 C 13.271 17.442 17.443 13.27 17.21 8.205 Z M 12.394 8.747 C 9.877 9.274 9.275 9.876 8.748 12.393 C 8.717 12.542 8.505 12.542 8.473 12.393 C 7.946 9.876 7.345 9.274 4.828 8.747 C 4.678 8.715 4.678 8.504 4.828 8.472 C 7.345 7.945 7.946 7.344 8.473 4.827 C 8.505 4.677 8.717 4.677 8.748 4.827 C 9.275 7.344 9.877 7.945 12.394 8.472 C 12.543 8.504 12.543 8.715 12.394 8.747 Z" fill="currentColor" />
    </svg>
  );
}

const RATING_DOT: Record<string, string> = { AAA: '#1C398E', AA: '#3B82F6', A: '#FFFF33', BBB: '#C68E17', 'Below BBB': '#E7000B', Unrated: '#99A1AF' };
export function Rating({ value }: { value?: string }) {
  const b = ratingBucket(value);
  return (
    <span className="rating">
      {value || 'NR'}
      <i aria-hidden="true" style={{ background: RATING_DOT[b], boxShadow: b === 'A' ? 'inset 0 0 0 1px #d4c400' : undefined }} />
    </span>
  );
}

export const STATUS_BADGE: Record<PayoutStatus, { cls: string; label: string }> = {
  upcoming: { cls: 'b-info', label: 'Upcoming' },
  due_today: { cls: 'b-warning', label: 'Due today' },
  awaiting_credit: { cls: 'b-warning', label: 'Awaiting credit' },
  not_marked: { cls: 'b-error', label: 'Not marked received' },
  received: { cls: 'b-success', label: 'Received' },
};
export function StatusBadge({ status }: { status: PayoutStatus }) {
  const s = STATUS_BADGE[status];
  return <span className={`badge ${s.cls}`}>{s.label}</span>;
}

export function Sheet({ onClose, children, label, className }: { onClose: () => void; children: ReactNode; label: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // Focus the first field to fill in; otherwise the pop-up itself (no focus ring on the close button).
    (ref.current?.querySelector<HTMLElement>('input:not([readonly]):not([type=hidden]), select, textarea') ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      prev?.focus?.();
    };
  }, [onClose]);
  // Rendered at the end of <body> so the overlay always covers the whole window.
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sheet ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={label} ref={ref} tabIndex={-1}>
        <div className="grab" />
        <button className="sheet-x" onClick={onClose} aria-label="Close" data-track="popup_close">
          <Icon name="close-line" size={20} />
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Artwork at the top of a pop-up, as on bondscanner.com: a light-blue folder with a small badge. */
export function ModalArt({ kind }: { kind: 'delete' | 'replace' | 'done' | 'upload' }) {
  const badge =
    kind === 'delete'
      ? { icon: 'delete-bin-line' as IconName, color: '#E7000B' }
      : kind === 'replace'
      ? { icon: 'refresh-line' as IconName, color: 'var(--brand)' }
      : kind === 'upload'
      ? { icon: 'upload-cloud-2-line' as IconName, color: '#fff', solid: true }
      : { icon: 'check-line' as IconName, color: 'var(--success)' };
  return (
    <span className="modal-art" aria-hidden="true">
      <svg width="64" height="52" viewBox="0 0 64 52" fill="none">
        <path d="M4 8a6 6 0 0 1 6-6h14l6 6h24a6 6 0 0 1 6 6v28a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6V8Z" fill="#93C5FD" />
        <path d="M2 18a6 6 0 0 1 6-6h48a6 6 0 0 1 6 6v24a6 6 0 0 1-6 6H8a6 6 0 0 1-6-6V18Z" fill="#BFDBFE" />
        <path d="M2 18a6 6 0 0 1 6-6h48a6 6 0 0 1 6 6v3H2v-3Z" fill="#DBEAFE" />
      </svg>
      <span className={`modal-badge ${'solid' in badge ? 'solid' : ''}`} style={{ color: badge.color }}>
        <Icon name={badge.icon} size={16} />
      </span>
    </span>
  );
}

/** Confirmation pop-up as on bondscanner.com: artwork, centred title and text, Cancel and the action side by side. */
export function Confirm({
  title,
  body,
  confirm,
  cancel = 'Cancel',
  art = 'delete',
  track = 'confirm',
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirm: string;
  cancel?: string;
  art?: 'delete' | 'replace' | 'done';
  /** Click ids: <track>_cancel and <track>_confirm. */
  track?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet onClose={onClose} label={title}>
      <div className="modal-head">
        <ModalArt kind={art} />
        <h3 className="modal-title">{title}</h3>
        <p className="modal-text">{body}</p>
      </div>
      <div className="modal-actions">
        <button className="btn btn-outline" onClick={onClose} disabled={busy} data-track={`${track}_cancel`}>
          {cancel}
        </button>
        <button className="btn btn-primary" onClick={onConfirm} disabled={busy} data-track={`${track}_confirm`}>
          {busy ? 'Please wait…' : confirm}
        </button>
      </div>
    </Sheet>
  );
}

export function Stepper({ value, onChange, min = 1, label }: { value: number | undefined; onChange: (n: number) => void; min?: number; label: string }) {
  const [text, setText] = useState(value ? String(value) : '');
  useEffect(() => setText(value ? String(value) : ''), [value]);
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} onClick={() => onChange(Math.max(min, (value ?? min) - 1))}>
        <Icon name="subtract-line" size={18} />
      </button>
      <input
        inputMode="numeric"
        aria-label={label}
        value={text}
        placeholder="–"
        onChange={(e) => {
          const v = e.target.value.replace(/[^\d]/g, '');
          setText(v);
          if (Number(v) >= min) onChange(Number(v));
        }}
      />
      <button type="button" aria-label={`More ${label.toLowerCase()}`} onClick={() => onChange((value ?? 0) + 1)}>
        <Icon name="add-line" size={18} />
      </button>
    </div>
  );
}

/** Notification as on bondscanner.com: white card at the top right, green tick, message, close. */
export function Toast({ message, onClose }: { message: string; onClose?: () => void }) {
  return (
    <div className="toast" role="status" aria-live="polite">
      <Icon name="checkbox-circle-line" size={20} className="toast-ic" />
      <span className="toast-msg">{message}</span>
      {onClose && (
        <button className="toast-x" onClick={onClose} aria-label="Close">
          <Icon name="close-line" size={16} />
        </button>
      )}
    </div>
  );
}

export function Skeleton({ h = 16, w = '100%', r }: { h?: number; w?: number | string; r?: number }) {
  return <div className="skeleton" style={{ height: h, width: w, borderRadius: r }} />;
}

export function initialsOf(name: string) {
  return name
    .replace(/\b(Ltd|Limited|Pvt|of|and|the)\b\.?/gi, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

/** Animated number for the success screen. Respects reduced motion. */
export function useCountUp(target: number, ms = 1200) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return setV(target);
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      setV(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}
