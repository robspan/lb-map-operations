import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ActionEvidence,
  ActionRunRequest,
  ActionRunResult,
  AppOperationsContract,
  DiagnosisReport,
  DiagnosisStepEvent,
  DiagnosisStreamEvent,
  OpsPrincipal,
  TargetEnvironment,
  roleAllows,
} from '@lb-map-operations/ops-contract';
import { ArgoClient } from '../clients/argo.client';
import { AuditService } from '../audit/audit.service';
import { KubernetesClient } from '../clients/kubernetes.client';
import {
  LokiClient,
  LokiLogObservation,
} from '../clients/loki.client';
import {
  PrometheusClient,
  PrometheusMetricObservation,
} from '../clients/prometheus.client';
import { OpsConfigService, TargetConfig } from '../config/ops-config.service';
import { AppContractsService } from '../contracts/app-contracts.service';
import { buildDiagnosisReport } from '../diagnosis/diagnosis-rules';
import type {
  DiagnosisFacts,
  EndpointProbe,
} from '../diagnosis/diagnosis-rules';
import { IdentityService } from '../identity/identity.service';
import { MetricsService } from '../observability/metrics.service';
import { normalizeActionInputs } from './action-inputs';
import { actionById } from './action-registry';
import { RunStoreService } from './run-store.service';

type PodLike = {
  readonly metadata?: {
    readonly creationTimestamp?: string;
    readonly name?: string;
  };
  readonly status?: {
    readonly phase?: string;
  };
};

type CreatedResource = {
  readonly metadata?: {
    readonly creationTimestamp?: string;
  };
};

type JobLike = {
  readonly metadata?: {
    readonly name?: string;
    readonly creationTimestamp?: string;
  };
  readonly status?: {
    readonly active?: number;
    readonly failed?: number;
    readonly succeeded?: number;
    readonly phase?: string;
    readonly startedAt?: string;
    readonly completionTime?: string;
  };
};

type KubernetesListLike<T> = {
  readonly items?: readonly T[];
};

type ConditionLike = {
  readonly type?: string;
  readonly status?: string;
  readonly reason?: string;
  readonly message?: string;
};

type ClusterLike = {
  readonly metadata?: {
    readonly name?: string;
  };
  readonly spec?: {
    readonly instances?: number;
  };
  readonly status?: {
    readonly phase?: string;
    readonly instances?: number;
    readonly readyInstances?: number;
    readonly currentPrimary?: string;
    readonly targetPrimary?: string;
    readonly conditions?: readonly ConditionLike[];
  };
};

type IngressLike = {
  readonly metadata?: {
    readonly name?: string;
  };
  readonly spec?: {
    readonly ingressClassName?: string;
    readonly tls?: readonly {
      readonly hosts?: readonly string[];
      readonly secretName?: string;
    }[];
    readonly rules?: readonly {
      readonly host?: string;
    }[];
  };
};

type CertificateLike = {
  readonly metadata?: {
    readonly name?: string;
  };
  readonly status?: {
    readonly conditions?: readonly ConditionLike[];
    readonly notAfter?: string;
    readonly renewalTime?: string;
  };
};

type BackupLike = {
  readonly metadata?: {
    readonly name?: string;
    readonly creationTimestamp?: string;
  };
  readonly spec?: {
    readonly cluster?: {
      readonly name?: string;
    };
  };
  readonly status?: {
    readonly phase?: string;
    readonly startedAt?: string;
    readonly stoppedAt?: string;
  };
};

type DeploymentRuntimeLike = {
  readonly spec?: {
    readonly template?: {
      readonly spec?: {
        readonly containers?: readonly {
          readonly name?: string;
          readonly image?: string;
        }[];
        readonly imagePullSecrets?: readonly { readonly name?: string }[];
        readonly serviceAccountName?: string;
      };
    };
  };
};

type ActionOutput = {
  readonly summary: string;
  readonly evidence: readonly ActionEvidence[];
  readonly diagnosis?: DiagnosisReport;
};

type Captured<T> = {
  readonly value?: T;
  readonly error?: string;
};

type DiagnosisProgress = (step: DiagnosisStepEvent) => Promise<void> | void;

const DIAGNOSIS_STEP_SPREAD_MS = 300;
const WORKSPACE_DB_URLS_SECRET = 'varlens-workspace-db-urls';

const VARLENS_USER_CREATE_SCRIPT = String.raw`
set -euo pipefail
node <<'NODE'
const { Client } = require('pg')

function need(name) {
  const value = process.env[name]
  if (!value) throw new Error(name + ' is required')
  return value
}
function quoteIdent(value) {
  return '"' + String(value).replace(/"/g, '""') + '"'
}
function quoteLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}
async function main() {
  const host = need('PGHOST')
  const port = Number(process.env.PGPORT || '5432')
  const user = process.env.PGUSER || process.env.POSTGRES_USER || 'postgres'
  const password = need('PGPASSWORD')
  const dbName = need('VARLENS_OPS_DB_NAME')
  const ownerRole = need('VARLENS_OPS_OWNER_ROLE')
  const migratorRole = need('VARLENS_OPS_MIGRATOR_ROLE')
  const appRole = need('VARLENS_OPS_APP_ROLE')
  const ownerPassword = need('VARLENS_OPS_OWNER_PASSWORD')
  const migratorPassword = need('VARLENS_OPS_MIGRATOR_PASSWORD')
  const appPassword = need('VARLENS_OPS_APP_PASSWORD')
  const admin = new Client({ host, port, user, password, database: 'postgres' })
  await admin.connect()
  try {
    await admin.query("SELECT pg_advisory_lock(hashtext('varlens-user-lifecycle'))")
    for (const [role, rolePassword] of [
      [ownerRole, ownerPassword],
      [migratorRole, migratorPassword],
      [appRole, appPassword],
    ]) {
      const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])
      if (exists.rowCount) {
        await admin.query('ALTER ROLE ' + quoteIdent(role) + ' PASSWORD ' + quoteLiteral(rolePassword))
      } else {
        await admin.query(
          'CREATE ROLE ' + quoteIdent(role) + ' LOGIN PASSWORD ' + quoteLiteral(rolePassword)
        )
      }
    }
    await admin.query('GRANT ' + quoteIdent(ownerRole) + ' TO ' + quoteIdent(migratorRole))
    const db = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
    if (!db.rowCount) {
      await admin.query('CREATE DATABASE ' + quoteIdent(dbName) + ' OWNER ' + quoteIdent(ownerRole))
    }
    await admin.query('REVOKE ALL PRIVILEGES ON DATABASE ' + quoteIdent(dbName) + ' FROM PUBLIC')
    await admin.query(
      'GRANT CONNECT ON DATABASE ' + quoteIdent(dbName) + ' TO ' + quoteIdent(migratorRole) + ', ' + quoteIdent(appRole)
    )
  } finally {
    await admin.query("SELECT pg_advisory_unlock(hashtext('varlens-user-lifecycle'))").catch(() => {})
    await admin.end()
  }

  const workspace = new Client({ host, port, user, password, database: dbName })
  await workspace.connect()
  try {
    await workspace.query('REVOKE ALL ON SCHEMA public FROM PUBLIC')
    await workspace.query('GRANT USAGE, CREATE ON SCHEMA public TO ' + quoteIdent(migratorRole))
    await workspace.query('GRANT USAGE ON SCHEMA public TO ' + quoteIdent(appRole))
    await workspace.query(
      'ALTER DEFAULT PRIVILEGES FOR ROLE ' + quoteIdent(migratorRole) + ' IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ' + quoteIdent(appRole)
    )
    await workspace.query(
      'ALTER DEFAULT PRIVILEGES FOR ROLE ' + quoteIdent(migratorRole) + ' IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ' + quoteIdent(appRole)
    )
  } finally {
    await workspace.end()
  }
}
main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }))
  process.exit(1)
})
NODE

VARLENS_PG_URL="$VARLENS_PRIVATE_MIGRATOR_PG_URL" node out/web/migrate-db.cjs

control_url="$VARLENS_CONTROL_STATE_PG_URL"
if [ -z "$control_url" ]; then
  control_url="$VARLENS_PG_URL"
fi
if [ -z "$control_url" ]; then
  echo '{"ok":false,"error":"control database URL missing"}' >&2
  exit 1
fi
VARLENS_PG_URL="$control_url" node out/web/provision-user.cjs \
  --username "$VARLENS_OPS_USERNAME" \
  --display-name "$VARLENS_OPS_DISPLAY_NAME" \
  --created-by "$VARLENS_OPS_CREATED_BY" \
  --password-file /var/run/varlens/ops-user/password \
  --private-db-secret-ref "$VARLENS_OPS_SECRET_REF"

node <<'NODE'
const { Client } = require('pg')
function need(name) {
  const value = process.env[name]
  if (!value) throw new Error(name + ' is required')
  return value
}
function quoteIdent(value) {
  return '"' + String(value).replace(/"/g, '""') + '"'
}
async function main() {
  const client = new Client({
    connectionString: need('VARLENS_PRIVATE_MIGRATOR_PG_URL'),
  })
  await client.connect()
  try {
    const appRole = need('VARLENS_OPS_APP_ROLE')
    const migratorRole = need('VARLENS_OPS_MIGRATOR_ROLE')
    await client.query(
      'GRANT USAGE ON SCHEMA varlens_audit TO ' + quoteIdent(appRole)
    ).catch(() => {})
    await client.query(
      'GRANT INSERT, SELECT ON ALL TABLES IN SCHEMA varlens_audit TO ' + quoteIdent(appRole)
    ).catch(() => {})
    await client.query(
      'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA varlens_audit TO ' + quoteIdent(appRole)
    ).catch(() => {})
    await client.query(
      'ALTER DEFAULT PRIVILEGES FOR ROLE ' + quoteIdent(migratorRole) + ' IN SCHEMA varlens_audit GRANT INSERT, SELECT ON TABLES TO ' + quoteIdent(appRole)
    ).catch(() => {})
    await client.query(
      'ALTER DEFAULT PRIVILEGES FOR ROLE ' + quoteIdent(migratorRole) + ' IN SCHEMA varlens_audit GRANT USAGE, SELECT ON SEQUENCES TO ' + quoteIdent(appRole)
    ).catch(() => {})
  } finally {
    await client.end()
  }
}
main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }))
  process.exit(1)
})
NODE
`;

