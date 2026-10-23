import { useId } from 'react';
import type { ComponentProps, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import type { LinkProps } from 'react-router-dom';

export const cn = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter(Boolean).join(' ');

// ---- Botoes -------------------------------------------------------------------------------

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-amber-500 text-stone-950 hover:bg-amber-400 disabled:hover:bg-amber-500 font-semibold shadow-sm',
  secondary:
    'border border-stone-300 bg-white text-stone-900 hover:bg-stone-100 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:hover:bg-stone-800',
  danger: 'bg-red-600 text-white hover:bg-red-500 disabled:hover:bg-red-600 font-semibold',
  ghost: 'text-stone-700 hover:bg-stone-200/70 dark:text-stone-300 dark:hover:bg-stone-800/70',
};

const BASE =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-55';

// React 19: `ref` e uma prop comum (ComponentProps inclui), sem forwardRef.
export interface ButtonProps extends ComponentProps<'button'> {
  variant?: Variant;
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cn(BASE, VARIANT[variant], className)}
      {...rest}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
}

export function ButtonLink({
  variant = 'primary',
  className,
  ...rest
}: LinkProps & { variant?: Variant }) {
  return <Link className={cn(BASE, VARIANT[variant], className)} {...rest} />;
}

// ---- Campos -------------------------------------------------------------------------------

const FIELD =
  'block w-full min-h-11 rounded-lg border bg-white px-3 py-2 text-base text-stone-900 placeholder:text-stone-400 dark:bg-stone-900 dark:text-stone-100 dark:placeholder:text-stone-500';

const fieldBorder = (invalid: boolean): string =>
  invalid
    ? 'border-red-500 focus:border-red-500'
    : 'border-stone-300 focus:border-amber-500 dark:border-stone-700';

interface FieldShellProps {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  className?: string;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

function FieldShell({ label, hint, error, className, children }: FieldShellProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint !== undefined ? hintId : null, error !== undefined ? errorId : null]
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {children({ id, describedBy, invalid: error !== undefined })}
      {hint !== undefined && (
        <p id={hintId} className="mt-1 text-xs text-stone-500 dark:text-stone-400">
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p
          id={errorId}
          role="alert"
          className="mt-1 text-sm font-medium text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}
    </div>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  className?: string;
}

export function TextField({ label, hint, error, className, ...input }: TextFieldProps) {
  return (
    <FieldShell
      label={label}
      hint={hint}
      error={error}
      {...(className !== undefined ? { className } : {})}
    >
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={cn(FIELD, fieldBorder(invalid))}
          {...input}
        />
      )}
    </FieldShell>
  );
}

export interface SelectFieldProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'className'
> {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  className?: string;
}

export function SelectField({
  label,
  hint,
  error,
  className,
  children,
  ...select
}: SelectFieldProps) {
  return (
    <FieldShell
      label={label}
      hint={hint}
      error={error}
      {...(className !== undefined ? { className } : {})}
    >
      {({ id, describedBy, invalid }) => (
        <select
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={cn(FIELD, fieldBorder(invalid))}
          {...select}
        >
          {children}
        </select>
      )}
    </FieldShell>
  );
}

// ---- Blocos -------------------------------------------------------------------------------

export function Card({
  className,
  children,
  as: Tag = 'div',
}: {
  className?: string;
  children: ReactNode;
  as?: 'div' | 'section' | 'article' | 'li';
}) {
  return (
    <Tag
      className={cn(
        'rounded-xl border border-stone-200 bg-white p-4 shadow-sm dark:border-stone-800 dark:bg-stone-900',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const TONE: Record<Tone, string> = {
  neutral: 'bg-stone-200 text-stone-800 dark:bg-stone-800 dark:text-stone-200',
  success: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
  warning: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
  danger: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-300',
  info: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-300',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('animate-spin', className ?? 'size-5')}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
      <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

const ALERT: Record<Exclude<Tone, 'neutral'>, string> = {
  success:
    'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200',
  warning:
    'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200',
  danger:
    'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/60 dark:text-red-200',
  info: 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-200',
};

export function Alert({
  tone = 'info',
  title,
  children,
  className,
  live = tone === 'danger' ? 'assertive' : 'polite',
}: {
  tone?: Exclude<Tone, 'neutral'>;
  title?: string;
  children?: ReactNode;
  className?: string;
  live?: 'assertive' | 'polite';
}) {
  return (
    <div
      role={live === 'assertive' ? 'alert' : 'status'}
      className={cn('rounded-lg border px-4 py-3 text-sm', ALERT[tone], className)}
    >
      {title !== undefined && <p className="font-semibold">{title}</p>}
      {children !== undefined && (
        <div className={title !== undefined ? 'mt-1' : undefined}>{children}</div>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-stone-300 px-6 py-12 text-center dark:border-stone-700">
      <p className="text-lg font-semibold">{title}</p>
      {children !== undefined && (
        <div className="mx-auto mt-2 max-w-md text-sm text-stone-600 dark:text-stone-400">
          {children}
        </div>
      )}
      {action !== undefined && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/** Erro de carregamento com botao de tentar de novo (nunca tela em branco). */
export function LoadError({
  message,
  onRetry,
  retrying = false,
}: {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <Alert tone="danger" title="Não foi possível carregar">
      <p>{message}</p>
      {onRetry !== undefined && (
        <Button variant="secondary" className="mt-3" onClick={onRetry} loading={retrying}>
          Tentar de novo
        </Button>
      )}
    </Alert>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-lg bg-stone-200 dark:bg-stone-800', className)}
    />
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-serif text-2xl font-bold sm:text-3xl">{title}</h1>
        {subtitle !== undefined && (
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">{subtitle}</p>
        )}
      </div>
      {actions !== undefined && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <nav aria-label="Paginação" className="mt-6 flex items-center justify-center gap-3">
      <Button variant="secondary" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Anterior
      </Button>
      <span className="tabular text-sm" aria-current="page">
        Página {page} de {totalPages}
      </span>
      <Button variant="secondary" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
        Próxima
      </Button>
    </nav>
  );
}
