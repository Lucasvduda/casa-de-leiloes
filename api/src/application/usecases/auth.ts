import { AuthenticationError, ConflictError } from '../errors.js';
import type {
  Actor,
  Clock,
  IdGenerator,
  PasswordHasher,
  Role,
  StoredUser,
  UnitOfWork,
} from '../ports.js';
import {
  hashSessionToken,
  isWellFormedSessionToken,
  newCsrfToken,
  newSessionToken,
} from '../session-token.js';
import { loginSchema, parseWith, registerSchema } from '../validation.js';

export interface AuthUserView {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
}

export interface AuthResult {
  readonly user: AuthUserView;
  /** Valor do cookie de sessao. Aparece UMA vez, aqui; no banco so existe o hash. */
  readonly token: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
}

export interface ResolvedSession {
  readonly user: AuthUserView;
  readonly actor: Actor;
  readonly csrfToken: string;
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS_PER_USER = 10;

const toView = (user: StoredUser): AuthUserView => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  role: user.role,
});

export interface AuthDeps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly hasher: PasswordHasher;
  readonly sessionTtlMs?: number;
}

export class AuthService {
  private readonly ttl: number;
  /** Hash descartavel para gastar o mesmo tempo quando o e-mail nao existe (anti enumeracao por tempo). */
  private dummyHash: Promise<string> | null = null;

  constructor(private readonly deps: AuthDeps) {
    this.ttl = deps.sessionTtlMs ?? SESSION_TTL_MS;
  }

  async register(input: unknown): Promise<AuthResult> {
    const data = parseWith(registerSchema, input);
    const { uow, clock, ids, hasher } = this.deps;
    // O hash e caro: feito FORA da transacao para nao segurar conexao do pool.
    const passwordHash = await hasher.hash(data.password);
    const now = clock.now();
    const user: StoredUser = {
      id: ids.uuid(),
      email: data.email,
      displayName: data.displayName,
      passwordHash,
      role: data.role,
      createdAt: now,
    };

    return uow.run(async (repos) => {
      if ((await repos.users.findByEmail(user.email)) !== null) {
        throw new ConflictError('EMAIL_TAKEN', 'Ja existe uma conta com este e-mail.');
      }
      await repos.users.insert(user);
      await repos.wallets.lock(user.id); // cria a carteira zerada junto com a conta
      return this.openSession(repos, user, now);
    });
  }

  async login(input: unknown): Promise<AuthResult> {
    const data = parseWith(loginSchema, input);
    const { uow, clock, hasher } = this.deps;

    const user = await uow.readSnapshot((repos) => repos.users.findByEmail(data.email));
    const reference = user?.passwordHash ?? (await this.getDummyHash());
    const passwordOk = await hasher.verify(reference, data.password);
    if (user === null || !passwordOk) {
      // Mesma resposta e mesmo custo para "e-mail inexistente" e "senha errada".
      throw new AuthenticationError('INVALID_CREDENTIALS', 'E-mail ou senha incorretos.');
    }

    const now = clock.now();
    return uow.run((repos) => this.openSession(repos, user, now));
  }

  /** Encerra a sessao no servidor (o cookie sozinho nao basta: o token roubado seguiria valendo). */
  async logout(token: unknown): Promise<void> {
    if (!isWellFormedSessionToken(token)) return;
    await this.deps.uow.run((repos) => repos.sessions.delete(hashSessionToken(token)));
  }

  async resolve(token: unknown): Promise<ResolvedSession | null> {
    if (!isWellFormedSessionToken(token)) return null;
    const found = await this.deps.uow.readSnapshot((repos) =>
      repos.sessions.findValid(hashSessionToken(token), this.deps.clock.now()),
    );
    if (found === null) return null;
    return {
      user: toView(found.user),
      actor: { id: found.user.id, role: found.user.role },
      csrfToken: found.session.csrfToken,
    };
  }

  purgeExpired(): Promise<number> {
    return this.deps.uow.run((repos) => repos.sessions.deleteExpired(this.deps.clock.now()));
  }

  private async openSession(
    repos: Parameters<Parameters<UnitOfWork['run']>[0]>[0],
    user: StoredUser,
    now: Date,
  ): Promise<AuthResult> {
    // Token novo a cada login (sem sessao pre-login, entao nao ha fixacao de sessao).
    const token = newSessionToken();
    const csrfToken = newCsrfToken();
    const expiresAt = new Date(now.getTime() + this.ttl);
    await repos.sessions.insert({
      idHash: hashSessionToken(token),
      userId: user.id,
      csrfToken,
      createdAt: now,
      expiresAt,
    });
    await repos.sessions.trimToNewest(user.id, MAX_SESSIONS_PER_USER);
    return { user: toView(user), token, csrfToken, expiresAt };
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.deps.hasher.hash('senha-descartavel-para-igualar-o-tempo');
    return this.dummyHash;
  }
}