const VARLENS_USER_BLOCK_SCRIPT = String.raw`
set -euo pipefail
node <<'NODE'
const { Client } = require('pg')
async function main() {
  const username = process.env.VARLENS_OPS_USERNAME
  const url = process.env.VARLENS_CONTROL_STATE_PG_URL || process.env.VARLENS_PG_URL
  if (!username || !url) throw new Error('username/control URL missing')
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    const existing = await client.query(
      'SELECT id, role FROM public.users WHERE username = $1',
      [username]
    )
    if (!existing.rowCount) throw new Error('User not found: ' + username)
    if (existing.rows[0].role === 'admin') throw new Error('Cannot block an admin user')
    await client.query(
      "UPDATE public.users SET is_active = FALSE, private_db_status = CASE WHEN private_db_status = 'active' THEN 'disabled' ELSE private_db_status END, updated_at = now() WHERE username = $1",
      [username]
    )
    console.log(JSON.stringify({ ok: true, username, action: 'blocked' }))
  } finally {
    await client.end()
  }
}
main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }))
  process.exit(1)
})
NODE
`;

const VARLENS_USER_PRUNE_SCRIPT = String.raw`
set -euo pipefail
node <<'NODE'
const { Client } = require('pg')
function need(name) {
  const value = process.env[name]
  if (!value) throw new Error(name + ' is required')
  return value
}
function quoteIdent(value) {
  return '"' + String(value).replace(/"/g, '""') + '"'
}
async function main() {
  const username = need('VARLENS_OPS_USERNAME')
  const dbName = need('VARLENS_OPS_DB_NAME')
  const ownerRole = need('VARLENS_OPS_OWNER_ROLE')
  const migratorRole = need('VARLENS_OPS_MIGRATOR_ROLE')
  const appRole = need('VARLENS_OPS_APP_ROLE')
  const controlUrl = process.env.VARLENS_CONTROL_STATE_PG_URL || process.env.VARLENS_PG_URL
  if (!controlUrl) throw new Error('control database URL missing')

  const control = new Client({ connectionString: controlUrl })
  await control.connect()
  try {
    await control.query('BEGIN')
    const existing = await control.query(
      'SELECT id, role FROM public.users WHERE username = $1 FOR UPDATE',
      [username]
    )
    if (!existing.rowCount) throw new Error('User not found: ' + username)
    if (existing.rows[0].role === 'admin') throw new Error('Cannot prune an admin user')
    const id = existing.rows[0].id
    await control.query('UPDATE public.users SET created_by = NULL WHERE created_by = $1', [id])
    await control.query('DELETE FROM public.users WHERE id = $1', [id])
    await control.query('COMMIT')
  } catch (error) {
    await control.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    await control.end()
  }

  const admin = new Client({
    host: need('PGHOST'),
    port: Number(process.env.PGPORT || '5432'),
    user: process.env.PGUSER || process.env.POSTGRES_USER || 'postgres',
    password: need('PGPASSWORD'),
    database: 'postgres',
  })
  await admin.connect()
  try {
    await admin.query("SELECT pg_advisory_lock(hashtext('varlens-user-lifecycle'))")
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [dbName]
    )
    await admin.query('DROP DATABASE IF EXISTS ' + quoteIdent(dbName))
    for (const role of [appRole, migratorRole, ownerRole]) {
      await admin.query('DROP ROLE IF EXISTS ' + quoteIdent(role))
    }
    console.log(JSON.stringify({ ok: true, username, action: 'pruned' }))
  } finally {
    await admin.query("SELECT pg_advisory_unlock(hashtext('varlens-user-lifecycle'))").catch(() => {})
    await admin.end()
  }
}
main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }))
  process.exit(1)
})
NODE
`;

@Injectable()
export class ActionRunnerService {
  constructor(
    private readonly argo: ArgoClient,
    private readonly audit: AuditService,
    private readonly config: OpsConfigService,
    private readonly contracts: AppContractsService,
    private readonly identity: IdentityService,
    private readonly kubernetes: KubernetesClient,
    private readonly loki: LokiClient,
    private readonly metrics: MetricsService,
    private readonly prometheus: PrometheusClient,
    private readonly store: RunStoreService,
  ) {}

  async run(
    actionId: string,
    request: ActionRunRequest,
    principal: OpsPrincipal,
  ): Promise<ActionRunResult> {
    const action = actionById(actionId);
    if (!action) {
      throw new NotFoundException(`unknown action: ${actionId}`);
    }
    if (!roleAllows(principal.roles, action.role)) {
      this.identity.requireRole(principal, action.role);
    }

    const targetEnvironment = validateEnvironment(request.targetEnvironment);
    const target = this.config.target(
      request.targetApp || action.targetApp,
      targetEnvironment,
    );
    const contract = this.contracts.contract(target.app, target.environment);
    const inputs = normalizeActionInputs(action, request.inputs);
    const role = this.identity.primaryRole(principal);
    const runId = randomUUID();
    const startedAt = new Date();
    const started = this.store.save({
      runId,
      actionId,
      status: 'running',
      startedAt: startedAt.toISOString(),
      targetApp: target.app,
      targetEnvironment: target.environment,
      actor: principal.user,
      role,
      summary: 'Aktion läuft.',
      evidence: [],
    });

    this.logRun(started, 'started', 0);
    await this.audit.record({
      actor: principal.user,
      role,
      action: actionId,
      targetApp: target.app,
      targetEnvironment: target.environment,
      result: 'started',
      runId,
    });

    try {
      const output = await this.execute(
        actionId,
        target,
        contract,
        inputs,
        principal,
      );
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      const run = this.store.save({
        ...started,
        status: 'succeeded',
        finishedAt: finishedAt.toISOString(),
        summary: output.summary,
        evidence: output.evidence,
        diagnosis: output.diagnosis,
      });
      this.metrics.record(actionId, role, 'succeeded', durationMs);
      this.logRun(run, 'succeeded', durationMs);
      await this.audit.record({
        actor: principal.user,
        role,
        action: actionId,
        targetApp: target.app,
        targetEnvironment: target.environment,
        result: 'success',
        runId,
        metadata: { durationMs },
      });
      return run;
    } catch (error) {
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      const run = this.store.save({
        ...started,
        status: 'failed',
        finishedAt: finishedAt.toISOString(),
        summary: 'Aktion fehlgeschlagen.',
        evidence: [],
        message: error instanceof Error ? error.message : 'unknown error',
      });
      this.metrics.record(actionId, role, 'failed', durationMs);
      this.logRun(run, 'failed', durationMs);
      await this.audit.record({
        actor: principal.user,
        role,
        action: actionId,
        targetApp: target.app,
        targetEnvironment: target.environment,
        result: 'failure',
        runId,
        metadata: { durationMs, error: message(error) },
      });
      return run;
    }
  }

