import { CommonModule } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  Input,
  OnDestroy,
  ViewRef,
  inject,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import {
  ActionEvidence,
  ActionRunResult,
  DiagnosisConfidence,
  DiagnosisFinding,
  DiagnosisRepairPhaseEvent,
  DiagnosisRepairResponse,
  DiagnosisSeverity,
  DiagnosisStepEvent,
  DiagnosisStepStatus,
  OpsRole,
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

  repairing = false;
  repairResult?: DiagnosisRepairResponse;
  repairError = '';
  repairPhases: DiagnosisRepairPhaseEvent[] = [];
  repairEstimatedSeconds = 0;

  private streamSub?: Subscription;
  private repairSub?: Subscription;

  /** Staggered reveal: incoming probe events are buffered and applied one per tick
   *  so the scan reads as real work instead of flipping green all at once. */
  private static readonly STEP_STAGGER_MS = 50;
  private pendingSteps: DiagnosisStepEvent[] = [];
  private pendingResult?: ActionRunResult;
  private pendingError?: string;
  private streamDone = false;
  private drainTimer?: ReturnType<typeof setTimeout>;

  get findings(): readonly DiagnosisFinding[] {
    return [...(this.selectedRun?.diagnosis?.findings ?? [])].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.error = '';
    this.steps = [];
    this.pendingSteps = [];
    this.pendingResult = undefined;
    this.pendingError = undefined;
    this.streamDone = false;
    this.clearDrain();
    this.repairResult = undefined;
    this.repairError = '';
    this.repairPhases = [];
    this.repairEstimatedSeconds = 0;
    this.running = true;
    this.streamSub?.unsubscribe();
    this.streamSub = this.api
      .streamDiagnose({
        targetApp: this.app,
        targetEnvironment: this.environment,
        inputs: {},
      })
      .pipe(
        finalize(() => {
          this.streamDone = true;
          this.scheduleDrain();
        }),
      )
      .subscribe({
        next: (event) => {
          switch (event.type) {
            case 'started':
              this.steps = [];
              this.pendingSteps = [];
              break;
            case 'step':
              this.pendingSteps.push(event.step);
              break;
            case 'result':
              this.pendingResult = event.run;
              break;
            case 'error':
              this.pendingError = event.message;
              break;
          }
          this.scheduleDrain();
        },
        error: () => {
          this.pendingError = 'Diagnose konnte nicht gestartet werden.';
          this.streamDone = true;
          this.scheduleDrain();
        },
      });
  }

  private scheduleDrain(): void {
    if (!this.drainTimer) {
      this.drainTimer = setTimeout(
        () => this.drainTick(),
        DiagnosePanel.STEP_STAGGER_MS,
      );
    }
  }

  /** Applies one buffered probe per tick, then commits the result once the queue drains. */
  private drainTick(): void {
    this.drainTimer = undefined;

    const step = this.pendingSteps.shift();
    if (step) {
      this.upsertStep(step);
      this.detect();
      this.drainTimer = setTimeout(
        () => this.drainTick(),
        DiagnosePanel.STEP_STAGGER_MS,
      );
      return;
    }

    if (!this.streamDone) {
      // Waiting for more probes to arrive from the stream.
      this.drainTimer = setTimeout(
        () => this.drainTick(),
        DiagnosePanel.STEP_STAGGER_MS,
      );
      return;
    }

    if (this.pendingError) {
      this.error = this.pendingError;
      this.pendingError = undefined;
    }
    if (this.pendingResult) {
      this.runs = [this.pendingResult, ...this.runs].slice(0, 15);
      this.selectedRun = this.pendingResult;
      this.pendingResult = undefined;
    }
    this.running = false;
    this.detect();
  }

  private clearDrain(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
  }

  private detect(): void {
    const ref = this.changeDetector as ViewRef;
    if (!ref.destroyed) {
      ref.detectChanges();
    }
  }

  select(run: ActionRunResult): void {
    this.selectedRun = run;
    this.repairResult = undefined;
    this.repairError = '';
    this.repairPhases = [];
    this.repairEstimatedSeconds = 0;
    this.expandedFindings.clear();
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

  repairAvailable(): boolean {
    if (!this.selectedRun?.diagnosis || this.repairing || this.running) {
      return false;
    }
    return this.findings.some((finding) =>
      finding.remedies.some((remedy) =>
        ['argo-sync', 'rollout-restart'].includes(remedy.actionId),
      ),
    );
  }

  repair(): void {
    if (!this.repairAvailable()) {
      return;
    }
    this.repairing = true;
    this.repairError = '';
    this.repairResult = undefined;
    this.repairPhases = [];
    this.repairEstimatedSeconds = 0;
    this.repairSub?.unsubscribe();
    this.repairSub = this.api
      .streamRepairDiagnosis({
        targetApp: this.app,
        targetEnvironment: this.environment,
        inputs: {},
      })
      .pipe(
        finalize(() => {
          this.repairing = false;
          this.changeDetector.detectChanges();
        }),
      )
      .subscribe({
        next: (event) => {
          switch (event.type) {
            case 'started':
              this.repairEstimatedSeconds = event.estimatedSeconds;
              break;
            case 'phase':
              this.upsertRepairPhase(event.phase);
              break;
            case 'result':
              this.applyRepairResult(event.result);
              break;
            case 'error':
              this.repairError = event.message;
              break;
          }
          this.changeDetector.detectChanges();
        },
        error: () => {
          this.repairError =
            'Automatische Reparatur konnte nicht ausgeführt werden.';
          this.changeDetector.detectChanges();
        },
      });
  }

  severityLabel(value: DiagnosisSeverity): string {
    return SEVERITY_LABELS[value] || value;
  }

  confidenceLabel(value: DiagnosisConfidence): string {
    return CONFIDENCE_LABELS[value] || value;
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

  repairSummary(): string {
    if (this.repairResult) {
      return this.repairResult.summary;
    }
    if (this.repairError) {
      return this.repairError;
    }
    return 'Führt die freigegebene Reparatur aus und prüft danach automatisch erneut.';
  }

  repairDurationHint(): string {
    const seconds = this.repairEstimatedSeconds || 120;
    if (this.repairing) {
      return `Läuft. Typisch 30 bis ${seconds} Sekunden, bei GitOps-Warten bis etwa 2 Minuten.`;
    }
    return `Dauert meist 30 bis ${seconds} Sekunden. Danach startet automatisch eine neue Diagnose.`;
  }

  repairProgressValue(): number {
    if (this.repairResult) {
      return 100;
    }
    const relevantPhases = this.repairPhases.filter(
      (phase) => phase.status !== 'skipped',
    );
    if (!this.repairing || !relevantPhases.length) {
      return 0;
    }
    const completed = relevantPhases.filter((phase) =>
      ['succeeded', 'failed'].includes(phase.status),
    ).length;
    return Math.min(
      95,
      Math.max(8, Math.round((completed / Math.max(relevantPhases.length, 4)) * 100)),
    );
  }

  repairProgressText(): string {
    if (this.repairResult) {
      return 'Abgeschlossen';
    }
    const active = [...this.repairPhases]
      .reverse()
      .find((phase) => phase.status === 'running');
    return active ? active.label : 'Reparatur wird vorbereitet';
  }

  repairResultClass(): string {
    if (!this.repairResult) {
      return this.repairError ? 'failed' : 'idle';
    }
    if (this.repairResult.remainingFindingIds.length === 0) {
      return 'succeeded';
    }
    return this.repairResult.resolvedFindingIds.length ? 'partial' : 'failed';
  }

  repairRunLabels(): string {
    const runs = this.repairResult?.repairRuns ?? [];
    if (!runs.length) {
      return '';
    }
    return runs
      .map(
        (run) =>
          `${repairActionLabel(run.actionId)}: ${this.runStatusLabel(run.status)}`,
      )
      .join(' · ');
  }

  worstSeverity(run: ActionRunResult): DiagnosisSeverity {
    const findings = run.diagnosis?.findings ?? [];
    return findings.reduce<DiagnosisSeverity>(
      (worst, finding) =>
        SEVERITY_ORDER[finding.severity] < SEVERITY_ORDER[worst]
          ? finding.severity
          : worst,
      'info',
    );
  }

  isLog(item: ActionEvidence): boolean {
    return (
      typeof item.value === 'string' &&
      (item.value.includes('\n') || item.value.length > 160)
    );
  }

  evidenceUrl(item: ActionEvidence): string | null {
    return typeof item.value === 'string' &&
      /^https?:\/\/\S+$/.test(item.value.trim())
      ? item.value.trim()
      : null;
  }

  ngOnDestroy(): void {
    this.streamSub?.unsubscribe();
    this.repairSub?.unsubscribe();
    this.clearDrain();
  }

  private upsertStep(step: DiagnosisStepEvent): void {
    if (step.status === 'skipped') {
      return;
    }
    const index = this.steps.findIndex(
      (existing) => existing.stepId === step.stepId,
    );
    if (index === -1) {
      this.steps = [...this.steps, step];
    } else {
      const next = [...this.steps];
      next[index] = step;
      this.steps = next;
    }
  }

  private upsertRepairPhase(phase: DiagnosisRepairPhaseEvent): void {
    if (phase.status === 'skipped') {
      return;
    }
    const index = this.repairPhases.findIndex(
      (existing) => existing.phaseId === phase.phaseId,
    );
    if (index === -1) {
      this.repairPhases = [...this.repairPhases, phase];
    } else {
      const next = [...this.repairPhases];
      next[index] = phase;
      this.repairPhases = next;
    }
  }

  private applyRepairResult(result: DiagnosisRepairResponse): void {
    this.repairResult = result;
    this.selectedRun = result.afterRun;
    this.runs = [result.afterRun, result.beforeRun, ...this.runs]
      .filter(
        (run, index, all) =>
          all.findIndex((item) => item.runId === run.runId) === index,
      )
      .slice(0, 15);
    this.expandedFindings.clear();
  }
}

function repairActionLabel(actionId: string): string {
  if (actionId === 'argo-sync') {
    return 'GitOps-Abgleich';
  }
  if (actionId === 'rollout-restart') {
    return 'App-Neustart';
  }
  return 'Reparatur';
}
