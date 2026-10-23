import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, TextField } from '../../components/ui';
import { DEMO_ACCOUNTS, DEMO_PASSWORD, SHOW_DEMO_HINT } from '../../lib/demo';
import { messageForError } from '../../lib/messages';
import { useDocumentTitle } from '../../lib/use-document-title';
import { homeFor, safeNextPath, useSession } from './session';
import { validateLogin } from './validation';
import type { LoginErrors } from './validation';

export function LoginPage() {
  useDocumentTitle('Entrar');
  const { login } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<LoginErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Impede duplo envio no mesmo tick (o estado so atualiza no proximo render).
  const inFlight = useRef(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    setFormError(null);
    const found = validateLogin({ email, password });
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    inFlight.current = true;
    setSubmitting(true);
    try {
      const user = await login({ email: email.trim(), password });
      navigate(next === null ? homeFor(user) : safeNextPath(next), { replace: true });
    } catch (error) {
      setFormError(messageForError(error));
      setPassword('');
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-6 text-center font-serif text-3xl font-bold">Entrar</h1>
      <Card>
        <form onSubmit={(e) => void onSubmit(e)} noValidate className="space-y-4">
          {formError !== null && <Alert tone="danger">{formError}</Alert>}
          <TextField
            label="E-mail"
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={errors.email}
            autoFocus
          />
          <div>
            <TextField
              label="Senha"
              type={showPassword ? 'text' : 'password'}
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={errors.password}
            />
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={showPassword}
                onChange={(e) => setShowPassword(e.target.checked)}
                className="size-4"
              />
              Mostrar senha
            </label>
          </div>
          <Button type="submit" className="w-full" loading={submitting}>
            Entrar
          </Button>
        </form>
        <p className="mt-4 text-center text-sm">
          Ainda não tem conta?{' '}
          <Link
            to={next === null ? '/cadastro' : `/cadastro?next=${encodeURIComponent(next)}`}
            className="font-semibold text-amber-700 underline dark:text-amber-400"
          >
            Criar conta
          </Link>
        </p>
      </Card>

      {SHOW_DEMO_HINT && (
        <Card className="mt-6">
          <h2 className="font-semibold">Contas de demonstração</h2>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
            Para avaliar sem cadastro. A senha é pública de propósito (dinheiro fictício).
          </p>
          <ul className="mt-3 space-y-2">
            {DEMO_ACCOUNTS.map((account) => (
              <li key={account.email} className="flex items-center justify-between gap-2">
                <span className="text-sm">
                  <span className="font-medium">{account.label}</span>
                  <span className="block text-xs text-stone-500 dark:text-stone-400">
                    {account.email}
                  </span>
                </span>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setEmail(account.email);
                    setPassword(DEMO_PASSWORD);
                    setErrors({});
                    setFormError(null);
                  }}
                >
                  Preencher
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
