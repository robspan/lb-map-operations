import { Injectable } from '@nestjs/common';
import {
  AppOperationsContract,
  TargetApp,
  TargetEnvironment,
  assertAppOperationsContract,
} from '@lb-map-operations/ops-contract';
import { OpsConfigService, TargetConfig } from '../config/ops-config.service';

const TARGET_ENVIRONMENTS: readonly TargetEnvironment[] = ['dev', 'test'];
const TARGET_APPS: readonly TargetApp[] = ['varlens'];

@Injectable()
export class AppContractsService {
  constructor(private readonly config: OpsConfigService) {}

  all(): readonly AppOperationsContract[] {
    return TARGET_APPS.flatMap((app) =>
      TARGET_ENVIRONMENTS.map((environment) => this.contract(app, environment)),
    );
  }

  contract(
    app: TargetApp,
    environment: TargetEnvironment,
  ): AppOperationsContract {
    return this.fromTarget(this.config.target(app, environment));
  }

  assertAll(): void {
    for (const contract of this.all()) {
      assertAppOperationsContract(contract);
    }
  }

  private fromTarget(target: TargetConfig): AppOperationsContract {
    const appSelector = `{namespace="${target.namespace}",app="${target.serviceName}"}`;
    const grafanaUrl = joinOptionalUrl(
      this.config.grafanaBaseUrl,
      `/d/varlens-reporting/varlens-technical-app-signals?var-environment=${target.environment}&var-namespace=${target.namespace}`,
    );
    const argoPublicUrl = joinOptionalUrl(
      this.config.argoPublicBaseUrl,
      `/applications/${target.argoApplication}`,
    );

    return {
      app: target.app,
      environment: target.environment,
      endpoints: {
        livenessPath: '/livez',
        readinessPath: '/readyz',
        healthPath: '/healthz',
        internalBaseUrl: target.internalBaseUrl,
        livenessUrl: target.internalLiveUrl,
        readinessUrl: target.internalReadyUrl,
        healthUrl: target.internalHealthUrl,
        publicHealthUrl: target.publicHealthUrl,
      },
      workload: {
        namespace: target.namespace,
        deployment: target.deployment,
        serviceName: target.serviceName,
        podSelector: target.podSelector,
        statelessRestartAllowed: true,
      },
      argo: {
        application: target.argoApplication,
        namespace: this.config.argoNamespace,
        publicUrl: argoPublicUrl,
      },
      observability: {
        prometheusBaseUrl: this.config.prometheusBaseUrl,
        prometheusMetrics: [
          {
            name: 'http_requests_total',
            description:
              'Begrenzte HTTP-Anfragerate nach Route, Methode und Status.',
            requiredLabels: [
              'app',
              'environment',
              'namespace',
              'route',
              'method',
              'status',
            ],
            sampleQuery: `sum by (route,method,status) (increase(http_requests_total{app="${target.app}",environment="${target.environment}",namespace="${target.namespace}"}[30m]))`,
          },
          {
            name: 'http_request_duration_seconds',
            description: 'HTTP-Latenz-Histogramm für nutzersichtbare Routen.',
            requiredLabels: [
              'app',
              'environment',
              'namespace',
              'route',
              'method',
            ],
            sampleQuery: `histogram_quantile(0.95, sum by (le,route) (rate(http_request_duration_seconds_bucket{app="${target.app}",environment="${target.environment}",namespace="${target.namespace}"}[5m])))`,
          },
          {
            name: 'varlens_database_healthy',
            description: 'Datenbank-Abhängigkeitsstatus von VarLens.',
            requiredLabels: ['app', 'environment', 'namespace'],
            sampleQuery: `max(varlens_database_healthy{app="${target.app}",environment="${target.environment}",namespace="${target.namespace}"})`,
          },
          {
            name: 'varlens_operation_events_total',
            description:
              'Begrenzte, supportrelevante Ergebnisse von Anwendungs-Operationen.',
            requiredLabels: [
              'app',
              'environment',
              'namespace',
              'operation',
              'result',
              'failure_class',
            ],
            sampleQuery: `sum by (operation,result,failure_class) (increase(varlens_operation_events_total{app="${target.app}",environment="${target.environment}",namespace="${target.namespace}"}[30m]))`,
          },
        ],
        lokiBaseUrl: this.config.lokiBaseUrl,
        loki: {
          selector: appSelector,
          requiredFields: [
            'request_id',
            'route',
            'status',
            'duration_ms',
            'result',
            'error_code',
            'failure_class',
          ],
          redactedFields: [
            'authorization',
            'cookie',
            'password',
            'token',
            'secret',
          ],
          sampleQuery: `${appSelector} | json | request_id != ""`,
        },
        grafanaDashboards: grafanaUrl
          ? [
              {
                label: `VarLens ${target.environment}`,
                url: grafanaUrl,
              },
            ]
          : [],
      },
      smoke: {
        jobLabelSelector: target.smokeJobLabelSelector,
        triggerAllowed: true,
        coreChecks: [
          'health-contract',
          'login-entry',
          'core-workflow',
          'upload-import',
        ],
      },
      firstLevel: {
        issueClasses: [
          'app-unreachable',
          'dependency-unhealthy',
          'oidc-login',
          'upload-import',
          'background-job',
          'release-change',
          'escalation',
        ],
        evidenceSources: [
          'http',
          'kubernetes',
          'argocd',
          'prometheus',
          'loki',
          'grafana',
          'smoke',
        ],
        escalationFields: [
          'environment',
          'time_window',
          'request_id',
          'route',
          'status',
          'operation',
          'error_code',
          'failure_class',
          'revision',
        ],
      },
    };
  }
}

function joinOptionalUrl(baseUrl: string, path: string): string | undefined {
  if (!baseUrl) {
    return undefined;
  }
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
