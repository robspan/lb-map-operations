import { Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { randomBytes, createHash } from 'node:crypto';
import { OpsPrincipal, OpsRole } from '@lb-map-operations/ops-contract';
import { OpsConfigService } from '../config/ops-config.service';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { hashPassword, verifyPassword } from './passwords';

export interface OpsUserRecord {
  readonly id: string;
  readonly username: string;
  readonly display_name: string;
  readonly email: string | null;
  readonly role: OpsRole;
  readonly active: boolean;
  readonly must_change_password: boolean;
}

export interface UserSummary {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email?: string;
  readonly role: OpsRole;
  readonly active: boolean;
  readonly mustChangePassword: boolean;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly audit: AuditService,
    private readonly config: OpsConfigService,
    private readonly db: DatabaseService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.db.enabled()) {
      return;
    }
    await this.bootstrapFirstUser();
  }

  async authenticate(username: string, password: string): Promise<OpsPrincipal | null> {
    const result = await this.db.query<OpsUserRecord & { password_hash: string }>(
      `
        SELECT id::text, username, display_name, email, password_hash, role,
               active, must_change_password
        FROM ops_users
        WHERE username = $1
      `,
      [username],
    );
    const user = result.rows[0];
    if (!user || !user.active) {
      await this.audit.record({ actor: username, action: 'auth-login', result: 'failure' });
      return null;
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      await this.audit.record({ actor: username, action: 'auth-login', result: 'failure' });
      return null;
    }
    await this.audit.record({
      actor: user.username,
      role: user.role,
      action: 'auth-login',
      result: 'success',
    });
    return principalForUser(user);
  }

  async createSession(principal: OpsPrincipal): Promise<string> {
    const user = await this.userByUsername(principal.user);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    await this.db.query(
      `
        INSERT INTO ops_sessions (token_hash, user_id, expires_at)
        VALUES ($1, $2, now() + ($3 || ' seconds')::interval)
      `,
      [tokenHash, user.id, this.config.sessionMaxAgeSeconds],
    );
    return token;
  }

  async principalForSessionToken(token: string): Promise<OpsPrincipal | null> {
    if (!token || !this.db.enabled()) {
      return null;
    }
    const result = await this.db.query<OpsUserRecord>(
      `
        SELECT u.id::text, u.username, u.display_name, u.email, u.role,
               u.active, u.must_change_password
        FROM ops_sessions s
        JOIN ops_users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.expires_at > now()
          AND u.active = TRUE
      `,
      [hashToken(token)],
    );
    const user = result.rows[0];
    if (!user) {
      return null;
    }
    await this.db.query('UPDATE ops_sessions SET last_seen_at = now() WHERE token_hash = $1', [
      hashToken(token),
    ]);
    return principalForUser(user);
  }

  async deleteSession(token: string): Promise<void> {
    if (!token || !this.db.enabled()) {
      return;
    }
    await this.db.query('DELETE FROM ops_sessions WHERE token_hash = $1', [hashToken(token)]);
  }

  async listUsers(): Promise<UserSummary[]> {
    const result = await this.db.query<OpsUserRecord>(
      `
        SELECT id::text, username, display_name, email, role, active, must_change_password
        FROM ops_users
        ORDER BY username ASC
      `,
    );
    return result.rows.map(summarizeUser);
  }

  async createUser(input: {
    readonly username: string;
    readonly displayName: string;
    readonly email?: string;
    readonly password: string;
    readonly role: OpsRole;
  }): Promise<UserSummary> {
    const passwordHash = await hashPassword(input.password);
    const result = await this.db.query<OpsUserRecord>(
      `
        INSERT INTO ops_users
          (username, display_name, email, password_hash, role, must_change_password)
        VALUES ($1, $2, $3, $4, $5, TRUE)
        RETURNING id::text, username, display_name, email, role, active, must_change_password
      `,
      [input.username, input.displayName, input.email || null, passwordHash, input.role],
    );
    return summarizeUser(result.rows[0]);
  }

  async setUserActive(username: string, active: boolean): Promise<UserSummary> {
    const result = await this.db.query<OpsUserRecord>(
      `
        UPDATE ops_users
        SET active = $2, updated_at = now()
        WHERE username = $1
        RETURNING id::text, username, display_name, email, role, active, must_change_password
      `,
      [username, active],
    );
    if (!result.rows[0]) {
      throw new UnauthorizedException('user not found');
    }
    if (!active) {
      await this.db.query(
        'DELETE FROM ops_sessions WHERE user_id = (SELECT id FROM ops_users WHERE username = $1)',
        [username],
      );
    }
    return summarizeUser(result.rows[0]);
  }

  async resetPassword(username: string, password: string): Promise<UserSummary> {
    const passwordHash = await hashPassword(password);
    const result = await this.db.query<OpsUserRecord>(
      `
        UPDATE ops_users
        SET password_hash = $2,
            must_change_password = TRUE,
            password_changed_at = now(),
            updated_at = now()
        WHERE username = $1
        RETURNING id::text, username, display_name, email, role, active, must_change_password
      `,
      [username, passwordHash],
    );
    if (!result.rows[0]) {
      throw new UnauthorizedException('user not found');
    }
    await this.db.query(
      'DELETE FROM ops_sessions WHERE user_id = (SELECT id FROM ops_users WHERE username = $1)',
      [username],
    );
    return summarizeUser(result.rows[0]);
  }

  private async bootstrapFirstUser(): Promise<void> {
    const existing = await this.db.query<{ count: string }>('SELECT count(*)::text AS count FROM ops_users');
    if (Number(existing.rows[0]?.count || 0) > 0) {
      return;
    }
    if (!this.config.bootstrapUsername || !this.config.bootstrapPasswordHash) {
      this.logger.warn('No OPS_BOOTSTRAP_* user configured and ops_users is empty');
      return;
    }
    const role = parseRole(this.config.bootstrapRole);
    await this.db.query(
      `
        INSERT INTO ops_users
          (username, display_name, email, password_hash, role, must_change_password)
        VALUES ($1, $2, $3, $4, $5, FALSE)
      `,
      [
        this.config.bootstrapUsername,
        this.config.bootstrapDisplayName || this.config.bootstrapUsername,
        this.config.bootstrapEmail || null,
        this.config.bootstrapPasswordHash,
        role,
      ],
    );
    await this.audit.record({
      actor: this.config.bootstrapUsername,
      role,
      action: 'auth-bootstrap',
      result: 'success',
    });
  }

  private async userByUsername(username: string): Promise<OpsUserRecord> {
    const result = await this.db.query<OpsUserRecord>(
      `
        SELECT id::text, username, display_name, email, role, active, must_change_password
        FROM ops_users
        WHERE username = $1 AND active = TRUE
      `,
      [username],
    );
    const user = result.rows[0];
    if (!user) {
      throw new UnauthorizedException('user not found');
    }
    return user;
  }
}

function principalForUser(user: OpsUserRecord): OpsPrincipal {
  return {
    user: user.username,
    email: user.email || undefined,
    groups: [`lb-map-${user.role}`],
    roles: [user.role],
  };
}

function summarizeUser(user: OpsUserRecord): UserSummary {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    email: user.email || undefined,
    role: user.role,
    active: user.active,
    mustChangePassword: user.must_change_password,
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function parseRole(role: string): OpsRole {
  if (role === 'first-level' || role === 'admin') {
    return role;
  }
  return 'admin';
}
