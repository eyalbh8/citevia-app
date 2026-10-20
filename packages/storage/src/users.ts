import {
  verifiedIdentitySchema,
  type Page,
  type User,
  type UserAccount,
  type VerifiedIdentity,
} from '@citevia/core';
import { uuidFor, type SqlDatabase, type SqlSession } from './sql.js';

export class AccessError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface UserRepository {
  syncUser(identity: VerifiedIdentity, seen?: boolean): Promise<User>;
  getUser(subject: string): Promise<User | null>;
  getUserById(id: string): Promise<User | null>;
  listUsers(options: {
    offset: number;
    limit: number;
    query?: string;
  }): Promise<Page<User>>;
  listUserAccounts(id: string): Promise<UserAccount[]>;
  updateUserAccess(
    actor: string,
    id: string,
    version: number,
    input: { isSystemAdmin?: boolean; disabled?: boolean },
  ): Promise<User>;
  setUserAccount(
    actor: string,
    id: string,
    projectId: string,
    role: 'owner' | 'viewer' | null,
    version: number,
  ): Promise<User>;
  bootstrapAdmin(id: string): Promise<User>;
}
const selectUser = `SELECT u.*, i.subject, i.external_user_id, i.disabled, i.access_version, i.last_seen_at FROM users u JOIN citevia_identities i ON i.user_id=u.id WHERE i.provider='descope'`;
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : String(value);
const fromRow = (r: Record<string, unknown>): User => ({
  id: String(r.id),
  subject: String(r.subject),
  descopeUserId: String(r.external_user_id),
  email: String(r.email),
  name: r.name as string | null,
  lastName: r.last_name as string | null,
  isSystemAdmin: Boolean(r.is_system_admin),
  disabled: Boolean(r.disabled),
  version: Number(r.access_version),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  lastSeenAt: r.last_seen_at ? iso(r.last_seen_at) : null,
});

