import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, QueryResult, QueryResultRow } from 'pg';
import { OpsConfigService } from '../config/ops-config.service';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool?: Pool;
  private initialized?: Promise<void>;

  constructor(private readonly config: OpsConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.init();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  enabled(): boolean {
    return !!this.config.databaseUrl;
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return this.initialized;
    }
    this.initialized = this.initialize();
    return this.initialized;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    await this.init();
    if (!this.pool) {
      throw new Error('operations database is not configured');
    }
    return this.pool.query<T>(text, values as unknown[]);
  }

  private async initialize(): Promise<void> {
    if (!this.config.databaseUrl) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('OPS_PG_URL is required in production');
      }
      this.logger.warn('OPS_PG_URL is not set; DB-backed auth is disabled');
      return;
    }

    this.pool = new Pool({
      connectionString: this.config.databaseUrl,
      application_name: 'lb-map-operations-api',
      max: 5,
    });
    await this.migrate();
  }

  private async migrate(): Promise<void> {
    const pool = this.pool;
    if (!pool) {
      throw new Error('operations database pool is not initialized');
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ops_users (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        email TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('first-level', 'admin')),
        active BOOLEAN NOT NULL DEFAULT TRUE,
        must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`UPDATE ops_users SET role = 'admin' WHERE role = 'operator'`);
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'ops_users'::regclass
            AND conname = 'ops_users_role_check'
        ) THEN
          ALTER TABLE ops_users DROP CONSTRAINT ops_users_role_check;
        END IF;
      END $$;
    `);
    await pool.query(`
      ALTER TABLE ops_users
      ADD CONSTRAINT ops_users_role_check
      CHECK (role IN ('first-level', 'admin'))
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ops_sessions (
        id BIGSERIAL PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id BIGINT NOT NULL REFERENCES ops_users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ops_sessions_user_id_idx
      ON ops_sessions(user_id)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ops_audit_events (
        id BIGSERIAL PRIMARY KEY,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        actor TEXT,
        role TEXT,
        action TEXT NOT NULL,
        target_app TEXT,
        target_environment TEXT,
        result TEXT NOT NULL,
        run_id TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ops_audit_events_occurred_at_idx
      ON ops_audit_events(occurred_at DESC)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ops_app_entitlements (
        id BIGSERIAL PRIMARY KEY,
        subject TEXT NOT NULL,
        username TEXT,
        app TEXT NOT NULL,
        environment TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'active', 'revoked')),
        resource_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (resource_status IN ('pending', 'active', 'failed', 'revoked')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by TEXT
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ops_app_entitlements_subject_app_env_idx
      ON ops_app_entitlements(subject, app, environment)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ops_app_entitlements_app_env_status_idx
      ON ops_app_entitlements(app, environment, status, resource_status)
    `);
  }
}
