import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
  };
  readonly status?: {
    readonly active?: number;
    readonly failed?: number;
    readonly succeeded?: number;
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

type DiagnosisProgress = (step: DiagnosisStepEvent) => void;

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
      const output = await this.diagnoseTarget(
        target,
        contract,
        inputs,
        principal,
        (step) => emit({ type: 'step', runId, step }),
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
      case 'escalation-bundle':
        return this.escalationBundle(target, contract, inputs);
      case 'argo-sync':
        return this.argoSync(target, contract);
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
      case 'smoke-trigger': {
        if (!contract.smoke.triggerAllowed) {
          throw new BadRequestException(
            'Smoke-Auslösung ist laut App-Vertrag nicht erlaubt.',
          );
        }
        const jobName = await this.kubernetes.createSmokeJob(
          target,
          principal.user,
        );
        return {
          summary: `Smoke-Job ${jobName} erstellt.`,
          evidence: [{ label: 'Job', value: jobName }],
        };
      }
      default:
        throw new BadRequestException(`action is not implemented: ${actionId}`);
    }
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
    const freshSmoke = await captureDiagnosisStep(
      'smoke-run',
      'Smoke-Job ausführen',
      () => this.runFreshSmoke(target, contract, principal.user),
      progress,
    );
    const [
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
        'deployment',
        'Deployment lesen',
        () => this.kubernetes.deployment(target),
        progress,
      ),
      captureDiagnosisStep(
        'pods',
        'Pods lesen',
        () => this.kubernetes.pods(target),
        progress,
      ),
      captureDiagnosisStep(
        'argocd',
        'ArgoCD Status lesen',
        () => this.argo.application(target),
        progress,
      ),
      captureDiagnosisStep(
        'smoke-jobs',
        'Smoke-Jobs lesen',
        () => this.kubernetes.jobs(target),
        progress,
      ),
      captureDiagnosisStep(
        'liveness',
        'Liveness prüfen',
        () => this.checkUrl(contract.endpoints.livenessUrl, timeoutMs),
        progress,
      ),
      captureDiagnosisStep(
        'readiness',
        'Readiness prüfen',
        () => this.checkUrl(contract.endpoints.readinessUrl, timeoutMs),
        progress,
      ),
      publicHealthUrl
        ? captureDiagnosisStep(
            'public-health',
            'Öffentlichen Endpunkt prüfen',
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
            'Prometheus-Signale lesen',
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
            'Log-Summary lesen',
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
      smokeJobs: smokeJobs.value || [],
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

  private async escalationBundle(
    target: TargetConfig,
    contract: AppOperationsContract,
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
    const [health, podSummary, argo, links] = await Promise.all([
      this.appHealth(target, contract, { timeoutSeconds: '8' }),
      this.podSummary(target, {
        eventLimit: String(eventLimit),
        podLimit: String(podLimit),
      }),
      this.argoStatus(target, contract, {
        detailLevel: 'summary',
        resourceLimit: '10',
      }).catch((error) => ({
        summary: `ArgoCD-Status fehlgeschlagen: ${message(error)}`,
        evidence: [{ label: 'ArgoCD-Fehler', value: message(error) }],
      })),
      this.observabilityLinks(contract),
    ]);
    return {
      summary: `Eskalationspaket für ${target.namespace} zusammengestellt.`,
      evidence: [
        {
          label: 'Operations-Vertrag',
          value: `${contract.app}/${contract.environment}`,
        },
        { label: 'Health-Zusammenfassung', value: health.summary },
        { label: 'ArgoCD-Zusammenfassung', value: argo.summary },
        { label: 'Pods-Zusammenfassung', value: podSummary.summary },
        { label: 'Observability-Zusammenfassung', value: links.summary },
        ...health.evidence,
        ...argo.evidence,
        ...podSummary.evidence.slice(0, 12),
        ...links.evidence.slice(0, 8),
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
  progress?.({ stepId, label, status: 'running' });
  const result = await capture(load);
  progress?.({
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
  progress?.({ stepId, label, status: 'skipped', detail });
  return Promise.resolve({});
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
