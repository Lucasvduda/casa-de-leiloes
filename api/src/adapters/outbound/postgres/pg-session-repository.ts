import type { SessionRepository, StoredSession, StoredUser } from '../../../application/ports.js';
import { mapUser } from './pg-user-repository.js';
import type { UserRow } from './pg-user-repository.js';
import type { Queryable } from './pool.js';

interface SessionRow extends UserRow {
  s_id_hash: string;
  s_user_id: string;
  s_csrf_token: string;
  s_created_at: Date;
  s_expires_at: Date;
}

export class PgSessionRepository implements SessionRepository {
  constructor(private readonly db: Queryable) {}

  async insert(session: StoredSession): Promise<void> {
    await this.db.query(
      `INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [session.idHash, session.userId, session.csrfToken, session.createdAt, session.expiresAt],
    );
  }

  async findValid(
    idHash: string,
    now: Date,
  ): Promise<{ session: StoredSession; user: StoredUser } | null> {
    const { rows } = await this.db.query<SessionRow>(
      `SELECT s.id_hash AS s_id_hash, s.user_id AS s_user_id, s.csrf_token AS s_csrf_token,
              s.created_at AS s_created_at, s.expires_at AS s_expires_at,
              u.id, u.email, u.display_name, u.password_hash, u.role, u.created_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id_hash = $1 AND s.expires_at > $2`,
      [idHash, now],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      session: {
        idHash: row.s_id_hash,
        userId: row.s_user_id,
        csrfToken: row.s_csrf_token,
        createdAt: row.s_created_at,
        expiresAt: row.s_expires_at,
      },
      user: mapUser(row),
    };
  }

  async delete(idHash: string): Promise<void> {
    await this.db.query(`DELETE FROM sessions WHERE id_hash = $1`, [idHash]);
  }

  async trimToNewest(userId: string, keep: number): Promise<void> {
    await this.db.query(
      `DELETE FROM sessions
        WHERE user_id = $1
          AND id_hash NOT IN (
            SELECT id_hash FROM sessions WHERE user_id = $1 ORDER BY created_at DESC, id_hash LIMIT $2)`,
      [userId, keep],
    );
  }

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.db.query(`DELETE FROM sessions WHERE expires_at <= $1`, [now]);
    return result.rowCount ?? 0;
  }
}
