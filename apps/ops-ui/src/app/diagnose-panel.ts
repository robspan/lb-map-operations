import { CommonModule } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  Input,
  OnDestroy,
  inject,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import {
  ActionEvidence,
  ActionRunResult,
  DiagnosisConfidence,
  DiagnosisFinding,
  DiagnosisSeverity,
  DiagnosisStepEvent,
  DiagnosisStepStatus,
  OpsRole,
  RemedyRisk,
  SuggestedRemedy,
  TargetApp,
  TargetEnvironment,
} from '@lb-map-operations/ops-contract';
import { Subscription, finalize } from 'rxjs';
import { InfoButton } from './info-button';
import { OpsApiService } from './ops-api.service';

const SEVERITY_ORDER: Record<DiagnosisSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const SEVERITY_LABELS: Record<DiagnosisSeverity, string> = {
  critical: 'Kritisch',
  warning: 'Warnung',
  info: 'Info',
};

const CONFIDENCE_LABELS: Record<DiagnosisConfidence, string> = {
  high: 'hoch',
  medium: 'mittel',
  low: 'niedrig',
};

const RISK_LABELS: Record<RemedyRisk, string> = {
  none: 'keins',
  low: 'gering',
  medium: 'mittel',
};

const STEP_STATUS_LABELS: Record<DiagnosisStepStatus, string> = {
  running: 'läuft',
  succeeded: 'ok',
  failed: 'Fehler',
  skipped: 'übersprungen',
};

@Component({
  selector: 'app-diagnose-panel',
  imports: [CommonModule, MatButtonModule, MatProgressBarModule, InfoButton],
  templateUrl: './diagnose-panel.html',
  styleUrl: './diagnose-panel.scss',
})
export class DiagnosePanel implements OnDestroy {
  private readonly api = inject(OpsApiService);
  private readonly changeDetector = inject(ChangeDetectorRef);

  @Input({ required: true }) app!: TargetApp;
  @Input({ required: true }) environment!: TargetEnvironment;
  @Input() roles: readonly OpsRole[] = [];

  running = false;
  error = '';
  steps: DiagnosisStepEvent[] = [];
  stepsExpanded = false;
  runs: ActionRunResult[] = [];
  selectedRun?: ActionRunResult;
  private readonly expandedFindings = new Set<string>();

  remedyRuns: Record<string, ActionRunResult> = {};
  runningRemedyId = '';
  confirmingRemedyId = '';
  private readonly expandedRemedies = new Set<string>();

  private streamSub?: Subscription;

