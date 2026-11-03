import { useEffect, useRef, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';
export function Mark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="m12 10 7 6M36 10l-7 6" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
      <path
        d="M9 20a6 6 0 0 1 6-6h18a6 6 0 0 1 6 6v12a7 7 0 0 1-7 7H16a7 7 0 0 1-7-7V20Z"
        fill="currentColor"
      />
      <path d="M17 24h14M24 24v9" stroke="var(--rail)" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}
export function Avatar({
  user,
  size = 38,
  status,
  onClick,
}: {
  user: { username: string; avatar_asset_id?: string | null; accent_color?: string };
  size?: number;
  status?: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span
        className="avatar-img"
        style={{
          background: `linear-gradient(145deg,${user.accent_color ?? '#9b7aef'}80,${user.accent_color ?? '#9b7aef'}35)`,
        }}
      >
        {user.avatar_asset_id ? (
          <img src={`/api/media/${user.avatar_asset_id}`} alt="" />
        ) : (
          user.username.slice(0, 2).toUpperCase()
        )}
      </span>
      {status && <i className={`status-dot ${status}`} aria-label={status} />}
    </>
  );
  return onClick ? (
    <button
      className="avatar"
      style={{ width: size, height: size }}
      onClick={onClick}
      aria-label={`Perfil de ${user.username}`}
    >
      {content}
    </button>
  ) : (
    <span className="avatar" style={{ width: size, height: size }}>
      {content}
    </span>
  );
}
export function IconButton({
  label,
  children,
  onClick,
  active = false,
  className = '',
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${active ? 'active' : ''} ${className}`}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null),
    close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
      if (event.key === 'Tab') {
        const els = ref.current?.querySelectorAll<HTMLElement>(
          'button,input,select,textarea,[tabindex="0"]',
        );
        if (!els?.length) return;
        const first = els[0],
          last = els[els.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    ref.current?.querySelector<HTMLElement>('input,button')?.focus();
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? 'wide' : ''}`}
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.18 }}
      >
        <header>
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <IconButton label="Fechar" onClick={onClose}>
            <X size={20} />
          </IconButton>
        </header>
        {children}
      </motion.div>
    </div>
  );
}
export function ErrorText({ error }: { error: string }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}
export function Spinner() {
  return <span className="spinner" aria-label="Carregando" />;
}
