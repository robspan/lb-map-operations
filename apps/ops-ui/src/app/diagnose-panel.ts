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

  /** Staggered reveal: incoming probe events are buffered and applied one per tick
   *  so the scan reads as real work instead of flipping green all at once. */
  private static readonly STEP_STAGGER_MS = 30;
  private pendingSteps: DiagnosisStepEvent[] = [];
  private pendingResult?: ActionRunResult;
  private pendingError?: string;
  private streamDone = false;
  private drainTimer?: ReturnType<typeof setTimeout>;

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
    this.pendingSteps = [];
    this.pendingResult = undefined;
    this.pendingError = undefined;
    this.streamDone = false;
    this.clearDrain();
    this.running = true;
    this.streamSub?.unsubscribe();
    this.streamSub = this.api
      .streamDiagnose({ targetApp: this.app, targetEnvironment: this.environment, inputs: {} })
      .pipe(
        finalize(() => {
          this.streamDone = true;
          this.scheduleDrain();
        })
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
      this.drainTimer = setTimeout(() => this.drainTick(), DiagnosePanel.STEP_STAGGER_MS);
    }
  }

  /** Applies one buffered probe per tick, then commits the result once the queue drains. */
  private drainTick(): void {
    this.drainTimer = undefined;

    const step = this.pendingSteps.shift();
    if (step) {
      this.upsertStep(step);
      this.detect();
      this.drainTimer = setTimeout(() => this.drainTick(), DiagnosePanel.STEP_STAGGER_MS);
      return;
    }

    if (!this.streamDone) {
      // Waiting for more probes to arrive from the stream.
      this.drainTimer = setTimeout(() => this.drainTick(), DiagnosePanel.STEP_STAGGER_MS);
      return;
    }

    if (this.pendingError) {
      this.error = this.pendingError;
      this.pendingError = undefined;
    }
    if (this.pendingResult) {
      this.runs = [this.pendingResult, ...this.runs].slice(0, 15);
      this.selectedRun = this.pendingResult;
      this.remedyRuns = {};
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
    if (!this.isAdmin()) {
      return;
    }
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

  isAdmin(): boolean {
    return this.roles.includes('admin');
  }

  visibleRemedies(finding: DiagnosisFinding): readonly SuggestedRemedy[] {
    if (this.isAdmin()) {
      return finding.remedies;
    }
    return finding.remedies.filter(
      (remedy) =>
        remedy.enabled &&
        (remedy.actionId === 'escalation-bundle' || remedy.risk !== 'none')
    );
  }

  remediesHeading(): string {
    return this.isAdmin() ? 'Vorgeschlagene Abhilfe' : 'Nächster Schritt';
  }

  remedyTitle(remedy: SuggestedRemedy): string {
    if (this.isAdmin()) {
      return remedy.title;
    }
    if (remedy.actionId === 'escalation-bundle') {
      return 'Eskalieren';
    }
    return 'Autofix';
  }

  remedyDescription(remedy: SuggestedRemedy): string {
    if (this.isAdmin()) {
      return remedy.description;
    }
    if (remedy.actionId === 'escalation-bundle') {
      return 'An interne IT übergeben, wenn die Diagnose keine direkte Lösung bringt.';
    }
    return 'Sichere automatische Abhilfe ausführen und danach erneut scannen.';
  }

  remedyButtonLabel(remedy: SuggestedRemedy): string {
    if (!this.isAdmin()) {
      return remedy.actionId === 'escalation-bundle' ? 'Eskalieren' : 'Autofix';
    }
    return remedy.risk === 'none' ? 'Anzeigen' : 'Ausführen';
  }

  compactRemedySummary(remedy: SuggestedRemedy, run: ActionRunResult): string {
    if (this.isAdmin()) {
      return run.summary;
    }
    if (run.status === 'failed') {
      return 'Hat nicht funktioniert. Bitte eskalieren.';
    }
    if (remedy.actionId === 'escalation-bundle') {
      return 'Eskalation vorbereitet.';
    }
    return 'Abhilfe ausgeführt. Danach Diagnose erneut starten.';
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
    this.clearDrain();
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
          if (this.isAdmin()) {
            this.expandedRemedies.add(remedy.remedyId);
          }
          this.changeDetector.detectChanges();
        },
        error: () => {
          this.error = `Abhilfe „${remedy.title}" konnte nicht ausgeführt werden.`;
          this.changeDetector.detectChanges();
        },
      });
  }

  private upsertStep(step: DiagnosisStepEvent): void {
    if (step.status === 'skipped') {
      return;
    }
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