  get findings(): readonly DiagnosisFinding[] {
    return [...(this.selectedRun?.diagnosis?.findings ?? [])].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    );
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.error = '';
    this.steps = [];
    this.running = true;
    this.streamSub?.unsubscribe();
    this.streamSub = this.api
      .streamDiagnose({ targetApp: this.app, targetEnvironment: this.environment, inputs: {} })
      .pipe(
        finalize(() => {
          this.running = false;
          this.changeDetector.detectChanges();
        })
      )
      .subscribe({
        next: (event) => {
          switch (event.type) {
            case 'started':
              this.steps = [];
              break;
            case 'step':
              this.upsertStep(event.step);
              break;
            case 'result':
              this.runs = [event.run, ...this.runs].slice(0, 15);
              this.selectedRun = event.run;
              this.remedyRuns = {};
              break;
            case 'error':
              this.error = event.message;
              break;
          }
          this.changeDetector.detectChanges();
        },
        error: () => {
          this.error = 'Diagnose konnte nicht gestartet werden.';
          this.changeDetector.detectChanges();
        },
      });
  }

  select(run: ActionRunResult): void {
    this.selectedRun = run;
    this.remedyRuns = {};
    this.expandedFindings.clear();
    this.expandedRemedies.clear();
  }

  toggleSteps(): void {
    this.stepsExpanded = !this.stepsExpanded;
  }

  toggleFinding(findingId: string): void {
    if (this.expandedFindings.has(findingId)) {
      this.expandedFindings.delete(findingId);
    } else {
      this.expandedFindings.add(findingId);
    }
  }

  findingExpanded(findingId: string): boolean {
    return this.expandedFindings.has(findingId);
  }

  remedyExpanded(remedyId: string): boolean {
    return this.expandedRemedies.has(remedyId);
  }

  toggleRemedy(remedyId: string): void {
    if (this.expandedRemedies.has(remedyId)) {
      this.expandedRemedies.delete(remedyId);
    } else {
      this.expandedRemedies.add(remedyId);
    }
  }

  /** Read-only remedies run immediately; changing ones require an explicit confirm. */
  requestRemedy(remedy: SuggestedRemedy): void {
    if (!remedy.enabled || this.runningRemedyId) {
      return;
    }
    if (remedy.risk !== 'none' && this.confirmingRemedyId !== remedy.remedyId) {
      this.confirmingRemedyId = remedy.remedyId;
      return;
    }
    this.runRemedy(remedy);
  }

  confirmRemedy(remedy: SuggestedRemedy): void {
    this.runRemedy(remedy);
  }

  cancelRemedy(): void {
    this.confirmingRemedyId = '';
  }

  severityLabel(value: DiagnosisSeverity): string {
    return SEVERITY_LABELS[value] || value;
  }

  confidenceLabel(value: DiagnosisConfidence): string {
    return CONFIDENCE_LABELS[value] || value;
  }

  riskLabel(value: RemedyRisk): string {
    return RISK_LABELS[value] || value;
  }

  stepStatusLabel(value: DiagnosisStepStatus): string {
    return STEP_STATUS_LABELS[value] || value;
  }

  runStatusLabel(status: string): string {
    if (status === 'succeeded') return 'Erfolg';
    if (status === 'failed') return 'Fehler';
    if (status === 'running') return 'Läuft';
    return status;
  }

  worstSeverity(run: ActionRunResult): DiagnosisSeverity {
    const findings = run.diagnosis?.findings ?? [];
    return findings.reduce<DiagnosisSeverity>(
      (worst, finding) =>
        SEVERITY_ORDER[finding.severity] < SEVERITY_ORDER[worst] ? finding.severity : worst,
      'info'
    );
  }

  isLog(item: ActionEvidence): boolean {
    return (
      typeof item.value === 'string' && (item.value.includes('\n') || item.value.length > 160)
    );
  }

  evidenceUrl(item: ActionEvidence): string | null {
    return typeof item.value === 'string' && /^https?:\/\/\S+$/.test(item.value.trim())
      ? item.value.trim()
      : null;
  }

  ngOnDestroy(): void {
    this.streamSub?.unsubscribe();
  }

  private runRemedy(remedy: SuggestedRemedy): void {
    this.confirmingRemedyId = '';
    this.runningRemedyId = remedy.remedyId;
    this.api
      .run(remedy.actionId, {
        targetApp: this.app,
        targetEnvironment: this.environment,
        inputs: remedy.defaultInputs ?? {},
      })
      .pipe(
        finalize(() => {
          this.runningRemedyId = '';
          this.changeDetector.detectChanges();
        })
      )
      .subscribe({
        next: ({ run }) => {
          this.remedyRuns[remedy.remedyId] = run;
          this.expandedRemedies.add(remedy.remedyId);
          this.changeDetector.detectChanges();
        },
        error: () => {
          this.error = `Abhilfe „${remedy.title}" konnte nicht ausgeführt werden.`;
          this.changeDetector.detectChanges();
        },
      });
  }

  private upsertStep(step: DiagnosisStepEvent): void {
    const index = this.steps.findIndex((existing) => existing.stepId === step.stepId);
    if (index === -1) {
      this.steps = [...this.steps, step];
    } else {
      const next = [...this.steps];
      next[index] = step;
      this.steps = next;
    }
  }
}