  async streamDiagnosis(
    request: ActionRunRequest,
    principal: OpsPrincipal,
    emit: (event: DiagnosisStreamEvent) => void,
  ): Promise<void> {
    const action = actionById('diagnose-target');
    if (!action) {
      throw new NotFoundException('unknown action: diagnose-target');
    }
    if (!roleAllows(principal.roles, action.role)) {
      this.identity.requireRole(principal, action.role);
    }

    const targetEnvironment = validateEnvironment(request.targetEnvironment);
    const target = this.config.target(
      request.targetApp || action.targetApp,
      targetEnvironment,
    );
    const contract = this.contracts.contract(target.app, target.environment);
    const inputs = normalizeActionInputs(action, request.inputs);
    const role = this.identity.primaryRole(principal);
    const runId = randomUUID();
    const startedAt = new Date();
    const started = this.store.save({
      runId,
      actionId: action.id,
      status: 'running',
      startedAt: startedAt.toISOString(),
      targetApp: target.app,
      targetEnvironment: target.environment,
      actor: principal.user,
      role,
      summary: 'Diagnose läuft.',
      evidence: [],
    });

    this.logRun(started, 'started', 0);
    await this.audit.record({
      actor: principal.user,
      role,
      action: action.id,
      targetApp: target.app,
      targetEnvironment: target.environment,
      result: 'started',
      runId,
    });
    emit({
      type: 'started',
      runId,
      targetApp: target.app,
      targetEnvironment: target.environment,
      startedAt: started.startedAt,
    });

    try {
      const diagnosisProgress = staggerDiagnosisProgress((step) =>
        emit({ type: 'step', runId, step }),
        configuredDiagnosisStepCount(contract),
      );
      const output = await this.diagnoseTarget(
        target,
        contract,
        inputs,
        principal,
        diagnosisProgress,
      );
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      const run = this.store.save({
        ...started,
        status: 'succeeded',
        finishedAt: finishedAt.toISOString(),
        summary: output.summary,
        evidence: output.evidence,
        diagnosis: output.diagnosis,
      });
      this.metrics.record(action.id, role, 'succeeded', durationMs);
      this.logRun(run, 'succeeded', durationMs);
      await this.audit.record({
        actor: principal.user,
        role,
        action: action.id,
        targetApp: target.app,
        targetEnvironment: target.environment,
        result: 'success',
        runId,
        metadata: { durationMs },
      });
      emit({ type: 'result', runId, run });
    } catch (error) {
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      const messageText = message(error);
      const run = this.store.save({
        ...started,
        status: 'failed',
        finishedAt: finishedAt.toISOString(),
        summary: 'Diagnose fehlgeschlagen.',
        evidence: [],
        message: messageText,
      });
      this.metrics.record(action.id, role, 'failed', durationMs);
      this.logRun(run, 'failed', durationMs);
      await this.audit.record({
        actor: principal.user,
        role,
        action: action.id,
        targetApp: target.app,
        targetEnvironment: target.environment,
        result: 'failure',
        runId,
        metadata: { durationMs, error: messageText },
      });
      emit({ type: 'error', runId, message: messageText });
    }
  }

  runStatus(runId: string): ActionRunResult {
    const run = this.store.get(runId);
    if (!run) {
      throw new NotFoundException(`unknown run: ${runId}`);
    }
    return run;
  }

  private async execute(
    actionId: string,
    target: TargetConfig,
    contract: AppOperationsContract,
    inputs: Record<string, string>,
    principal: OpsPrincipal,
  ): Promise<ActionOutput> {
    switch (actionId) {
      case 'diagnose-target':
        return this.diagnoseTarget(target, contract, inputs, principal);
      case 'app-health':
        return this.appHealth(target, contract, inputs);
      case 'argo-status':
        return this.argoStatus(target, contract, inputs);
      case 'endpoint-check':
        return this.endpointCheck(contract, inputs);
      case 'pod-summary':
        return this.podSummary(target, inputs);
      case 'log-summary':
        return this.logSummary(target, contract, inputs);
      case 'smoke-result':
        return this.smokeResult(target, contract, inputs);
      case 'observability-links':
        return this.observabilityLinks(contract);
      case 'platform-overview':
        return this.platformOverview(target, contract, inputs);
      case 'data-store-status':
        return this.dataStoreStatus(target);
      case 'ingress-status':
        return this.ingressStatus(target, contract);
      case 'backup-status':
        return this.backupStatus(target);
      case 'observability-status':
        return this.observabilityStatus(contract);
      case 'argo-sync':
        return this.argoSync(target, contract);
      case 'varlens-user-create':
        return this.varlensUserCreate(target, inputs, principal);
      case 'varlens-user-block':
        return this.varlensUserBlock(target, inputs, principal);
      case 'varlens-user-prune':
        return this.varlensUserPrune(target, inputs, principal);
      case 'rollout-restart':
        if (!contract.workload.statelessRestartAllowed) {
          throw new BadRequestException(
            'Statusloser Neustart ist laut App-Vertrag nicht erlaubt.',
          );
        }
        await this.kubernetes.restartDeployment(target, principal.user);
        return {
          summary: `Neustart-Annotation auf ${target.deployment} in ${target.namespace} angewendet.`,
          evidence: [{ label: 'Deployment', value: target.deployment }],
        };
      default:
        throw new BadRequestException(`action is not implemented: ${actionId}`);
    }
  }

  private async varlensUserCreate(
    target: TargetConfig,
    inputs: Record<string, string>,
    principal: OpsPrincipal,
  ): Promise<ActionOutput> {
    const username = validateVarLensUsername(inputs.username);
    const displayName = validateRequired(inputs.displayName, 'displayName');
    const initialPassword = validateRequired(
      inputs.initialPassword,
      'initialPassword',
    );
    if (initialPassword.length < 8) {
      throw new BadRequestException('Initiales Passwort ist zu kurz.');
    }

    const plan = varlensUserDbPlan(username);
    const ownerPassword = generatedPassword();
    const migratorPassword = generatedPassword();
    const appPassword = generatedPassword();
    const appUrl = postgresUrl(plan.appRole, appPassword, plan.dbName);
    const migratorUrl = postgresUrl(
      plan.migratorRole,
      migratorPassword,
      plan.dbName,
    );
    const jobName = lifecycleJobName('create', username);
    const credentialSecret = `${jobName}-credential`;

    await this.kubernetes.applySecret(
      target.namespace,
      plan.secretName,
      { [plan.secretRef]: appUrl },
      varlensUserSecretLabels(target, username),
    );
    await this.kubernetes.patchSecret(target.namespace, WORKSPACE_DB_URLS_SECRET, {
      metadata: { labels: varlensUserSecretLabels(target, username) },
      stringData: { [plan.secretRef]: appUrl },
    });
    await this.kubernetes.applySecret(
      target.namespace,
      credentialSecret,
      {
        password: initialPassword,
        privateMigratorUrl: migratorUrl,
      },
      varlensUserJobLabels(target, username, 'create'),
    );

    try {
      await this.createVarLensLifecycleJob(target, {
        jobName,
        operation: 'create',
        username,
        actor: principal.user,
        env: [
          { name: 'VARLENS_OPS_USERNAME', value: username },
          { name: 'VARLENS_OPS_DISPLAY_NAME', value: displayName },
          { name: 'VARLENS_OPS_CREATED_BY', value: principal.user },
          { name: 'VARLENS_OPS_DB_NAME', value: plan.dbName },
          { name: 'VARLENS_OPS_OWNER_ROLE', value: plan.ownerRole },
          { name: 'VARLENS_OPS_MIGRATOR_ROLE', value: plan.migratorRole },
          { name: 'VARLENS_OPS_APP_ROLE', value: plan.appRole },
          { name: 'VARLENS_OPS_OWNER_PASSWORD', value: ownerPassword },
          { name: 'VARLENS_OPS_MIGRATOR_PASSWORD', value: migratorPassword },
          { name: 'VARLENS_OPS_APP_PASSWORD', value: appPassword },
          { name: 'VARLENS_OPS_SECRET_REF', value: plan.secretRef },
        ],
        secretName: credentialSecret,
        script: VARLENS_USER_CREATE_SCRIPT,
      });
      const job = await this.waitForLifecycleJob(target, jobName, 180_000);
      if (job.status?.failed) {
        throw new Error(`Provisionierungs-Job ${jobName} ist fehlgeschlagen.`);
      }
    } finally {
      await this.kubernetes.deleteSecret(target.namespace, credentialSecret);
      await this.kubernetes.deleteJob(target.namespace, jobName);
    }

    return {
      summary: `VarLens-Nutzer ${username} wurde mit eigener Workspace-Datenbank angelegt.`,
      evidence: [
        { label: 'Benutzer', value: username },
        { label: 'Name', value: displayName },
        { label: 'Workspace-Datenbank', value: plan.dbName },
        { label: 'Status', value: 'aktiv; Passwortwechsel beim ersten Login' },
      ],
    };
  }

