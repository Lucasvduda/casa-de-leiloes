import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Role } from '../../api/types';
import { Alert, Button, Card, TextField, cn } from '../../components/ui';
import { fieldErrors, messageForError } from '../../lib/messages';
import { useDocumentTitle } from '../../lib/use-document-title';
import { safeNextPath, useSession } from './session';
import { validateRegister } from './validation';
import type { RegisterErrors } from './validation';

const ROLES: { value: Role; title: string; text: string }[] = [
  { value: 'bidder', title: 'Quero dar lances', text: 'Compre itens em leilões ao vivo.' },
  { value: 'seller', title: 'Quero leiloar', text: 'Crie lotes a partir do catálogo do museu.' },
];

export function RegisterPage() {
  useDocumentTitle('Criar conta');
  const { register } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next');

  const [role, setRole] = useState<Role>('bidder');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<RegisterErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    setFormError(null);
    const found = validateRegister({ displayName, email, password });
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    inFlight.current = true;
    setSubmitting(true);
    try {
      const user = await register({
        role,
        displayName: displayName.trim(),
        email: email.trim(),
        password,
      });
      const fallback = user.role === 'seller' ? '/painel' : '/carteira';
      navigate(next === null ? fallback : safeNextPath(next), { replace: true });
    } catch (error) {
      const server = fieldErrors(error);
      const mapped: RegisterErrors = {};
      if (server.email !== undefined) mapped.email = server.email;
      if (server.password !== undefined) mapped.password = server.password;
      if (server.displayName !== undefined) mapped.displayName = server.displayName;
      setErrors(mapped);
      // Erro de campo ja aparece ao lado do campo; so o que nao e de campo vai para o aviso geral.
      if (Object.keys(mapped).length === 0) setFormError(messageForError(error));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-6 text-center font-serif text-3xl font-bold">Criar conta</h1>
      <Card>
        <form onSubmit={(e) => void onSubmit(e)} noValidate className="space-y-4">
          {formError !== null && <Alert tone="danger">{formError}</Alert>}

          <fieldset>
            <legend className="mb-2 text-sm font-medium">Como você quer participar?</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {ROLES.map((option) => (
                <label
                  key={option.value}
                  className={cn(
                    'cursor-pointer rounded-lg border p-3 text-sm has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-amber-500',
                    role === option.value
                      ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/40'
                      : 'border-stone-300 dark:border-stone-700',
                  )}
                >
                  <input
                    type="radio"
                    name="role"
                    value={option.value}
                    checked={role === option.value}
                    onChange={() => setRole(option.value)}
                    className="sr-only"
                  />
                  <span className="block font-semibold">{option.title}</span>
                  <span className="mt-0.5 block text-xs text-stone-600 dark:text-stone-400">
                    {option.text}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <TextField
            label="Nome"
            name="displayName"
            autoComplete="name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            error={errors.displayName}
            hint="Aparece para o leiloeiro e nos comprovantes."
          />
          <TextField
            label="E-mail"
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={errors.email}
          />
          <div>
            <TextField
              label="Senha"
              type={showPassword ? 'text' : 'password'}
              name="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={errors.password}
              hint="Pelo menos 8 caracteres. Evite senhas óbvias."
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
            Criar conta
          </Button>
        </form>
        <p className="mt-4 text-center text-sm">
          Já tem conta?{' '}
          <Link
            to={next === null ? '/entrar' : `/entrar?next=${encodeURIComponent(next)}`}
            className="font-semibold text-amber-700 underline dark:text-amber-400"
          >
            Entrar
          </Link>
        </p>
      </Card>
    </div>
  );
}
