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
        role TEXT NOT NULL CHECK (role IN ('first-level', 'operator', 'admin')),
        active BOOLEAN NOT NULL DEFAULT TRUE,
        must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
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
  }
}
