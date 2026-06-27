import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, Input, OnDestroy, ViewRef, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import {
  AppOperationsContract,
  OperationsSignalSource,
  SupportIssueClass,
} from '@lb-map-operations/ops-contract';
import { InfoButton } from './info-button';

const ISSUE_CLASS_LABELS: Record<SupportIssueClass, string> = {
  'app-unreachable': 'App nicht erreichbar',
  'dependency-unhealthy': 'Abhängigkeit ungesund',
  'oidc-login': 'Login / OIDC',
  'upload-import': 'Upload / Import',
  'background-job': 'Hintergrund-Job',
  'release-change': 'Release-/Konfigwechsel',
  escalation: 'Eskalation',
};

const SIGNAL_SOURCE_LABELS: Record<OperationsSignalSource, string> = {
  http: 'HTTP',
  kubernetes: 'Kubernetes',
  argocd: 'ArgoCD',
  prometheus: 'Prometheus',
  loki: 'Loki',
  grafana: 'Grafana',
  smoke: 'Smoke-Tests',
};

@Component({
  selector: 'app-contract-panel',
  imports: [CommonModule, MatButtonModule, InfoButton],
  templateUrl: './contract-panel.html',
  styleUrl: './contract-panel.scss',
})
export class ContractPanel implements OnDestroy {
  private readonly changeDetector = inject(ChangeDetectorRef);
  private resetTimer?: ReturnType<typeof setTimeout>;

  @Input({ required: true }) contract!: AppOperationsContract;
  copiedKey: string | null = null;

  issueClassLabel(value: SupportIssueClass): string {
    return ISSUE_CLASS_LABELS[value] || value;
  }

  signalSourceLabel(value: OperationsSignalSource): string {
    return SIGNAL_SOURCE_LABELS[value] || value;
  }

  copy(text: string, key: string): void {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        this.copiedKey = key;
        this.detect();
        if (this.resetTimer) {
          clearTimeout(this.resetTimer);
        }
        this.resetTimer = setTimeout(() => {
          this.copiedKey = null;
          this.detect();
        }, 1500);
      })
      .catch(() => {
        // Clipboard may be unavailable (e.g. insecure context); ignore silently.
      });
  }

  ngOnDestroy(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }
  }

  /** Guards against detectChanges on an already-destroyed view (e.g. user left the contract view). */
  private detect(): void {
    const ref = this.changeDetector as ViewRef;
    if (!ref.destroyed) {
      ref.detectChanges();
    }
  }
}