  private async varlensUserBlock(
    target: TargetConfig,
    inputs: Record<string, string>,
    principal: OpsPrincipal,
  ): Promise<ActionOutput> {
    const username = validateVarLensUsername(inputs.username);
    const jobName = lifecycleJobName('block', username);
    await this.createVarLensLifecycleJob(target, {
      jobName,
      operation: 'block',
      username,
      actor: principal.user,
      env: [{ name: 'VARLENS_OPS_USERNAME', value: username }],
      script: VARLENS_USER_BLOCK_SCRIPT,
    });
    const job = await this.waitForLifecycleJob(target, jobName, 60_000);
    await this.kubernetes.deleteJob(target.namespace, jobName);
    if (job.status?.failed) {
      throw new Error(`Sperr-Job ${jobName} ist fehlgeschlagen.`);
    }
    return {
      summary: `VarLens-Nutzer ${username} wurde gesperrt.`,
      evidence: [
        { label: 'Benutzer', value: username },
        { label: 'Login', value: 'gesperrt' },
        { label: 'Workspace-Zuordnung', value: 'disabled' },
      ],
    };
  }

  private async varlensUserPrune(
    target: TargetConfig,
    inputs: Record<string, string>,
    principal: OpsPrincipal,
  ): Promise<ActionOutput> {
    const username = validateVarLensUsername(inputs.username);
    if (inputs.confirmUsername !== username) {
      throw new BadRequestException(
        'Bestätigung stimmt nicht mit dem Benutzernamen überein.',
      );
    }
    const plan = varlensUserDbPlan(username);
    const jobName = lifecycleJobName('prune', username);
    await this.createVarLensLifecycleJob(target, {
      jobName,
      operation: 'prune',
      username,
      actor: principal.user,
      env: [
        { name: 'VARLENS_OPS_USERNAME', value: username },
        { name: 'VARLENS_OPS_DB_NAME', value: plan.dbName },
        { name: 'VARLENS_OPS_OWNER_ROLE', value: plan.ownerRole },
        { name: 'VARLENS_OPS_MIGRATOR_ROLE', value: plan.migratorRole },
        { name: 'VARLENS_OPS_APP_ROLE', value: plan.appRole },
      ],
      script: VARLENS_USER_PRUNE_SCRIPT,
    });
    const job = await this.waitForLifecycleJob(target, jobName, 120_000);
    await this.kubernetes.deleteJob(target.namespace, jobName);
    if (job.status?.failed) {
      throw new Error(`Entfernungs-Job ${jobName} ist fehlgeschlagen.`);
    }

    await this.kubernetes.deleteSecret(target.namespace, plan.secretName);
    await this.kubernetes.patchSecret(target.namespace, WORKSPACE_DB_URLS_SECRET, {
      data: { [plan.secretRef]: null },
    });

    return {
      summary: `VarLens-Nutzer ${username} und dessen Workspace-Datenbank wurden entfernt.`,
      evidence: [
        { label: 'Benutzer', value: username },
        { label: 'Workspace-Datenbank', value: plan.dbName },
        { label: 'Workspace-Secret', value: plan.secretName },
        { label: 'Umfang', value: 'operational prune; keine Infra-Löschung' },
      ],
    };
  }

