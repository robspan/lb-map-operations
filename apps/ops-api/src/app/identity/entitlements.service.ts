import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AppEntitlementDecision,
  AppEntitlementStatus,
  AppEntitlementSummary,
  AppResourceStatus,
  TargetApp,
  TargetEnvironment,
} from '@lb-map-operations/ops-contract';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';

interface EntitlementRecord {
  readonly id: string;
  readonly subject: string;
  readonly username: string | null;
  readonly app: TargetApp;
  readonly environment: TargetEnvironment;
  readonly role: string;
  readonly status: AppEntitlementStatus;
  readonly resource_status: AppResourceStatus;
  readonly updated_at: Date;
}

@Injectable()
export class EntitlementsService {
  constructor(
    private readonly audit: AuditService,
    private readonly db: DatabaseService,
  ) {}

  async list(app?: TargetApp, environment?: TargetEnvironment): Promise<AppEntitlementSummary[]> {
    const clauses: string[] = [];
    const values: string[] = [];
    if (app) {
      values.push(app);
      clauses.push(`app = $${values.length}`);
    }
    if (environment) {
      values.push(environment);
      clauses.push(`environment = $${values.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.db.query<EntitlementRecord>(
      `
        SELECT id::text, subject, username, app, environment, role, status,
               resource_status, updated_at
        FROM ops_app_entitlements
        ${where}
        ORDER BY app, environment, subject
      `,
      values,
    );
    return result.rows.map(summarize);
  }

  async usernamesBySubject(
    app: TargetApp,
    environment: TargetEnvironment,
    subjects: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const uniqueSubjects = [...new Set(subjects.filter(Boolean))];
    if (!uniqueSubjects.length) {
      return new Map();
    }
    const result = await this.db.query<Pick<EntitlementRecord, 'subject' | 'username'>>(
      `
        SELECT subject, username
        FROM ops_app_entitlements
        WHERE app = $1
          AND environment = $2
          AND subject = ANY($3)
      `,
      [app, environment, uniqueSubjects],
    );
    return new Map(
      result.rows
        .filter((row): row is { readonly subject: string; readonly username: string } =>
          Boolean(row.username),
        )
        .map((row) => [row.subject, row.username]),
    );
  }

  async decision(params: {
    readonly subject: string;
    readonly app: TargetApp;
    readonly environment: TargetEnvironment;
  }): Promise<AppEntitlementDecision> {
    const result = await this.db.query<EntitlementRecord>(
      `
        SELECT id::text, subject, username, app, environment, role, status,
               resource_status, updated_at
        FROM ops_app_entitlements
        WHERE subject = $1 AND app = $2 AND environment = $3
      `,
      [params.subject, params.app, params.environment],
    );
    const row = result.rows[0];
    if (!row) {
      return {
        active: false,
        subject: params.subject,
        app: params.app,
        environment: params.environment,
        reason: 'not-found',
      };
    }
    if (row.status !== 'active') {
      return { ...decisionBase(row), active: false, reason: 'inactive-entitlement' };
    }
    if (row.resource_status !== 'active') {
      return { ...decisionBase(row), active: false, reason: 'inactive-resource' };
    }
    return { ...decisionBase(row), active: true };
  }

  async grant(input: {
    readonly subject: string;
    readonly username?: string;
    readonly app: TargetApp;
    readonly environment: TargetEnvironment;
    readonly role: string;
    readonly resourceStatus?: AppResourceStatus;
    readonly actor: string;
  }): Promise<AppEntitlementSummary> {
    validateSubject(input.subject);
    validateRole(input.role);
    const resourceStatus = input.resourceStatus || 'pending';
    const result = await this.db.query<EntitlementRecord>(
      `
        INSERT INTO ops_app_entitlements
          (subject, username, app, environment, role, status, resource_status, updated_by)
        VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)
        ON CONFLICT (subject, app, environment)
        DO UPDATE SET
          username = EXCLUDED.username,
          role = EXCLUDED.role,
          status = 'active',
          resource_status = EXCLUDED.resource_status,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()
        RETURNING id::text, subject, username, app, environment, role, status,
                  resource_status, updated_at
      `,
      [
        input.subject,
        input.username || null,
        input.app,
        input.environment,
        input.role,
        resourceStatus,
        input.actor,
      ],
    );
    const summary = summarize(result.rows[0]);
    await this.audit.record({
      actor: input.actor,
      action: 'identity_entitlement_grant',
      targetApp: input.app,
      targetEnvironment: input.environment,
      result: 'success',
      metadata: {
        subject: input.subject,
        role: input.role,
        resourceStatus,
      },
    });
    return summary;
  }

  async setResourceStatus(input: {
    readonly subject: string;
    readonly app: TargetApp;
    readonly environment: TargetEnvironment;
    readonly resourceStatus: AppResourceStatus;
    readonly actor: string;
  }): Promise<AppEntitlementSummary> {
    const result = await this.db.query<EntitlementRecord>(
      `
        UPDATE ops_app_entitlements
        SET resource_status = $4, updated_by = $5, updated_at = now()
        WHERE subject = $1 AND app = $2 AND environment = $3
        RETURNING id::text, subject, username, app, environment, role, status,
                  resource_status, updated_at
      `,
      [input.subject, input.app, input.environment, input.resourceStatus, input.actor],
    );
    const row = result.rows[0];
    if (!row) {
      throw new NotFoundException('entitlement not found');
    }
    await this.audit.record({
      actor: input.actor,
      action: 'identity_resource_status_update',
      targetApp: input.app,
      targetEnvironment: input.environment,
      result: 'success',
      metadata: {
        subject: input.subject,
        resourceStatus: input.resourceStatus,
      },
    });
    return summarize(row);
  }

  async revoke(input: {
    readonly subject: string;
    readonly app: TargetApp;
    readonly environment: TargetEnvironment;
    readonly actor: string;
  }): Promise<AppEntitlementSummary> {
    const result = await this.db.query<EntitlementRecord>(
      `
        UPDATE ops_app_entitlements
        SET status = 'revoked',
            resource_status = 'revoked',
            updated_by = $4,
            updated_at = now()
        WHERE subject = $1 AND app = $2 AND environment = $3
        RETURNING id::text, subject, username, app, environment, role, status,
                  resource_status, updated_at
      `,
      [input.subject, input.app, input.environment, input.actor],
    );
    const row = result.rows[0];
    if (!row) {
      throw new NotFoundException('entitlement not found');
    }
    const summary = summarize(row);
    await this.audit.record({
      actor: input.actor,
      action: 'identity_entitlement_revoke',
      targetApp: input.app,
      targetEnvironment: input.environment,
      result: 'success',
      metadata: {
        subject: input.subject,
      },
    });
    return summary;
  }
}

function summarize(row: EntitlementRecord): AppEntitlementSummary {
  return {
    id: row.id,
    subject: row.subject,
    username: row.username || undefined,
    app: row.app,
    environment: row.environment,
    role: row.role,
    status: row.status,
    resourceStatus: row.resource_status,
    active: row.status === 'active' && row.resource_status === 'active',
    updatedAt: row.updated_at.toISOString(),
  };
}

function decisionBase(row: EntitlementRecord): Omit<AppEntitlementDecision, 'active' | 'reason'> {
  return {
    subject: row.subject,
    app: row.app,
    environment: row.environment,
    role: row.role,
    status: row.status,
    resourceStatus: row.resource_status,
  };
}

function validateSubject(subject: string): void {
  if (!/^[A-Za-z0-9._:@+-]{1,160}$/.test(subject)) {
    throw new BadRequestException('invalid subject');
  }
}

function validateRole(role: string): void {
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(role)) {
    throw new BadRequestException('invalid role');
  }
}
