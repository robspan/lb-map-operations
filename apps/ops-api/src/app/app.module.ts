import { Module } from '@nestjs/common';
import { ActionRunnerService } from './actions/action-runner.service';
import { assertSafeCatalog } from './actions/action-registry';
import { RunStoreService } from './actions/run-store.service';
import { ArgoClient } from './clients/argo.client';
import { KubernetesClient } from './clients/kubernetes.client';
import { LokiClient } from './clients/loki.client';
import { PrometheusClient } from './clients/prometheus.client';
import { OpsConfigService } from './config/ops-config.service';
import { AppContractsService } from './contracts/app-contracts.service';
import { HealthController } from './controllers/health.controller';
import { MetricsController } from './controllers/metrics.controller';
import { OperationsController } from './controllers/operations.controller';
import { IdentityService } from './identity/identity.service';
import { MetricsService } from './observability/metrics.service';

@Module({
  imports: [],
  controllers: [HealthController, MetricsController, OperationsController],
  providers: [
    ActionRunnerService,
    ArgoClient,
    AppContractsService,
    KubernetesClient,
    LokiClient,
    OpsConfigService,
    PrometheusClient,
    IdentityService,
    MetricsService,
    RunStoreService,
  ],
})
export class AppModule {
  constructor(private readonly contracts: AppContractsService) {
    assertSafeCatalog();
    this.contracts.assertAll();
  }
}