  private async createVarLensLifecycleJob(
    target: TargetConfig,
    options: {
      readonly jobName: string;
      readonly operation: 'create' | 'block' | 'prune';
      readonly username: string;
      readonly actor: string;
      readonly env: readonly Record<string, unknown>[];
      readonly script: string;
      readonly secretName?: string;
    },
  ): Promise<void> {
    await this.kubernetes.deleteJob(target.namespace, options.jobName);
    const runtime = await this.kubernetes.getPath<DeploymentRuntimeLike>(
      `/apis/apps/v1/namespaces/${target.namespace}/deployments/${target.deployment}`,
    );
    const podSpec = runtime.spec?.template?.spec;
    const image = podSpec?.containers?.find((container) =>
      ['varlens', target.serviceName].includes(container.name || ''),
    )?.image;
    if (!image) {
      throw new Error('VarLens-Image konnte nicht aus dem Deployment gelesen werden.');
    }

    await this.kubernetes.createJob(target.namespace, {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: options.jobName,
        labels: varlensUserJobLabels(target, options.username, options.operation),
        annotations: {
          'ops.robspan.net/created-by': options.actor,
          'ops.robspan.net/created-at': new Date().toISOString(),
        },
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 600,
        template: {
          metadata: {
            labels: varlensUserJobLabels(target, options.username, options.operation),
          },
          spec: {
            restartPolicy: 'Never',
            serviceAccountName: podSpec?.serviceAccountName || target.serviceName,
            imagePullSecrets: podSpec?.imagePullSecrets || [],
            containers: [
              {
                name: 'varlens-user-lifecycle',
                image,
                command: ['/usr/bin/tini', '--', '/usr/bin/bash', '-lc'],
                args: [options.script],
                env: [
                  ...varlensRuntimeEnv(options.secretName),
                  ...options.env,
                ],
                volumeMounts: options.secretName
                  ? [
                      {
                        name: 'varlens-ops-user-credential',
                        mountPath: '/var/run/varlens/ops-user',
                        readOnly: true,
                      },
                    ]
                  : [],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ['ALL'] },
                },
              },
            ],
            volumes: options.secretName
              ? [
                  {
                    name: 'varlens-ops-user-credential',
                    secret: { secretName: options.secretName },
                  },
                ]
              : [],
          },
        },
      },
    });
  }

  private async waitForLifecycleJob(
    target: TargetConfig,
    jobName: string,
    timeoutMs: number,
  ): Promise<JobLike> {
    const deadline = Date.now() + timeoutMs;
    let latest = await this.kubernetes.job(target, jobName);
    while (!isFinishedJob(latest) && Date.now() < deadline) {
      await sleep(1_000);
      latest = await this.kubernetes.job(target, jobName);
    }
    return latest;
  }

  private async appHealth(
    target: TargetConfig,
    contract: AppOperationsContract,
    inputs: Record<string, string>,
  ) {
    const timeoutMs =
      validateSeconds(inputs.timeoutSeconds, 'timeoutSeconds') * 1000;
    const [deployment, pods, argo, liveEndpoint, readyEndpoint] =
      await Promise.all([
        this.kubernetes.deployment(target),
        this.kubernetes.pods(target),
        this.argo
          .application(target)
          .catch((error) => ({ error: message(error) })),
        this.checkUrl(contract.endpoints.livenessUrl, timeoutMs),
        this.checkUrl(contract.endpoints.readinessUrl, timeoutMs),
      ]);
    const readyPods = pods.filter(
      (pod) => pod.status?.phase === 'Running',
    ).length;
    const argoHealth =
      'error' in argo ? argo.error : argo.status?.health?.status || null;
    const argoSync =
      'error' in argo ? argo.error : argo.status?.sync?.status || null;
    return {
      summary: `${readyPods}/${pods.length} Pods laufen; Readiness ${readyEndpoint.ok ? 'ok' : 'fehlgeschlagen'}.`,
      evidence: [
        { label: 'Namespace', value: target.namespace },
        {
          label: 'Deployment: bereite Replicas',
          value: deployment.status?.readyReplicas ?? 0,
        },
        {
          label: 'Deployment: Replicas gesamt',
          value: deployment.status?.replicas ?? 0,
        },
        { label: 'Pods laufend', value: readyPods },
        { label: 'Liveness-URL', value: contract.endpoints.livenessUrl },
        { label: 'Liveness-Status', value: liveEndpoint.status },
        { label: 'Readiness-URL', value: contract.endpoints.readinessUrl },
        { label: 'Readiness-Status', value: readyEndpoint.status },
        { label: 'ArgoCD-Health', value: argoHealth },
        { label: 'ArgoCD-Sync', value: argoSync },
      ],
    };
  }

  private async diagnoseTarget(
    target: TargetConfig,
    contract: AppOperationsContract,
    inputs: Record<string, string>,
    principal: OpsPrincipal,
    progress?: DiagnosisProgress,
  ): Promise<ActionOutput> {
    const timeoutMs =
      validateSeconds(inputs.timeoutSeconds, 'timeoutSeconds') * 1000;
    const publicHealthUrl = contract.endpoints.publicHealthUrl;
    const [
      freshSmoke,
      deployment,
      pods,
      argo,
      smokeJobs,
      liveness,
      readiness,
      publicHealth,
      prometheusMetrics,
      lokiLogs,
    ] = await Promise.all([
      captureDiagnosisStep(
        'smoke-run',
        'Automatischen Funktionstest ausführen',
        () => this.runFreshSmoke(target, contract, principal.user),
        progress,
      ),
      captureDiagnosisStep(
        'deployment',
        'App-Startzustand prüfen',
        () => this.kubernetes.deployment(target),
        progress,
      ),
      captureDiagnosisStep(
        'pods',
        'Laufende App-Instanzen prüfen',
        () => this.kubernetes.pods(target),
        progress,
      ),
      captureDiagnosisStep(
        'argocd',
        'Ausgerollten Stand prüfen',
        () => this.argo.application(target),
        progress,
      ),
      captureDiagnosisStep(
        'smoke-jobs',
        'Letzte Funktionstests prüfen',
        () => this.kubernetes.jobs(target),
        progress,
      ),
      captureDiagnosisStep(
        'liveness',
        'App-Prozess intern prüfen',
        () => this.checkUrl(contract.endpoints.livenessUrl, timeoutMs),
        progress,
      ),
      captureDiagnosisStep(
        'readiness',
        'App-Bereitschaft intern prüfen',
        () => this.checkUrl(contract.endpoints.readinessUrl, timeoutMs),
        progress,
      ),
      publicHealthUrl
        ? captureDiagnosisStep(
            'public-health',
            'Nutzer-Erreichbarkeit prüfen',
            () => this.checkUrl(publicHealthUrl, timeoutMs),
            progress,
          )
        : skipDiagnosisStep<EndpointProbe>(
            'public-health',
            'Öffentlichen Endpunkt prüfen',
            'Keine öffentliche Health-URL konfiguriert.',
            progress,
          ),
      contract.observability.prometheusBaseUrl
        ? captureDiagnosisStep(
            'prometheus',
            'Betriebssignale prüfen',
            () => this.prometheus.contractMetrics(contract, timeoutMs),
            progress,
          )
        : skipDiagnosisStep<readonly PrometheusMetricObservation[]>(
            'prometheus',
            'Prometheus-Signale lesen',
            'Keine Prometheus-URL konfiguriert.',
            progress,
          ),
      contract.observability.lokiBaseUrl
        ? captureDiagnosisStep(
            'loki',
            'Fehlerhinweise prüfen',
            () => this.loki.logSummary(contract, timeoutMs),
            progress,
          )
        : skipDiagnosisStep<LokiLogObservation | undefined>(
            'loki',
            'Log-Summary lesen',
            'Keine Loki-URL konfiguriert.',
            progress,
          ),
    ]);
    const collectionErrors = [
      collectionError('Deployment', deployment),
      collectionError('Pods', pods),
      collectionError('ArgoCD', argo),
      collectionError('Smoke-Run', freshSmoke),
      collectionError('Smoke-Jobs', smokeJobs),
      collectionError('Liveness', liveness),
      collectionError('Readiness', readiness),
      collectionError('Public Health', publicHealth),
      collectionError('Prometheus', prometheusMetrics),
      collectionError('Loki', lokiLogs),
    ].filter((item): item is ActionEvidence => Boolean(item));

    const facts: DiagnosisFacts = {
      argo: argo.value,
      deployment: deployment.value,
      pods: pods.value || [],
      smokeJobs: freshSmoke.value
        ? [...(smokeJobs.value || []), freshSmoke.value]
        : smokeJobs.value || [],
      endpoints: {
        liveness: liveness.value,
        readiness: readiness.value,
        publicHealth: publicHealth.value,
      },
      observability: {
        metrics: prometheusMetrics.value || [],
        logs: lokiLogs.value,
      },
      collectionErrors,
    };
    const diagnosis = buildDiagnosisReport(contract, facts, principal.roles);
    const criticalCount = diagnosis.findings.filter(
      (finding) => finding.severity === 'critical',
    ).length;
    const warningCount = diagnosis.findings.filter(
      (finding) => finding.severity === 'warning',
    ).length;

    return {
      summary: `${diagnosis.findings.length} Befund(e): ${criticalCount} kritisch, ${warningCount} Warnung(en).`,
      evidence: [
        { label: 'Ziel', value: `${contract.app}/${contract.environment}` },
        { label: 'Befunde', value: diagnosis.findings.length },
        { label: 'Kritisch', value: criticalCount },
        { label: 'Warnungen', value: warningCount },
        ...diagnosis.findings.slice(0, 8).map((finding) => ({
          label: finding.findingId,
          value: finding.summary,
        })),
      ],
      diagnosis,
    };
  }

  private async runFreshSmoke(
    target: TargetConfig,
    contract: AppOperationsContract,
    actor: string,
  ): Promise<JobLike> {
    if (!contract.smoke.triggerAllowed) {
      throw new BadRequestException(
        'Smoke-Auslösung ist laut App-Vertrag nicht erlaubt.',
      );
    }
    const jobName = await this.kubernetes.createSmokeJob(target, actor);
    return this.waitForSmokeJob(target, jobName);
  }

  private async waitForSmokeJob(
    target: TargetConfig,
    jobName: string,
  ): Promise<JobLike> {
    const deadline = Date.now() + 15_000;
    let latest = await this.kubernetes.job(target, jobName);
    while (!isFinishedJob(latest) && Date.now() < deadline) {
      await sleep(1_000);
      latest = await this.kubernetes.job(target, jobName);
    }
    return latest;
  }

  private async argoStatus(
    target: TargetConfig,
    contract: AppOperationsContract,
    inputs: Record<string, string>,
  ) {
    const detailLevel = validateOption(
      inputs.detailLevel,
      ['summary', 'resources'],
      'detailLevel',
    );
    const resourceLimit = validateNumberOption(
      inputs.resourceLimit,
      [5, 10, 20],
      'resourceLimit',
    );
    const app = await this.argo.application(target);
    const resourceEvidence =
      detailLevel === 'resources'
        ? (app.status?.resources || [])
            .slice(0, resourceLimit)
            .map((resource) => ({
              label: `Ressource ${resource.kind || 'unbekannt'}/${resource.name || 'unbekannt'}`,
              value: `${resource.status || 'unbekannt'}; Health=${resource.health?.status || 'unbekannt'}`,
            }))
        : [];
    return {
      summary: `${target.argoApplication}: Sync ${app.status?.sync?.status || 'unbekannt'} / Health ${app.status?.health?.status || 'unbekannt'}.`,
      evidence: [
        { label: 'Anwendung', value: target.argoApplication },
        { label: 'Sync-Status', value: app.status?.sync?.status || null },
        { label: 'Health-Status', value: app.status?.health?.status || null },
        { label: 'Revision', value: app.status?.sync?.revision || null },
        {
          label: 'Operation',
          value: app.status?.operationState?.phase || null,
        },
        { label: 'ArgoCD-Link', value: contract.argo.publicUrl || null },
        ...resourceEvidence,
      ],
    };
  }

  private async endpointCheck(
    contract: AppOperationsContract,
    inputs: Record<string, string>,
  ) {
    const endpointScope = validateOption(
      inputs.endpointScope,
      ['both', 'internal', 'public'],
      'endpointScope',
    );
    const timeoutMs =
      validateSeconds(inputs.timeoutSeconds, 'timeoutSeconds') * 1000;
    const urls = endpointUrls(contract, endpointScope);
    const results = await Promise.all(
      urls.map((url) => this.checkUrl(url, timeoutMs)),
    );
    return {
      summary: `${results.filter((result) => result.ok).length}/${results.length} Endpunkte lieferten HTTP 2xx.`,
      evidence: results.map((result) => ({
        label: result.url,
        value: result.ok
          ? `${result.status} ${result.durationMs}ms`
          : result.error || result.status,
      })),
    };
  }

  private async podSummary(
    target: TargetConfig,
    inputs: Record<string, string>,
  ) {
    const eventLimit = validateNumberOption(
      inputs.eventLimit,
      [4, 8, 12, 20],
      'eventLimit',
    );
    const podLimit = validateNumberOption(
      inputs.podLimit,
      [5, 10, 20],
      'podLimit',
    );
    const [pods, events] = await Promise.all([
      this.kubernetes.pods(target),
      this.kubernetes.events(target),
    ]);
    const visiblePods = pods.slice(0, podLimit);
    const visibleEvents = events.slice(-eventLimit);
    return {
      summary: `${pods.length} Pods und ${events.length} aktuelle Namespace-Events gefunden; angezeigt werden ${visiblePods.length} Pods und ${visibleEvents.length} Events.`,
      evidence: [
        ...visiblePods.map((pod) => ({
          label: `Pod ${pod.metadata?.name || 'unbekannt'}`,
          value: `${pod.status?.phase || 'unbekannt'}; Neustarts=${restartCount(pod)}`,
        })),
        ...visibleEvents.map((event) => ({
          label: `Event ${event.reason || 'unbekannt'}`,
          value: truncate(event.message || '', 180),
        })),
      ],
    };
  }

  private async logSummary(
    target: TargetConfig,
    contract: AppOperationsContract,
    inputs: Record<string, string>,
  ) {
    const tailLines = validateTailLines(inputs.tailLines || '80');
    const podSelection = validateOption(
      inputs.podSelection,
      ['running-first', 'newest', 'oldest'],
      'podSelection',
    );
    const previous = validateBooleanInput(inputs.previous, 'previous');
    const pods = await this.kubernetes.pods(target);
    const pod = selectPod(pods, podSelection);
    if (!pod?.metadata?.name) {
      throw new Error('Kein Pod zum Lesen der Logs gefunden.');
    }
    const logs = await this.kubernetes.logs(
      target,
      pod.metadata.name,
      tailLines,
      previous,
    );
    return {
      summary: `Letzte ${tailLines} Log-Zeilen von ${pod.metadata.name} gelesen.`,
      evidence: [
        { label: 'Pod', value: pod.metadata.name },
        { label: 'Zeilen', value: tailLines },
        { label: 'Pod-Auswahl', value: podSelection },
        { label: 'Vorheriger Container', value: previous },
        { label: 'Loki-Query', value: contract.observability.loki.sampleQuery },
        {
          label: 'Log-Pflichtfelder',
          value: contract.observability.loki.requiredFields.join(', '),
        },
        { label: 'Logs', value: redact(truncate(logs, 5000)) },
      ],
    };
  }

  private async smokeResult(
    target: TargetConfig,
    contract: AppOperationsContract,
    inputs: Record<string, string>,
  ) {
    const jobLimit = validateNumberOption(
      inputs.jobLimit,
      [5, 10, 20],
      'jobLimit',
    );
    const jobs = await this.kubernetes.jobs(target);
    const visibleJobs = [...jobs].sort(compareCreatedAt).slice(-jobLimit);
    return {
      summary: `${jobs.length} Smoke-Jobs gefunden; angezeigt werden ${visibleJobs.length}.`,
      evidence: [
        { label: 'Smoke-Selector', value: contract.smoke.jobLabelSelector },
        { label: 'Kernchecks', value: contract.smoke.coreChecks.join(', ') },
        ...visibleJobs.map((job) => ({
          label: job.metadata?.name || 'Job',
          value: job.status?.succeeded
            ? 'erfolgreich'
            : job.status?.failed
              ? 'fehlgeschlagen'
              : job.status?.active
                ? 'aktiv'
                : 'unbekannt',
        })),
      ],
    };
  }

  private observabilityLinks(contract: AppOperationsContract) {
    const metricEvidence = contract.observability.prometheusMetrics.map(
      (metric) => ({
        label: `Prometheus: ${metric.name}`,
        value: metric.sampleQuery,
      }),
    );
    const dashboardEvidence = contract.observability.grafanaDashboards.map(
      (dashboard) => ({
        label: `Grafana: ${dashboard.label}`,
        value: dashboard.url,
      }),
    );

    return {
      summary: `Standardisierte Observability-Quellen für ${contract.app}/${contract.environment} zusammengestellt.`,
      evidence: [
        {
          label: 'Prometheus',
          value: contract.observability.prometheusBaseUrl || null,
        },
        { label: 'Loki', value: contract.observability.lokiBaseUrl || null },
        { label: 'Loki-Query', value: contract.observability.loki.sampleQuery },
        {
          label: 'ArgoCD',
          value: contract.argo.publicUrl || contract.argo.application,
        },
        {
          label: 'Eskalationsfelder',
          value: contract.firstLevel.escalationFields.join(', '),
        },
        ...dashboardEvidence,
        ...metricEvidence,
      ],
    };
  }

  private async platformOverview(
    target: TargetConfig,
    contract: AppOperationsContract,
    inputs: Record<string, string>,
  ) {
    const [health, argo, smoke] = await Promise.all([
      this.appHealth(target, contract, inputs),
      this.argoStatus(target, contract, {
        detailLevel: 'summary',
        resourceLimit: '10',
      }).catch((error) => ({
        summary: `ArgoCD konnte nicht gelesen werden: ${message(error)}`,
        evidence: [{ label: 'ArgoCD-Fehler', value: message(error) }],
      })),
      this.smokeResult(target, contract, { jobLimit: '5' }).catch((error) => ({
        summary: `Smoke-Status konnte nicht gelesen werden: ${message(error)}`,
        evidence: [{ label: 'Smoke-Fehler', value: message(error) }],
      })),
    ]);
    return {
      summary: `Betriebsüberblick für ${target.namespace}: ${health.summary}`,
      evidence: [
        { label: 'Namespace', value: target.namespace },
        { label: 'Deployment', value: target.deployment },
        { label: 'Service', value: target.serviceName },
        { label: 'App-Status', value: health.summary },
        { label: 'GitOps-Status', value: argo.summary },
        { label: 'Smoke-Status', value: smoke.summary },
        ...health.evidence.slice(0, 8),
        ...argo.evidence.slice(0, 6),
        ...smoke.evidence.slice(0, 6),
      ],
    };
  }

  private async dataStoreStatus(target: TargetConfig) {
    const clusterName = `${target.serviceName}-postgres`;
    const cluster = await capture(() =>
      this.kubernetes.getPath<ClusterLike>(
        `/apis/postgresql.cnpg.io/v1/namespaces/${target.namespace}/clusters/${clusterName}`,
      ),
    );
    if (cluster.error || !cluster.value) {
      return {
        summary: `Datenbank-Cluster ${clusterName} konnte nicht gelesen werden.`,
        evidence: [
          { label: 'Cluster', value: clusterName },
          { label: 'Fehler', value: cluster.error || 'nicht gefunden' },
        ],
      };
    }

    const status = cluster.value.status || {};
    const conditions = (status.conditions || [])
      .map((condition) =>
        [condition.type, condition.status, condition.reason]
          .filter(Boolean)
          .join('='),
      )
      .filter(Boolean)
      .join(', ');
    return {
      summary: `Datenbank-Cluster ${clusterName}: ${status.phase || 'unbekannt'}; ${status.readyInstances ?? 0}/${cluster.value.spec?.instances ?? status.instances ?? 0} Instanzen bereit.`,
      evidence: [
        { label: 'Namespace', value: target.namespace },
        { label: 'Cluster', value: cluster.value.metadata?.name || clusterName },
        { label: 'Phase', value: status.phase || null },
        { label: 'Instanzen', value: cluster.value.spec?.instances ?? status.instances ?? null },
        { label: 'Bereite Instanzen', value: status.readyInstances ?? null },
        { label: 'Aktueller Primary', value: status.currentPrimary || null },
        { label: 'Ziel-Primary', value: status.targetPrimary || null },
        { label: 'Conditions', value: conditions || null },
        {
          label: 'Datenschutzgrenze',
          value: 'Nur Cluster-Metadaten; keine Tabellen, Dumps, Zugangsdaten oder Nutzdaten.',
        },
      ],
    };
  }

  private async ingressStatus(
    target: TargetConfig,
    contract: AppOperationsContract,
  ) {
    const [ingresses, certificates] = await Promise.all([
      capture(() =>
        this.kubernetes.getPath<KubernetesListLike<IngressLike>>(
          `/apis/networking.k8s.io/v1/namespaces/${target.namespace}/ingresses`,
        ),
      ),
      capture(() =>
        this.kubernetes.getPath<KubernetesListLike<CertificateLike>>(
          `/apis/cert-manager.io/v1/namespaces/${target.namespace}/certificates`,
        ),
      ),
    ]);
    const ingressItems = ingresses.value?.items || [];
    const certificateItems = certificates.value?.items || [];
    const hosts = ingressItems.flatMap((ingress) =>
      (ingress.spec?.rules || []).map((rule) => rule.host).filter(Boolean),
    );
    const tlsRefs = ingressItems.flatMap((ingress) =>
      (ingress.spec?.tls || []).map((tls) =>
        [tls.secretName, ...(tls.hosts || [])].filter(Boolean).join(' -> '),
      ),
    );
    const certEvidence = certificateItems.map((certificate) => ({
      label: `Zertifikat ${certificate.metadata?.name || 'unbekannt'}`,
      value: certificateStatus(certificate),
    }));
    return {
      summary: `${ingressItems.length} Ingress(e), ${certificateItems.length} Zertifikat(e) in ${target.namespace}.`,
      evidence: [
        { label: 'Öffentliche Health-URL', value: contract.endpoints.publicHealthUrl || null },
        { label: 'Ingress-Fehler', value: ingresses.error || null },
        { label: 'Zertifikat-Fehler', value: certificates.error || null },
        { label: 'Hosts', value: hosts.length ? hosts.join(', ') : null },
        { label: 'TLS-Referenzen', value: tlsRefs.length ? tlsRefs.join(', ') : null },
        ...ingressItems.map((ingress) => ({
          label: `Ingress ${ingress.metadata?.name || 'unbekannt'}`,
          value: ingress.spec?.ingressClassName || 'ohne explizite Klasse',
        })),
        ...certEvidence,
      ].filter((item) => item.value !== null),
    };
  }

  private async backupStatus(target: TargetConfig) {
    const [backups, scheduledBackups] = await Promise.all([
      capture(() =>
        this.kubernetes.getPath<KubernetesListLike<BackupLike>>(
          `/apis/postgresql.cnpg.io/v1/namespaces/${target.namespace}/backups`,
        ),
      ),
      capture(() =>
        this.kubernetes.getPath<KubernetesListLike<BackupLike>>(
          `/apis/postgresql.cnpg.io/v1/namespaces/${target.namespace}/scheduledbackups`,
        ),
      ),
    ]);
    const backupItems = backups.value?.items || [];
    const scheduledItems = scheduledBackups.value?.items || [];
    const latestBackup = [...backupItems].sort(compareCreatedAt).at(-1);
    return {
      summary: `${backupItems.length} Backup-CR(s), ${scheduledItems.length} ScheduledBackup-CR(s) in ${target.namespace}.`,
      evidence: [
        { label: 'Namespace', value: target.namespace },
        { label: 'Backup-Fehler', value: backups.error || null },
        { label: 'ScheduledBackup-Fehler', value: scheduledBackups.error || null },
        { label: 'Backups', value: backupItems.length },
        { label: 'ScheduledBackups', value: scheduledItems.length },
        {
          label: 'Letztes Backup',
          value: latestBackup
            ? `${latestBackup.metadata?.name || 'unbekannt'}: ${latestBackup.status?.phase || 'unbekannt'}`
            : null,
        },
        ...scheduledItems.slice(0, 5).map((backup) => ({
          label: `Plan ${backup.metadata?.name || 'unbekannt'}`,
          value: backup.spec?.cluster?.name || target.serviceName,
        })),
        {
          label: 'Datenschutzgrenze',
          value: 'Nur Backup-Objektstatus; keine Backup-Inhalte, Dumps oder Wiederherstellung.',
        },
      ].filter((item) => item.value !== null),
    };
  }

  private observabilityStatus(contract: AppOperationsContract) {
    const metrics = contract.observability.prometheusMetrics.map((metric) => metric.name);
    return {
      summary: `${metrics.length} Prometheus-Metriken, ${contract.observability.grafanaDashboards.length} Dashboard(s), Loki ${contract.observability.lokiBaseUrl ? 'konfiguriert' : 'nicht konfiguriert'}.`,
      evidence: [
        {
          label: 'Prometheus',
          value: contract.observability.prometheusBaseUrl ? 'konfiguriert' : 'nicht konfiguriert',
        },
        {
          label: 'Prometheus-Metriken',
          value: metrics.length ? metrics.join(', ') : null,
        },
        {
          label: 'Loki',
          value: contract.observability.lokiBaseUrl ? 'konfiguriert' : 'nicht konfiguriert',
        },
        {
          label: 'Log-Pflichtfelder',
          value: contract.observability.loki.requiredFields.join(', '),
        },
        {
          label: 'Dashboards',
          value: contract.observability.grafanaDashboards
            .map((dashboard) => dashboard.label)
            .join(', ') || null,
        },
        {
          label: 'Eskalationsfelder',
          value: contract.firstLevel.escalationFields.join(', '),
        },
      ],
    };
  }

  private async argoSync(
    target: TargetConfig,
    contract: AppOperationsContract,
  ) {
    const app = await this.argo.sync(target);
    return {
      summary: `Sync (ohne Prune) für ${target.argoApplication} angefordert.`,
      evidence: [
        { label: 'Anwendung', value: target.argoApplication },
        { label: 'Prune', value: false },
        { label: 'ArgoCD-Link', value: contract.argo.publicUrl || null },
        {
          label: 'Operation',
          value: app.status?.operationState?.phase || 'angefordert',
        },
      ],
    };
  }

  private async checkUrl(
    url: string,
    timeoutMs: number,
  ): Promise<{
    url: string;
    ok: boolean;
    status: number | string;
    durationMs: number;
    error?: string;
  }> {
    const started = Date.now();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return {
        url,
        ok: response.ok,
        status: response.status,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        url,
        ok: false,
        status: 'error',
        durationMs: Date.now() - started,
        error: message(error),
      };
    }
  }

  private logRun(
    run: ActionRunResult,
    event: string,
    durationMs: number,
  ): void {
    console.log(
      JSON.stringify({
        event: 'operation_action_run',
        phase: event,
        run_id: run.runId,
        action_id: run.actionId,
        actor_hash: hashValue(run.actor),
        role: run.role,
        target: `${run.targetApp}/${run.targetEnvironment}`,
        status: run.status,
        duration_ms: durationMs,
      }),
    );
  }
}