export class PostgresUsers implements UserRepository {
  constructor(readonly db: SqlDatabase) {}
  async getUser(subject: string) {
    return this.find(this.db, 'i.subject', subject);
  }
  async getUserById(id: string) {
    return this.find(this.db, 'u.id', id);
  }
  private async find(
    tx: SqlSession,
    column: 'i.subject' | 'u.id',
    value: string,
  ) {
    const { rows } = await tx.query(`${selectUser} AND ${column}=$1`, [value]);
    return rows[0] ? fromRow(rows[0]) : null;
  }
  async syncUser(value: VerifiedIdentity, seen = false): Promise<User> {
    const identity = verifiedIdentitySchema.parse(value);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `identity:${identity.subject}`,
      ]);
      let user = await this.find(tx, 'i.subject', identity.subject);
      if (!user) {
        const id = uuidFor(`user:${identity.subject}`);
        try {
          await tx.query(
            `INSERT INTO users(id,email,name,last_name,updated_at) VALUES($1,$2,$3,$4,now())`,
            [id, identity.email, identity.name, identity.lastName],
          );
          await tx.query(
            `INSERT INTO citevia_identities(subject,user_id,provider,external_user_id,last_seen_at) VALUES($1,$2,'descope',$3,$4)`,
            [
              identity.subject,
              id,
              identity.externalUserId,
              seen ? new Date().toISOString() : null,
            ],
          );
        } catch (error) {
          if ((error as { code?: string }).code === '23505')
            throw new AccessError(
              409,
              'IDENTITY_CONFLICT',
              'This identity or email is already linked to another user. Ask a system administrator to review it.',
            );
          throw error;
        }
      } else {
        if (user.descopeUserId !== identity.externalUserId)
          throw new AccessError(
            409,
            'IDENTITY_CONFLICT',
            'The identity does not match this user.',
          );
        try {
          if (
            user.email !== identity.email ||
            user.name !== identity.name ||
            user.lastName !== identity.lastName
          )
            await tx.query(
              'UPDATE users SET email=$2,name=$3,last_name=$4,updated_at=now() WHERE id=$1',
              [user.id, identity.email, identity.name, identity.lastName],
            );
        } catch (error) {
          if ((error as { code?: string }).code === '23505')
            throw new AccessError(
              409,
              'IDENTITY_CONFLICT',
              'This email is already linked to another identity.',
            );
          throw error;
        }
        if (
          seen &&
          (!user.lastSeenAt ||
            Date.now() - Date.parse(user.lastSeenAt) > 60_000)
        )
          await tx.query(
            'UPDATE citevia_identities SET last_seen_at=now() WHERE subject=$1',
            [identity.subject],
          );
      }
      return (await this.find(tx, 'i.subject', identity.subject))!;
    });
  }
  async listUsers(options: {
    offset: number;
    limit: number;
    query?: string;
  }): Promise<Page<User>> {
    const filter = ` AND ($1='' OR u.email ILIKE '%'||$1||'%' OR coalesce(u.name,'') ILIKE '%'||$1||'%')`;
    const total = Number(
      (
        await this.db.query(
          `SELECT count(*)::int AS total FROM (${selectUser}${filter}) x`,
          [options.query || ''],
        )
      ).rows[0].total,
    );
    const { rows } = await this.db.query(
      `${selectUser}${filter} ORDER BY u.created_at DESC,u.id LIMIT $2 OFFSET $3`,
      [options.query || '', options.limit, options.offset],
    );
    return {
      items: rows.map(fromRow),
      total,
      nextCursor:
        options.offset + options.limit < total
          ? Buffer.from(String(options.offset + options.limit)).toString(
              'base64url',
            )
          : null,
    };
  }
  async listUserAccounts(id: string): Promise<UserAccount[]> {
    const { rows } = await this.db.query(
      `SELECT p.id,a.title,ua.roles FROM user_accounts ua JOIN citevia_projects p ON p.account_id=ua.account_id JOIN accounts a ON a.id=p.account_id WHERE ua.user_id=$1 ORDER BY a.title,p.id`,
      [id],
    );
    return rows.map((r) => ({
      projectId: String(r.id),
      projectName: String(r.title),
      role: (r.roles as string[]).includes('OWNER') ? 'owner' : 'viewer',
    }));
  }
  private async administration<T>(
    actor: string,
    id: string,
    version: number,
    work: (tx: SqlSession, target: User) => Promise<T>,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtext('citevia:administration'))",
      );
      const current = await this.find(tx, 'i.subject', actor),
        target = await this.find(tx, 'u.id', id);
      if (!current?.isSystemAdmin || current.disabled)
        throw new AccessError(
          403,
          'FORBIDDEN',
          'System administrator access is required.',
        );
      if (!target)
        throw new AccessError(404, 'USER_NOT_FOUND', 'User not found');
      if (target.version !== version)
        throw new AccessError(
          409,
          'VERSION_CONFLICT',
          'User access changed. Refresh before saving.',
        );
      return work(tx, target);
    });
  }
  async updateUserAccess(
    actor: string,
    id: string,
    version: number,
    input: { isSystemAdmin?: boolean; disabled?: boolean },
  ) {
    return this.administration(actor, id, version, async (tx, target) => {
      const admin = input.isSystemAdmin ?? target.isSystemAdmin,
        disabled = input.disabled ?? target.disabled;
      if (target.subject === actor && (!admin || disabled))
        throw new AccessError(
          409,
          'SELF_LOCKOUT',
          'Another administrator must change your administrator access.',
        );
      if (target.isSystemAdmin && !target.disabled && (!admin || disabled)) {
        const count = Number(
          (
            await tx.query(
              `SELECT count(*)::int AS count FROM users u JOIN citevia_identities i ON i.user_id=u.id WHERE i.provider='descope' AND u.is_system_admin AND NOT i.disabled`,
            )
          ).rows[0].count,
        );
        if (count <= 1)
          throw new AccessError(
            409,
            'LAST_ADMIN',
            'Keep at least one enabled system administrator.',
          );
      }
      await tx.query(
        'UPDATE users SET is_system_admin=$2,updated_at=now() WHERE id=$1',
        [id, admin],
      );
      await tx.query(
        'UPDATE citevia_identities SET disabled=$2,access_version=access_version+1 WHERE user_id=$1',
        [id, disabled],
      );
      return (await this.find(tx, 'u.id', id))!;
    });
  }
  async setUserAccount(
    actor: string,
    id: string,
    projectId: string,
    role: 'owner' | 'viewer' | null,
    version: number,
  ) {
    return this.administration(actor, id, version, async (tx, target) => {
      const project = await tx.query(
        'SELECT account_id FROM citevia_projects WHERE id=$1',
        [projectId],
      );
      if (!project.rows[0])
        throw new AccessError(404, 'NOT_FOUND', 'Account not found');
      if (role)
        await tx.query(
          `INSERT INTO user_accounts(id,user_id,account_id,roles,updated_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(user_id,account_id) DO UPDATE SET roles=excluded.roles,updated_at=now()`,
          [
            uuidFor(`${projectId}:member:${target.subject}`),
            id,
            project.rows[0].account_id,
            [role === 'owner' ? 'OWNER' : 'VIEWER'],
          ],
        );
      else
        await tx.query(
          'DELETE FROM user_accounts WHERE user_id=$1 AND account_id=$2',
          [id, project.rows[0].account_id],
        );
      await tx.query(
        'UPDATE citevia_identities SET access_version=access_version+1 WHERE user_id=$1',
        [id],
      );
      return (await this.find(tx, 'u.id', id))!;
    });
  }
  async bootstrapAdmin(id: string): Promise<User> {
    return this.db.transaction(async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtext('citevia:administration'))",
      );
      const target = await this.find(tx, 'u.id', id);
      if (!target || target.disabled)
        throw new AccessError(
          404,
          'USER_NOT_FOUND',
          'Sign in through Descope first, then use the saved database user ID.',
        );
      const admins = await tx.query(
        `SELECT u.id FROM users u JOIN citevia_identities i ON i.user_id=u.id WHERE i.provider='descope' AND u.is_system_admin AND NOT i.disabled`,
      );
      if (admins.rows.length) {
        if (admins.rows.length === 1 && admins.rows[0].id === id) return target;
        throw new AccessError(
          409,
          'BOOTSTRAP_CLOSED',
          'A system administrator already exists. Manage further access in Users.',
        );
      }
      await tx.query(
        'UPDATE users SET is_system_admin=true,updated_at=now() WHERE id=$1',
        [id],
      );
      await tx.query(
        'UPDATE citevia_identities SET access_version=access_version+1 WHERE user_id=$1',
        [id],
      );
      return (await this.find(tx, 'u.id', id))!;
    });
  }
}
