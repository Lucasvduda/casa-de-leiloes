import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { cn } from './ui';

export type ToastKind = 'success' | 'info' | 'warning' | 'error';

interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

interface ToastApi {
  push: (kind: ToastKind, text: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const MAX_VISIBLE = 4;
const LIFETIME_MS = 6_000;

const STYLE: Record<ToastKind, string> = {
  success:
    'border-emerald-400 bg-emerald-50 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-100',
  info: 'border-sky-400 bg-sky-50 text-sky-950 dark:bg-sky-950 dark:text-sky-100',
  warning: 'border-amber-400 bg-amber-50 text-amber-950 dark:bg-amber-950 dark:text-amber-100',
  error: 'border-red-400 bg-red-50 text-red-950 dark:bg-red-950 dark:text-red-100',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, text: string) => {
      const id = nextId.current++;
      setItems((current) => [...current, { id, kind, text }].slice(-MAX_VISIBLE));
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), LIFETIME_MS),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) clearTimeout(timer);
      active.clear();
    };
  }, []);

  const api = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
        aria-live="polite"
      >
        {items.map((item) => (
          <div
            key={item.id}
            role={item.kind === 'error' ? 'alert' : 'status'}
            className={cn(
              'pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg',
              STYLE[item.kind],
            )}
          >
            <p className="flex-1">{item.text}</p>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              aria-label="Fechar aviso"
              className="-my-1 -mr-2 min-h-8 min-w-8 rounded text-lg leading-none opacity-70 hover:opacity-100"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (context === null) throw new Error('useToast fora do ToastProvider');
  return context;
}