function validateEnvironment(value: string): TargetEnvironment {
  if (value === 'dev' || value === 'test') {
    return value;
  }
  throw new BadRequestException('Zielumgebung muss dev oder test sein.');
}

function validateTailLines(value: string): number {
  if (!['40', '80', '120'].includes(value)) {
    throw new BadRequestException('tailLines muss 40, 80 oder 120 sein.');
  }
  return Number(value);
}

function validateOption<T extends string>(
  value: string,
  allowed: readonly T[],
  inputName: string,
): T {
  if (!allowed.includes(value as T)) {
    throw new BadRequestException(
      `Eingabe ${inputName} muss eine von ${allowed.join(', ')} sein.`,
    );
  }
  return value as T;
}

function validateNumberOption(
  value: string,
  allowed: readonly number[],
  inputName: string,
): number {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || !allowed.includes(numberValue)) {
    throw new BadRequestException(
      `Eingabe ${inputName} muss eine von ${allowed.join(', ')} sein.`,
    );
  }
  return numberValue;
}

function validateSeconds(value: string, inputName: string): number {
  return validateNumberOption(value, [3, 8, 15], inputName);
}

function validateBooleanInput(value: string, inputName: string): boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new BadRequestException(
    `Eingabe ${inputName} muss true oder false sein.`,
  );
}

