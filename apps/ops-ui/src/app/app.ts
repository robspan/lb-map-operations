import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatToolbarModule } from '@angular/material/toolbar';
import {
  ActionEvidence,
  ActionRunResult,
  ActionStatus,
  AppOperationsContract,
  OperationAction,
  OpsRole,
  TargetApp,
  TargetEnvironment,
} from '@lb-map-operations/ops-contract';
import { finalize, forkJoin } from 'rxjs';
import { ActionConfigDialog, ActionConfigData } from './action-config-dialog';
import { ContractPanel } from './contract-panel';
import { DiagnosePanel } from './diagnose-panel';
import { InfoButton } from './info-button';
import { OpsApiService } from './ops-api.service';

type OpsView = 'diagnose' | 'operations' | 'contract';

const EXPERT_MODE_KEY = 'ops.expertMode';

/** German role labels for the toolbar chips. */
const ROLE_LABELS: Record<OpsRole, string> = {
  'first-level': 'First Level',
  operator: 'Operator',
  admin: 'Admin',
};

/** Per-action explanations for the info buttons (what it does and when to use it). */
const ACTION_HELP: Record<string, string> = {
  'app-health':
    'Schneller Gesamtüberblick: Läuft die App? Prüft Deployment, Pods, internen Health-Endpunkt und ArgoCD. Guter erster Schritt bei „App geht nicht“.',
  'argo-status':
    'Zeigt, ob der per GitOps (ArgoCD) ausgerollte Stand synchron und gesund ist. Nutzen, wenn ein Deployment nicht ankommt oder „out of sync“ vermutet wird.',
  'endpoint-check':
    'Ruft den internen und/oder öffentlichen Health-Endpunkt auf und misst HTTP-Status und Antwortzeit. Nutzen bei Erreichbarkeits- oder Timeout-Problemen.',
  'pod-summary':
    'Listet Pods mit Phase und Neustarts sowie die letzten Namespace-Events. Nutzen bei CrashLoops, hängenden Pods oder unklaren Fehlern.',
  'log-summary':
    'Liest die letzten technischen Log-Zeilen eines Pods (Secrets und Env werden entfernt). Nutzen, um konkrete Fehlermeldungen zu finden.',
  'smoke-result':
    'Zeigt die letzten in-cluster Smoke-Jobs und deren Ergebnis. Nutzen, um zu sehen, ob automatische Health-Checks zuletzt erfolgreich waren.',
  'observability-links':
    'Liefert die standardisierten Links und Queries für Grafana, Loki, Prometheus und ArgoCD der Ziel-App. Nutzen, um direkt in die richtigen Dashboards zu springen.',
  'escalation-bundle':
    'Bündelt Status, Pods, Events und ArgoCD-Zustand in einem Paket – ideal zum Anhängen an eine Eskalation an die interne IT.',
  'argo-sync':
    'Löst einen ArgoCD-Sync ohne Prune aus, um den Soll-Zustand aus Git erneut anzuwenden. Eingriff – verändert die Live-Umgebung.',
  'rollout-restart':
    'Startet das Deployment rollierend über eine Annotation neu (ohne Datenverlust). Eingriff – verändert die Live-Umgebung.',
  'smoke-trigger':
    'Startet einen kurzlebigen Health-Smoke-Job in der Zielumgebung. Eingriff – erzeugt einen Job im Cluster.',
};

/** Explanations for the general controls and sections. */
const UI_HELP = {
  app: 'Die Ziel-App, auf die sich alle Aktionen beziehen.',
  environment:
    'Zielumgebung der Aktionen. „dev“ = Entwicklung, „test“ = Test. Produktion ist hier bewusst nicht verfügbar.',
  expert:
    'Einfach: nur Aktionen mit Standardwerten – ideal für First Level. Experte: zusätzliche Konfiguration je Aktion über das Zahnrad-Symbol.',
  diagnose:
    'Nur lesende Aktionen. Sie verändern nichts an der App und können bedenkenlos ausgeführt werden.',
  eingriffe:
    'Aktionen, die die Live-Umgebung verändern. Vor der Ausführung ist eine Bestätigung nötig.',
  result: 'Ergebnis der zuletzt ausgeführten Aktion samt Belegen und ggf. Fehlermeldung.',
  history:
    'Aktionen dieser Sitzung. Auf einen Eintrag klicken, um dessen Ergebnis erneut anzuzeigen.',
  view:
    'Diagnose: ein Klick prüft alles und schlägt Abhilfe vor. Operationen: einzelne Aktionen mit Parametern (Expertenmodus). Standard-Setup: der Operations-Vertrag der Ziel-App.',
} as const;

const STATUS_LABELS: Record<ActionStatus, string> = {
  queued: 'Wartet',
  running: 'Läuft',
  succeeded: 'Erfolg',
  failed: 'Fehler',
  rejected: 'Abgelehnt',
};

