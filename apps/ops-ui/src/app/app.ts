import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatToolbarModule } from '@angular/material/toolbar';
import {
  ActionEvidence,
  ActionInputDefinition,
  ActionRunResult,
  ActionStatus,
  OperationAction,
  OpsRole,
  TargetApp,
  TargetEnvironment,
  VarLensUserSummary,
} from '@lb-map-operations/ops-contract';
import { finalize, forkJoin } from 'rxjs';
import { DiagnosePanel } from './diagnose-panel';
import { InfoButton } from './info-button';
import { OpsApiService, OpsAuditEvent, OpsUserSummary } from './ops-api.service';

type OpsView = 'diagnose' | 'app-varlens' | 'platform' | 'users' | 'audit';

/** German role labels for the toolbar chips. */
const ROLE_LABELS: Record<OpsRole, string> = {
  'first-level': 'First Level',
  admin: 'Admin',
};

const TARGET_APP_LABELS: Record<TargetApp, string> = {
  varlens: 'VarLens',
};

const TARGET_ENVIRONMENT_LABELS: Record<TargetEnvironment, string> = {
  dev: 'Entwicklung',
  test: 'Test',
  prod: 'Produktion',
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
  'platform-overview':
    'Bündelt App-Laufzeit, GitOps und Smoke-Status für den täglichen Betriebsüberblick.',
  'data-store-status':
    'Zeigt nur den technischen Status des Datenbank-Clusters. Es werden keine Nutzdaten, Dumps oder Zugangsdaten gelesen.',
  'ingress-status':
    'Prüft Ingress, Hosts, TLS-Verweise und Zertifikatsstatus der Ziel-App.',
  'backup-status':
    'Zeigt Backup- und ScheduledBackup-Objektstatus, ohne Backup-Inhalte oder Dumps zu lesen.',
  'observability-status':
    'Fasst die standardisierten Metriken, Logs und Dashboards aus dem App-Vertrag zusammen.',
  'escalation-bundle':
    'Bündelt Status, Pods, Events und ArgoCD-Zustand in einem Paket – ideal zum Anhängen an eine Eskalation an die interne IT.',
  'argo-sync':
    'Löst einen ArgoCD-Sync ohne Prune aus, um den Soll-Zustand aus Git erneut anzuwenden. Eingriff – verändert die Live-Umgebung.',
  'varlens-user-create':
    'Legt einen normalen VarLens-Nutzer mit eigener Workspace-Datenbank an. Rollen werden nicht bearbeitet.',
  'varlens-user-block':
    'Sperrt den VarLens-Login und deaktiviert die Workspace-Datenbank-Zuordnung, ohne die Datenbank zu löschen.',
  'varlens-user-unblock':
    'Entsperrt den VarLens-Login und aktiviert die Workspace-Datenbank-Zuordnung wieder.',
  'varlens-user-prune':
    'Entfernt genau diesen VarLens-Nutzer und dessen abgeleitete Workspace-Datenbank. Das ist keine Infra-Löschung.',
  'rollout-restart':
    'Startet das Deployment rollierend über eine Annotation neu (ohne Datenverlust). Eingriff – verändert die Live-Umgebung.',
};

/** Per-input explanations for the inline action forms. */
const INPUT_HELP: Record<string, string> = {
  timeoutSeconds: 'Maximale Wartezeit pro HTTP-Aufruf in Sekunden, bevor er als fehlgeschlagen gilt.',
  endpointScope:
    'Welche Endpunkte geprüft werden: intern (im Cluster), öffentlich (von außen) oder beide.',
  podLimit: 'Wie viele Pods maximal angezeigt werden.',
  eventLimit: 'Wie viele der letzten Namespace-Events angezeigt werden.',
  podSelection:
    'Aus welchem Pod die Logs gelesen werden: bevorzugt laufender, neuester oder ältester.',
  previous:
    'Logs des vorherigen (abgestürzten) Containers lesen statt des aktuellen – hilfreich bei CrashLoops.',
  tailLines: 'Anzahl der zuletzt gelesenen Log-Zeilen.',
  jobLimit: 'Wie viele der letzten Smoke-Jobs angezeigt werden.',
  detailLevel: 'Detailgrad: nur Zusammenfassung oder zusätzlich einzelne ArgoCD-Ressourcen.',
  resourceLimit: 'Wie viele ArgoCD-Ressourcen bei „Detailgrad: resources“ angezeigt werden.',
  username: 'VarLens-Benutzername. Die Rolle bleibt fest normaler VarLens-Nutzer.',
  displayName: 'Anzeigename für den VarLens-Nutzer.',
  initialPassword:
    'Initiales VarLens-Passwort. Es wird nicht protokolliert und muss beim ersten Login geändert werden.',
  confirmUsername: 'Sicherheitsbestätigung: muss exakt dem VarLens-Benutzernamen entsprechen.',
};

