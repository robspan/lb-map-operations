import { Injectable, Logger } from '@nestjs/common';
import { TargetApp, TargetEnvironment } from '@lb-map-operations/ops-contract';
import { OpsConfigService } from '../config/ops-config.service';
import { DatabaseService } from '../database/database.service';

export interface AuditEventInput {
  readonly actor?: string;
  readonly role?: string;
  readonly action: string;
  readonly targetApp?: TargetApp;
  readonly targetEnvironment?: TargetEnvironment;
  readonly result: 'success' | 'failure' | 'rejected' | 'started';
  readonly runId?: string;
  readonly metadata?: Record<string, string | number | boolean | null>;
}

export interface AuditEventSummary {
  readonly id: string;
  readonly occurredAt: string;
  readonly actor?: string;
  readonly role?: string;
  readonly action: string;
  readonly targetApp?: TargetApp;
  readonly targetEnvironment?: TargetEnvironment;
  readonly result: AuditEventInput['result'];
  readonly runId?: string;
  readonly metadata: Record<string, string | number | boolean | null>;
}

export interface AuditEventPage {
  readonly events: readonly AuditEventSummary[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

interface CountRecord {
  readonly total: string | number;
}

interface AuditEventRecord {
  readonly id: string;
  readonly occurred_at: Date;
  readonly actor: string | null;
  readonly role: string | null;
  readonly action: string;
  readonly target_app: TargetApp | null;
  readonly target_environment: TargetEnvironment | null;
  readonly result: AuditEventInput['result'];
  readonly run_id: string | null;
  readonly metadata: Record<string, string | number | boolean | null>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly config: OpsConfigService,
    private readonly db: DatabaseService,
  ) {}

  async record(input: AuditEventInput): Promise<void> {
    const payload = {
      actor: input.actor,
      role: input.role,
      action: input.action,
      target_app: input.targetApp,
      target_environment: input.targetEnvironment,
      result: input.result,
      run_id: input.runId,
      metadata: input.metadata || {},
    };
    this.logger.log(JSON.stringify({ event: 'audit', ...payload }));
    if (!this.db.enabled()) {
      return;
    }
    await this.db.query(
      `
        INSERT INTO ops_audit_events
          (actor, role, action, target_app, target_environment, result, run_id, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      `,
      [
        input.actor || null,
        input.role || null,
        input.action,
        input.targetApp || null,
        input.targetEnvironment || null,
        input.result,
        input.runId || null,
        JSON.stringify(input.metadata || {}),
      ],
    );
    await this.pruneOldEvents();
  }

  async listRecent(limit = 25, offset = 0): Promise<AuditEventPage> {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const boundedOffset = Math.max(0, offset);
    const [countResult, result] = await Promise.all([
      this.db.query<CountRecord>(
        'SELECT count(*) AS total FROM ops_audit_events',
      ),
      this.db.query<AuditEventRecord>(
        `
          SELECT id::text, occurred_at, actor, role, action, target_app,
                 target_environment, result, run_id, metadata
          FROM ops_audit_events
          ORDER BY occurred_at DESC
          LIMIT $1
          OFFSET $2
        `,
        [boundedLimit, boundedOffset],
      ),
    ]);
    const total = Number(countResult.rows[0]?.total || 0);
    return {
      events: result.rows.map((row) => ({
        id: row.id,
        occurredAt: row.occurred_at.toISOString(),
        actor: row.actor || undefined,
        role: row.role || undefined,
        action: row.action,
        targetApp: row.target_app || undefined,
        targetEnvironment: row.target_environment || undefined,
        result: row.result,
        runId: row.run_id || undefined,
        metadata: row.metadata || {},
      })),
      total: Number.isFinite(total) ? total : 0,
      limit: boundedLimit,
      offset: boundedOffset,
    };
  }

  private async pruneOldEvents(): Promise<void> {
    if (this.config.auditRetentionDays <= 0) {
      return;
    }
    await this.db.query(
      `
        DELETE FROM ops_audit_events
        WHERE occurred_at < now() - ($1 || ' days')::interval
      `,
      [this.config.auditRetentionDays],
    );
  }
}