function endpointUrls(
  contract: AppOperationsContract,
  scope: 'both' | 'internal' | 'public',
): string[] {
  const urls: string[] = [];
  if (scope === 'both' || scope === 'internal') {
    urls.push(contract.endpoints.readinessUrl);
  }
  if (scope === 'both' || scope === 'public') {
    if (!contract.endpoints.publicHealthUrl) {
      throw new BadRequestException(
        'Für dieses Ziel ist keine öffentliche URL konfiguriert.',
      );
    }
    urls.push(contract.endpoints.publicHealthUrl);
  }
  return urls;
}

function selectPod<T extends PodLike>(
  pods: readonly T[],
  selection: 'running-first' | 'newest' | 'oldest',
): T | undefined {
  if (selection === 'running-first') {
    return (
      pods.find((candidate) => candidate.status?.phase === 'Running') || pods[0]
    );
  }
  const sorted = [...pods].sort(compareCreatedAt);
  return selection === 'newest' ? sorted.at(-1) : sorted[0];
}

function isFinishedJob(job: JobLike): boolean {
  return Boolean(job.status?.succeeded || job.status?.failed);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compareCreatedAt(
  left: CreatedResource,
  right: CreatedResource,
): number {
  return createdAtMs(left) - createdAtMs(right);
}

function createdAtMs(resource: CreatedResource): number {
  const timestamp = resource.metadata?.creationTimestamp;
  return timestamp ? Date.parse(timestamp) || 0 : 0;
}

function restartCount(pod: {
  status?: { containerStatuses?: readonly { restartCount?: number }[] };
}): number {
  return (pod.status?.containerStatuses || []).reduce(
    (sum, status) => sum + (status.restartCount || 0),
    0,
  );
}

function certificateStatus(certificate: CertificateLike): string {
  const ready = (certificate.status?.conditions || []).find(
    (condition) => condition.type === 'Ready',
  );
  return [
    ready ? `Ready=${ready.status}` : 'Ready=unbekannt',
    ready?.reason,
    certificate.status?.notAfter ? `bis ${certificate.status.notAfter}` : null,
    certificate.status?.renewalTime
      ? `Erneuerung ${certificate.status.renewalTime}`
      : null,
  ]
    .filter(Boolean)
    .join('; ');
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function redact(value: string): string {
  return value
    .replace(/(password|token|secret|authorization)=\S+/gi, '$1=<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <redacted>');
}

async function capture<T>(load: () => Promise<T>): Promise<Captured<T>> {
  try {
    return { value: await load() };
  } catch (error) {
    return { error: message(error) };
  }
}

async function captureDiagnosisStep<T>(
  stepId: string,
  label: string,
  load: () => Promise<T>,
  progress?: DiagnosisProgress,
): Promise<Captured<T>> {
  await progress?.({ stepId, label, status: 'running' });
  const result = await capture(load);
  await progress?.({
    stepId,
    label,
    status: result.error ? 'failed' : 'succeeded',
    detail: result.error,
  });
  return result;
}

function skipDiagnosisStep<T>(
  stepId: string,
  label: string,
  detail: string,
  progress?: DiagnosisProgress,
): Promise<Captured<T>> {
  void stepId;
  void label;
  void detail;
  void progress;
  return Promise.resolve({});
}

function configuredDiagnosisStepCount(contract: AppOperationsContract): number {
  const alwaysConfigured = 7;
  return (
    alwaysConfigured +
    (contract.endpoints.publicHealthUrl ? 1 : 0) +
    (contract.observability.prometheusBaseUrl ? 1 : 0) +
    (contract.observability.lokiBaseUrl ? 1 : 0)
  );
}

function staggerDiagnosisProgress(
  emit: (step: DiagnosisStepEvent) => void,
  totalSteps: number,
): DiagnosisProgress {
  const startedAt = Date.now();
  let completedSteps = 0;
  return async (step) => {
    if (step.status === 'running') {
      emit(step);
      return;
    }

    completedSteps += 1;
    const targetOffsetMs = Math.round(
      (completedSteps / Math.max(totalSteps, 1)) * DIAGNOSIS_STEP_SPREAD_MS,
    );
    const waitMs = Math.max(0, startedAt + targetOffsetMs - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    emit(step);
  };
}

function collectionError<T>(
  label: string,
  captured: Captured<T>,
): ActionEvidence | undefined {
  return captured.error ? { label, value: captured.error } : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function hashValue(value: string): string {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16);
}

function validateRequired(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new BadRequestException(`input ${name} is required`);
  }
  return value.trim();
}

function validateVarLensUsername(value: string | undefined): string {
  const username = validateRequired(value, 'username');
  if (!/^[A-Za-z0-9._@+-]{1,100}$/.test(username)) {
    throw new BadRequestException('VarLens-Benutzername ist ungültig.');
  }
  return username;
}

function generatedPassword(): string {
  return randomBytes(36).toString('base64url');
}

function safeK8sSuffix(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (normalized || 'user').slice(0, 40).replace(/^-|-$/g, '') || 'user';
}

function stableK8sSuffix(value: string): string {
  const base = safeK8sSuffix(value).slice(0, 31).replace(/^-|-$/g, '') || 'user';
  return `${base}-${sha256(value).slice(0, 8)}`;
}

function stablePgSuffix(value: string): string {
  const normalized =
    value
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') || 'user';
  return `${normalized.slice(0, 32).replace(/^_|_$/g, '') || 'user'}_${sha256(value).slice(0, 8)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function varlensUserDbPlan(username: string): {
  readonly dbName: string;
  readonly ownerRole: string;
  readonly migratorRole: string;
  readonly appRole: string;
  readonly secretName: string;
  readonly secretRef: string;
} {
  const suffix = stablePgSuffix(username);
  const k8sSuffix = stableK8sSuffix(username);
  return {
    dbName: `varlens_user_${suffix}`,
    ownerRole: `varlens_user_${suffix}_owner`,
    migratorRole: `varlens_user_${suffix}_migrator`,
    appRole: `varlens_user_${suffix}_app_rw`,
    secretName: `varlens-workspace-db-${k8sSuffix}`,
    secretRef: `varlens-user-${k8sSuffix}.pgurl`,
  };
}

function postgresUrl(role: string, password: string, dbName: string): string {
  return `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@varlens-postgres-rw:5432/${encodeURIComponent(dbName)}`;
}

function lifecycleJobName(
  operation: 'create' | 'block' | 'prune',
  username: string,
): string {
  return `varlens-ops-user-${operation}-${stableK8sSuffix(username)}`.slice(0, 63);
}

function varlensUserJobLabels(
  target: TargetConfig,
  username: string,
  operation: 'create' | 'block' | 'prune',
): Record<string, string> {
  return {
    'app.kubernetes.io/name': target.serviceName,
    'app.kubernetes.io/component': 'user-lifecycle',
    'platform.robspan.net/app': target.app,
    'platform.robspan.net/environment': target.environment,
    'ops.robspan.net/operation': operation,
    'ops.robspan.net/user-hash': sha256(username).slice(0, 16),
  };
}

function varlensUserSecretLabels(
  target: TargetConfig,
  username: string,
): Record<string, string> {
  return {
    'app.kubernetes.io/name': target.serviceName,
    'app.kubernetes.io/component': 'workspace-db',
    'platform.robspan.net/app': target.app,
    'platform.robspan.net/environment': target.environment,
    'ops.robspan.net/user-hash': sha256(username).slice(0, 16),
  };
}

function varlensRuntimeEnv(secretName?: string): readonly Record<string, unknown>[] {
  const env: Record<string, unknown>[] = [
    { name: 'NODE_ENV', value: 'production' },
    { name: 'VARLENS_PG_SCHEMA', value: 'public' },
    { name: 'VARLENS_WEB_DB_TOPOLOGY', value: 'hosted' },
    {
      name: 'VARLENS_PG_URL',
      valueFrom: { secretKeyRef: { name: 'varlens-postgres-app', key: 'uri' } },
    },
    {
      name: 'VARLENS_CONTROL_RO_PG_URL',
      valueFrom: { secretKeyRef: { name: 'varlens-postgres-app', key: 'uri' } },
    },
    {
      name: 'VARLENS_CONTROL_STATE_PG_URL',
      valueFrom: { secretKeyRef: { name: 'varlens-postgres-app', key: 'uri' } },
    },
    {
      name: 'PGHOST',
      valueFrom: {
        secretKeyRef: { name: 'varlens-postgres-superuser', key: 'host' },
      },
    },
    {
      name: 'PGPORT',
      valueFrom: {
        secretKeyRef: { name: 'varlens-postgres-superuser', key: 'port' },
      },
    },
    {
      name: 'PGUSER',
      valueFrom: {
        secretKeyRef: { name: 'varlens-postgres-superuser', key: 'username' },
      },
    },
    {
      name: 'PGPASSWORD',
      valueFrom: {
        secretKeyRef: { name: 'varlens-postgres-superuser', key: 'password' },
      },
    },
  ];
  if (secretName) {
    env.push({
      name: 'VARLENS_PRIVATE_MIGRATOR_PG_URL',
      valueFrom: {
        secretKeyRef: { name: secretName, key: 'privateMigratorUrl' },
      },
    });
  }
  return env;
}
