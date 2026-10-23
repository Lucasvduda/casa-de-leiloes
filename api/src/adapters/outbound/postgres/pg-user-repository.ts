import { ConflictError } from '../../../application/errors.js';
import type { Role, StoredUser, UserRepository } from '../../../application/ports.js';
import type { Queryable } from './pool.js';

const UNIQUE_VIOLATION = '23505';

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role: Role;
  created_at: Date;
}

export const USER_COLUMNS = 'id, email, display_name, password_hash, role, created_at';

export function mapUser(row: UserRow): StoredUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    role: row.role,
    createdAt: row.created_at,
  };
}

export class PgUserRepository implements UserRepository {
  constructor(private readonly db: Queryable) {}

  async insert(user: StoredUser): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO users (id, email, display_name, password_hash, role, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [user.id, user.email, user.displayName, user.passwordHash, user.role, user.createdAt],
      );
    } catch (error) {
      // Duas inscricoes simultaneas com o mesmo e-mail: o indice unico decide, sem 500.
      const e = error as { code?: string; constraint?: string };
      if (e.code === UNIQUE_VIOLATION && e.constraint === 'users_email_lower_key') {
        throw new ConflictError('EMAIL_TAKEN', 'Ja existe uma conta com este e-mail.');
      }
      throw error;
    }
  }

  async findByEmail(email: string): Promise<StoredUser | null> {
    const { rows } = await this.db.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    return rows[0] === undefined ? null : mapUser(rows[0]);
  }

  async findById(id: string): Promise<StoredUser | null> {
    const { rows } = await this.db.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
      [id],
    );
    return rows[0] === undefined ? null : mapUser(rows[0]);
  }
}