/** Explanations for the general controls and sections. */
const UI_HELP = {
  target:
    'Dieses Operations-Frontend ist fest auf eine App und eine Stage verdrahtet. Die Zielumgebung wird durch die Server-Installation bestimmt.',
  environment:
    'Stage dieser Operations-Installation. Die Test-Instanz arbeitet nur gegen Test; Produktion bekommt später eine eigene Instanz.',
  diagnose:
    'Nur lesende Aktionen. Sie verändern nichts an der App und können bedenkenlos ausgeführt werden.',
  eingriffe:
    'Aktionen, die die Live-Umgebung verändern. Vor der Ausführung ist eine Bestätigung nötig.',
  result: 'Ergebnis der zuletzt ausgeführten Aktion samt Belegen und ggf. Fehlermeldung.',
  history:
    'Aktionen dieser Sitzung. Auf einen Eintrag klicken, um dessen Ergebnis erneut anzuzeigen.',
} as const;

const STATUS_LABELS: Record<ActionStatus, string> = {
  queued: 'Wartet',
  running: 'Läuft',
  succeeded: 'Erfolg',
  failed: 'Fehler',
  rejected: 'Abgelehnt',
};

type SelectOption = {
  readonly value: string;
  readonly label: string;
};

@Component({
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatChipsModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    MatToolbarModule,
    InfoButton,
    DiagnosePanel,
  ],
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  private readonly api = inject(OpsApiService);
  private readonly changeDetector = inject(ChangeDetectorRef);

  readonly uiHelp = UI_HELP;
  activeView: OpsView = 'diagnose';
  /** Actions whose optional inline parameters are currently revealed. */
  private readonly openOptions = new Set<string>();

  actor = '';
  roles: readonly OpsRole[] = [];
  selectedApp: TargetApp = 'varlens';
  selectedEnvironment: TargetEnvironment = 'test';

  diagnostics: OperationAction[] = [];
  mutations: OperationAction[] = [];
  userMutations: OperationAction[] = [];
  platformMutations: OperationAction[] = [];
  inputs: Record<string, Record<string, string>> = {};
  private readonly actionTitles: Record<string, string> = {};

  loaded = false;
  loadError = '';
  loginError = '';
  loginUsername = '';
  loginPassword = '';
  users: OpsUserSummary[] = [];
  varlensUsers: readonly VarLensUserSummary[] = [];
  varlensUserError = '';
  userError = '';
  auditEvents: readonly OpsAuditEvent[] = [];
  auditLimit = 25;
  auditOffset = 0;
  auditTotal = 0;
  auditLoading = false;
  auditError = '';
  newUser = {
    username: '',
    displayName: '',
    email: '',
    password: '',
    role: 'first-level',
  };
  resetPasswords: Record<string, string> = {};
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
    }).subscribe({
      next: ({ me, actions }) => {
        this.actor = me.principal.email || me.principal.user;
        this.roles = me.principal.roles;
        this.selectedApp = me.targetApp;
        this.selectedEnvironment = me.targetEnvironment;
        this.diagnostics = actions.actions.filter(
          (action) =>
            action.kind === 'diagnostic' &&
            action.role === 'admin' &&
            action.id !== 'observability-links'
        );
        this.mutations = actions.actions.filter((action) => action.kind === 'mutation');
        this.userMutations = this.mutations.filter((action) =>
          action.id.startsWith('varlens-user-')
        );
        this.platformMutations = this.mutations.filter(
          (action) => !action.id.startsWith('varlens-user-')
        );
        for (const action of actions.actions) {
          this.actionTitles[action.id] = action.title;
          this.inputs[action.id] = {};
          for (const input of this.actionSpecificInputs(action)) {
            if (input.defaultValue) {
              this.inputs[action.id][input.name] = input.defaultValue;
            }
          }
        }
        if (!this.isAdmin() && this.activeView !== 'diagnose') {
          this.activeView = 'diagnose';
        }
        this.loaded = true;
        if (this.isAdmin() && this.hasVarLensUserSelector()) {
          this.loadVarLensUsers();
        }
        if (this.activeView === 'users' && this.isAdmin()) {
          this.loadUsers();
        }
        if (this.activeView === 'audit' && this.isAdmin()) {
          this.loadAudit();
        }
        this.changeDetector.detectChanges();
      },
      error: () => {
        this.loaded = true;
        this.loadError = 'Anmeldung erforderlich.';
        this.changeDetector.detectChanges();
      },
    });
  }

  login(): void {
    this.loginError = '';
    this.api.login(this.loginUsername, this.loginPassword).subscribe({
      next: () => {
        this.loginPassword = '';
        this.loadError = '';
        this.load();
      },
      error: () => {
        this.loginError = 'Anmeldung fehlgeschlagen.';
        this.changeDetector.detectChanges();
      },
    });
  }

  logout(): void {
    this.api.logout().subscribe({
      next: () => {
        this.actor = '';
        this.roles = [];
        this.users = [];
        this.auditEvents = [];
        this.auditOffset = 0;
        this.auditTotal = 0;
        this.activeView = 'diagnose';
        this.loadError = 'Anmeldung erforderlich.';
        this.changeDetector.detectChanges();
      },
    });
  }

  setView(view: OpsView): void {
    if (view !== 'diagnose' && !this.isAdmin()) {
      this.activeView = 'diagnose';
      return;
    }
    this.activeView = view;
    this.confirmingActionId = '';
    if (view === 'users' && this.isAdmin()) {
      this.loadUsers();
    }
    if (view === 'audit' && this.isAdmin()) {
      this.loadAudit();
    }
  }

  isAdmin(): boolean {
    return this.roles.includes('admin');
  }

  visibleRoles(): readonly OpsRole[] {
    return this.roles.filter((role) => role !== 'first-level');
  }

  loadUsers(): void {
    this.userError = '';
    this.api.users().subscribe({
      next: ({ users }) => {
        this.users = users;
        this.changeDetector.detectChanges();
      },
      error: () => {
        this.userError = 'Benutzer konnten nicht geladen werden.';
        this.changeDetector.detectChanges();
      },
    });
  }

  loadVarLensUsers(): void {
    this.varlensUserError = '';
    this.api.varlensUsers(this.selectedApp, this.selectedEnvironment).subscribe({
      next: ({ users }) => {
        this.varlensUsers = users;
        this.changeDetector.detectChanges();
      },
      error: () => {
        this.varlensUsers = [];
        this.varlensUserError = 'VarLens-Nutzer konnten nicht geladen werden.';
        this.changeDetector.detectChanges();
      },
    });
  }

  loadAudit(offset = this.auditOffset): void {
    this.auditError = '';
    this.auditLoading = true;
    this.api.auditEvents(this.auditLimit, offset).subscribe({
      next: ({ events, total, limit, offset }) => {
        this.auditEvents = events;
        this.auditTotal = total;
        this.auditLimit = limit;
        this.auditOffset = offset;
        this.auditLoading = false;
        this.changeDetector.detectChanges();
      },
      error: () => {
        this.auditLoading = false;
        this.auditError = 'Audit-Ereignisse konnten nicht geladen werden.';
        this.changeDetector.detectChanges();
      },
    });
  }

  previousAuditPage(): void {
    if (!this.auditCanPrev()) {
      return;
    }
    this.loadAudit(Math.max(0, this.auditOffset - this.auditLimit));
  }

  nextAuditPage(): void {
    if (!this.auditCanNext()) {
      return;
    }
    this.loadAudit(this.auditOffset + this.auditLimit);
  }

  auditCanPrev(): boolean {
    return !this.auditLoading && this.auditOffset > 0;
  }

  auditCanNext(): boolean {
    return !this.auditLoading && this.auditOffset + this.auditLimit < this.auditTotal;
  }

  auditPageStart(): number {
    return this.auditTotal === 0 ? 0 : this.auditOffset + 1;
  }

  auditPageEnd(): number {
    return Math.min(this.auditOffset + this.auditEvents.length, this.auditTotal);
  }

  createUser(): void {
    this.userError = '';
    this.api.createUser(this.newUser).subscribe({
      next: () => {
        this.newUser = {
          username: '',
          displayName: '',
          email: '',
          password: '',
          role: 'first-level',
        };
        this.loadUsers();
      },
      error: () => {
        this.userError = 'Benutzer konnte nicht angelegt werden.';
        this.changeDetector.detectChanges();
      },
    });
  }

  resetPassword(user: OpsUserSummary): void {
    const password = this.resetPasswords[user.username];
    if (!password) {
      this.userError = 'Neues Passwort fehlt.';
      return;
    }
    this.api.resetPassword(user.username, password).subscribe({
      next: () => {
        this.resetPasswords[user.username] = '';
        this.loadUsers();
      },
      error: () => {
        this.userError = 'Passwort konnte nicht gesetzt werden.';
        this.changeDetector.detectChanges();
      },
    });
  }

  setUserActive(user: OpsUserSummary, active: boolean): void {
    this.api.setUserActive(user.username, active).subscribe({
      next: () => this.loadUsers(),
      error: () => {
        this.userError = 'Benutzerstatus konnte nicht geändert werden.';
        this.changeDetector.detectChanges();
      },
    });
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

  inputHelp(name: string): string {
    return INPUT_HELP[name] || '';
  }

  inputOptions(action: OperationAction, input: ActionInputDefinition): readonly SelectOption[] {
    if (input.optionsSource === 'varlens-users') {
      return this.varlensUserOptions(action);
    }
    return (input.options || []).map((option) => ({ value: option, label: option }));
  }

  roleLabel(role: string): string {
    return ROLE_LABELS[role as OpsRole] || role;
  }

  appLabel(): string {
    return TARGET_APP_LABELS[this.selectedApp] || this.selectedApp;
  }

  stageLabel(): string {
    return TARGET_ENVIRONMENT_LABELS[this.selectedEnvironment] || this.selectedEnvironment;
  }

  isUserOperation(action: OperationAction): boolean {
    return action.id.startsWith('varlens-user-');
  }

  /** True when an action has inputs the operator must type (required, no default). */
  needsInput(action: OperationAction): boolean {
    return this.actionSpecificInputs(action).some(
      (input) => input.required && !input.defaultValue
    );
  }

  /** Optional, defaulted inputs that hide behind an "Optionen" disclosure. */
  hasOptionalInputs(action: OperationAction): boolean {
    return this.hasConfig(action) && !this.needsInput(action);
  }

  optionsOpen(action: OperationAction): boolean {
    return this.needsInput(action) || this.openOptions.has(action.id);
  }

  /** Whether the inline parameter form should be rendered for this action. */
  showInputs(action: OperationAction): boolean {
    return this.hasConfig(action) && this.optionsOpen(action);
  }

  toggleOptions(action: OperationAction): void {
    if (this.openOptions.has(action.id)) {
      this.openOptions.delete(action.id);
    } else {
      this.openOptions.add(action.id);
    }
  }

  actionReady(action: OperationAction): boolean {
    return !this.missingRequiredInputs(action);
  }

  /** Diagnostics run immediately; mutations require an explicit confirm first. */
  run(action: OperationAction): void {
    if (this.runningActionId || !this.actionReady(action)) {
      return;
    }
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

  runningActionTitle(): string {
    return this.runningActionId ? this.titleFor(this.runningActionId) : '';
  }

  runningActionDurationHint(): string {
    const actionId = this.runningActionId;
    if (actionId === 'argo-sync') {
      return 'GitOps-Abgleich läuft. Meist 30 bis 120 Sekunden.';
    }
    if (actionId === 'rollout-restart') {
      return 'App-Neustart läuft. Meist 30 bis 90 Sekunden.';
    }
    if (actionId.startsWith('varlens-user-')) {
      return 'Nutzeroperation läuft. Meist 10 bis 60 Sekunden.';
    }
    if (this.actionById(actionId)?.kind === 'diagnostic') {
      return 'Prüfung läuft. Meist 5 bis 20 Sekunden.';
    }
    return 'Aktion läuft. Meist unter 30 Sekunden.';
  }

  statusLabel(status: ActionStatus): string {
    return STATUS_LABELS[status] || status;
  }

  auditTarget(event: OpsAuditEvent): string {
    if (!event.targetApp && !event.targetEnvironment) {
      return '-';
    }
    return `${event.targetApp || '-'}/${event.targetEnvironment || '-'}`;
  }

  auditMetadata(event: OpsAuditEvent): string {
    const entries = Object.entries(event.metadata || {});
    if (!entries.length) {
      return '-';
    }
    return entries
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
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
          if (action.id.startsWith('varlens-user-')) {
            this.loadVarLensUsers();
          }
          this.changeDetector.detectChanges();
        },
        error: () => {
          this.runError = 'Aktion konnte nicht ausgeführt werden.';
          this.changeDetector.detectChanges();
        },
      });
  }

  private actionById(actionId: string): OperationAction | undefined {
    return [...this.diagnostics, ...this.mutations].find(
      (action) => action.id === actionId
    );
  }

  private missingRequiredInputs(action: OperationAction): boolean {
    const values = this.inputs[action.id] || {};
    return this.actionSpecificInputs(action).some(
      (input) => input.required && !String(values[input.name] || '').trim()
    );
  }

  private hasVarLensUserSelector(): boolean {
    return this.userMutations.some((action) =>
      this.actionSpecificInputs(action).some(
        (input) => input.optionsSource === 'varlens-users'
      )
    );
  }

  private varlensUserOptions(action: OperationAction): readonly SelectOption[] {
    return this.varlensUsers
      .filter((user) => {
        if (action.id === 'varlens-user-block') {
          return user.active;
        }
        if (action.id === 'varlens-user-unblock') {
          return !user.active;
        }
        return true;
      })
      .map((user) => {
        const status = user.active ? 'aktiv' : 'gesperrt';
        return {
          value: user.username,
          label: `${user.username} (${status})`,
        };
      });
  }
}