@Component({
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatChipsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatToolbarModule,
    InfoButton,
    ContractPanel,
    DiagnosePanel,
  ],
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  private readonly api = inject(OpsApiService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly dialog = inject(MatDialog);

  readonly uiHelp = UI_HELP;
  expertMode = readExpertMode();
  activeView: OpsView = 'diagnose';

  actor = '';
  roles: readonly OpsRole[] = [];
  selectedApp: TargetApp = 'varlens';
  selectedEnvironment: TargetEnvironment = 'test';

  diagnostics: OperationAction[] = [];
  mutations: OperationAction[] = [];
  inputs: Record<string, Record<string, string>> = {};
  contracts: readonly AppOperationsContract[] = [];
  private readonly actionTitles: Record<string, string> = {};

  loaded = false;
  loadError = '';
  runError = '';
  runningActionId = '';
  confirmingActionId = '';
  runs: ActionRunResult[] = [];
  selectedRun?: ActionRunResult;

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loadError = '';
    forkJoin({
      me: this.api.me(),
      actions: this.api.actions(),
      contracts: this.api.contracts(),
    }).subscribe({
      next: ({ me, actions, contracts }) => {
        this.actor = me.principal.email || me.principal.user;
        this.roles = me.principal.roles;
        this.diagnostics = actions.actions.filter(
          (action) => action.kind === 'diagnostic' && action.id !== 'diagnose-target'
        );
        this.mutations = actions.actions.filter((action) => action.kind === 'mutation');
        this.contracts = contracts.contracts;
        for (const action of actions.actions) {
          this.actionTitles[action.id] = action.title;
          this.inputs[action.id] = {};
          for (const input of this.actionSpecificInputs(action)) {
            if (input.defaultValue) {
              this.inputs[action.id][input.name] = input.defaultValue;
            }
          }
        }
        this.loaded = true;
        this.changeDetector.detectChanges();
      },
      error: () => {
        this.loaded = true;
        this.loadError =
          'Keine gültige Support-Anmeldung. Lokal die API mit OPS_DEV_AUTH_USER starten.';
        this.changeDetector.detectChanges();
      },
    });
  }

  setView(view: OpsView): void {
    this.activeView = view;
    this.confirmingActionId = '';
  }

  get currentContract(): AppOperationsContract | undefined {
    return this.contracts.find(
      (contract) =>
        contract.app === this.selectedApp && contract.environment === this.selectedEnvironment
    );
  }

  actionSpecificInputs(action: OperationAction) {
    return action.inputs.filter(
      (input) => input.name !== 'targetApp' && input.name !== 'targetEnvironment'
    );
  }

  hasConfig(action: OperationAction): boolean {
    return this.actionSpecificInputs(action).length > 0;
  }

  helpFor(action: OperationAction): string {
    return ACTION_HELP[action.id] || action.description;
  }

  roleLabel(role: string): string {
    return ROLE_LABELS[role as OpsRole] || role;
  }

  /** Number of advanced inputs that differ from their default value. */
  customizedCount(action: OperationAction): number {
    const values = this.inputs[action.id] || {};
    return this.actionSpecificInputs(action).filter(
      (input) => (values[input.name] ?? '') !== (input.defaultValue ?? '')
    ).length;
  }

  setExpertMode(enabled: boolean): void {
    this.expertMode = enabled;
    try {
      localStorage.setItem(EXPERT_MODE_KEY, enabled ? '1' : '0');
    } catch {
      // localStorage may be unavailable; the in-memory toggle still works.
    }
  }

  openConfig(action: OperationAction): void {
    const data: ActionConfigData = {
      action,
      inputs: this.actionSpecificInputs(action),
      values: { ...(this.inputs[action.id] || {}) },
    };
    this.dialog
      .open(ActionConfigDialog, { data, autoFocus: false, restoreFocus: true })
      .afterClosed()
      .subscribe((result?: Record<string, string>) => {
        if (result) {
          this.inputs[action.id] = result;
        }
        this.changeDetector.detectChanges();
      });
  }

  /** Diagnostics run immediately; mutations require an explicit confirm first. */
  run(action: OperationAction): void {
    if (action.kind === 'mutation' && this.confirmingActionId !== action.id) {
      this.confirmingActionId = action.id;
      return;
    }
    this.execute(action);
  }

  confirm(action: OperationAction): void {
    this.execute(action);
  }

  cancel(): void {
    this.confirmingActionId = '';
  }

  select(run: ActionRunResult): void {
    this.selectedRun = run;
  }

  titleFor(actionId: string): string {
    return this.actionTitles[actionId] || actionId;
  }

  statusLabel(status: ActionStatus): string {
    return STATUS_LABELS[status] || status;
  }

  /** Long or multiline values render in a monospace block. URLs are handled separately. */
  isLog(item: ActionEvidence): boolean {
    return (
      typeof item.value === 'string' && (item.value.includes('\n') || item.value.length > 160)
    );
  }

  /** Returns an http(s) URL if the evidence value is a clickable link, otherwise null. */
  evidenceUrl(item: ActionEvidence): string | null {
    return typeof item.value === 'string' && /^https?:\/\/\S+$/.test(item.value.trim())
      ? item.value.trim()
      : null;
  }

  private execute(action: OperationAction): void {
    this.confirmingActionId = '';
    this.runError = '';
    this.runningActionId = action.id;
    this.api
      .run(action.id, {
        targetApp: this.selectedApp,
        targetEnvironment: this.selectedEnvironment,
        inputs: this.inputs[action.id] || {},
      })
      .pipe(
        finalize(() => {
          this.runningActionId = '';
          this.changeDetector.detectChanges();
        })
      )
      .subscribe({
        next: ({ run }) => {
          this.runs = [run, ...this.runs].slice(0, 25);
          this.selectedRun = run;
          this.changeDetector.detectChanges();
        },
        error: () => {
          this.runError = 'Aktion konnte nicht ausgeführt werden.';
          this.changeDetector.detectChanges();
        },
      });
  }
}

function readExpertMode(): boolean {
  try {
    return localStorage.getItem(EXPERT_MODE_KEY) === '1';
  } catch {
    return false;
  }
}
