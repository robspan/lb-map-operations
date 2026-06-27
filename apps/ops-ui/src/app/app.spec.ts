import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { App } from './app';

const diagnostic = {
  id: 'endpoint-check',
  title: 'Endpoint prüfen',
  description: 'Health endpoint prüfen.',
  role: 'admin',
  kind: 'diagnostic',
  targetApp: 'varlens',
  inputs: [],
};

const diagnosticWithConfig = {
  id: 'platform-overview',
  title: 'Betriebsüberblick',
  description: 'Status zusammenfassen.',
  role: 'admin',
  kind: 'diagnostic',
  targetApp: 'varlens',
  inputs: [
    { name: 'targetApp', label: 'App', type: 'select', required: true, options: ['varlens'], defaultValue: 'varlens' },
    { name: 'targetEnvironment', label: 'Umgebung', type: 'select', required: true, options: ['dev', 'test'], defaultValue: 'test' },
    { name: 'tailLines', label: 'Zeilen', type: 'select', required: true, options: ['40', '80'], defaultValue: '80' },
  ],
};

const mutation = {
  id: 'rollout-restart',
  title: 'Stateless Restart',
  description: 'Deployment neu starten.',
  role: 'admin',
  kind: 'mutation',
  targetApp: 'varlens',
  inputs: [],
};

const varlensUserMutation = {
  id: 'varlens-user-create',
  title: 'VarLens-Nutzer anlegen',
  description: 'Normalen VarLens-Nutzer anlegen.',
  role: 'admin',
  kind: 'mutation',
  targetApp: 'varlens',
  inputs: [
    { name: 'targetApp', label: 'App', type: 'select', required: true, options: ['varlens'], defaultValue: 'varlens' },
    { name: 'targetEnvironment', label: 'Umgebung', type: 'select', required: true, options: ['dev', 'test'], defaultValue: 'test' },
    { name: 'username', label: 'VarLens-Benutzer', type: 'text', required: true },
    { name: 'displayName', label: 'Name', type: 'text', required: true },
    { name: 'initialPassword', label: 'Initiales Passwort', type: 'text', required: true, sensitive: true },
  ],
};

const varlensUserBlockMutation = {
  id: 'varlens-user-block',
  title: 'VarLens-Nutzer sperren',
  description: 'VarLens-Nutzer sperren.',
  role: 'admin',
  kind: 'mutation',
  targetApp: 'varlens',
  inputs: [
    { name: 'targetApp', label: 'App', type: 'select', required: true, options: ['varlens'], defaultValue: 'varlens' },
    { name: 'targetEnvironment', label: 'Umgebung', type: 'select', required: true, options: ['dev', 'test'], defaultValue: 'test' },
    { name: 'username', label: 'VarLens-Benutzer', type: 'select', required: true, optionsSource: 'varlens-users' },
  ],
};

const varlensUserUnblockMutation = {
  id: 'varlens-user-unblock',
  title: 'VarLens-Nutzer entsperren',
  description: 'VarLens-Nutzer entsperren.',
  role: 'admin',
  kind: 'mutation',
  targetApp: 'varlens',
  inputs: [
    { name: 'targetApp', label: 'App', type: 'select', required: true, options: ['varlens'], defaultValue: 'varlens' },
    { name: 'targetEnvironment', label: 'Umgebung', type: 'select', required: true, options: ['dev', 'test'], defaultValue: 'test' },
    { name: 'username', label: 'VarLens-Benutzer', type: 'select', required: true, optionsSource: 'varlens-users' },
  ],
};

describe('App', () => {
  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations()],
    }).compileComponents();
  });

  function bootstrap(
    principal: unknown,
    actions: unknown[],
    view: 'diagnose' | 'app-varlens' | 'platform' | 'users' | 'audit' = 'app-varlens'
  ) {
    const fixture = TestBed.createComponent(App);
    // Set the active tab before the first change detection to keep the rendered state stable.
    fixture.componentInstance.activeView = view;
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/me').flush({
      principal,
      targetApp: 'varlens',
      targetEnvironment: 'test',
    });
    http.expectOne('/api/actions').flush({ actions });
    return { fixture, http };
  }

  it('should render the toolbar title', async () => {
    const { fixture } = bootstrap({ user: 'support', groups: [], roles: ['first-level'] }, []);
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('mat-toolbar')?.textContent).toContain('LB-MAP Operations');
  });

  it('defaults to the diagnose tab with a diagnosis button', async () => {
    const { fixture } = bootstrap(
      { user: 'support', groups: [], roles: ['first-level'] },
      [diagnostic],
      'diagnose'
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('[data-testid="diagnose-start"]')).toBeTruthy();
    expect(compiled.querySelector('[data-testid="action-card"]')).toBeNull();
  });

  it('initializes with the diagnose view selected', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance.activeView).toBe('diagnose');
  });

  it('does not render navigation for first-level users', async () => {
    const { fixture } = bootstrap(
      { user: 'support', groups: [], roles: ['first-level'] },
      [diagnostic]
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance.activeView).toBe('diagnose');
    expect(compiled.querySelector('[data-testid="side-nav"]')).toBeNull();
    expect(compiled.querySelector('.role-chip')).toBeNull();
    expect(compiled.textContent).not.toContain('First Level');
    expect(compiled.textContent).not.toContain('Operationen');
    expect(compiled.querySelector('[data-testid="action-card"]')).toBeNull();
  });

  it('renders left navigation for admins', async () => {
    const { fixture } = bootstrap(
      { user: 'ops-admin', groups: [], roles: ['admin'] },
      [diagnostic],
      'diagnose'
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    const nav = compiled.querySelector('[data-testid="side-nav"]');
    expect(nav).toBeTruthy();
    expect(nav?.textContent).toContain('Diagnose');
    expect(nav?.textContent).toContain('VarLens');
    expect(nav?.textContent).toContain('Infrastruktur');
    expect(nav?.textContent).not.toContain('Operationen');
    expect(nav?.textContent).toContain('Operations-Konten');
    expect(nav?.textContent).toContain('Audit');
  });

  it('renders the deployment target as read-only context', async () => {
    const { fixture } = bootstrap(
      { user: 'ops-admin', groups: [], roles: ['admin'] },
      [diagnostic]
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    const target = compiled.querySelector('.target');

    expect(target?.textContent).toContain('Stage');
    expect(target?.textContent).toContain('Test');
    expect(target?.querySelector('mat-select')).toBeNull();
    expect(target?.textContent).not.toContain('Umgebung');
  });

  it('renders URL evidence as a link and long evidence as a log block', async () => {
    const { fixture, http } = bootstrap(
      { user: 'ops-admin', groups: [], roles: ['admin'] },
      [diagnostic]
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;

    (compiled.querySelector('[data-testid="run-action"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    http.expectOne('/api/actions/endpoint-check/runs').flush({
      run: {
        runId: 'r2',
        actionId: 'endpoint-check',
        status: 'succeeded',
        startedAt: new Date().toISOString(),
        targetApp: 'varlens',
        targetEnvironment: 'test',
        actor: 'ops-admin',
        role: 'admin',
        summary: 'ok',
        evidence: [
          { label: 'Grafana', value: 'https://grafana.example/d/x' },
          { label: 'Notiz', value: 'k'.repeat(200) },
        ],
      },
    });
    await fixture.whenStable();
    fixture.detectChanges();

    const link = compiled.querySelector('.evidence-value a') as HTMLAnchorElement;
    expect(link?.getAttribute('href')).toBe('https://grafana.example/d/x');
    expect(compiled.querySelector('.evidence-log')?.textContent).toContain('kkk');
  });

  it('reveals optional diagnostic parameters inline, not in a modal', async () => {
    const { fixture } = bootstrap(
      { user: 'ops-admin', groups: [], roles: ['admin'] },
      [diagnosticWithConfig]
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;

    // No modal / config button / expert toggle anymore.
    expect(compiled.querySelector('[data-testid="config-button"]')).toBeNull();
    expect(compiled.querySelector('[data-testid="expert-toggle"]')).toBeNull();
    // Optional inputs are hidden until the inline "Optionen" disclosure is opened.
    expect(compiled.querySelector('[data-field="tailLines"]')).toBeNull();

    (compiled.querySelector('[data-testid="options-toggle"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(compiled.querySelector('[data-field="tailLines"]')).toBeTruthy();
  });

  it('shows required mutation inputs inline and blocks run until they are filled', async () => {
    const { fixture } = bootstrap(
      { user: 'ops-admin', groups: [], roles: ['admin'] },
      [varlensUserMutation]
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;

    // Required-input mutation shows its fields inline immediately (no "Optionen", no modal).
    expect(compiled.querySelector('[data-field="username"]')).toBeTruthy();
    expect(compiled.querySelector('[data-testid="config-button"]')).toBeNull();
    expect(compiled.querySelector('[data-testid="options-toggle"]')).toBeNull();
    expect((compiled.querySelector('[data-testid="run-action"]') as HTMLButtonElement).disabled).toBe(true);

    // Run is gated on the required inputs being filled.
    const component = fixture.componentInstance as unknown as {
      userMutations: { id: string }[];
      inputs: Record<string, Record<string, string>>;
      actionReady: (action: unknown) => boolean;
    };
    const action = component.userMutations[0];
    expect(component.actionReady(action)).toBe(false);
    const values = component.inputs['varlens-user-create'];
    values['username'] = 'lab-user';
    values['displayName'] = 'Lab User';
    values['initialPassword'] = 'secret-init';
    expect(component.actionReady(action)).toBe(true);
  });

  it('renders the DB-backed user administration table for admins', async () => {
    const { fixture, http } = bootstrap(
      { user: 'ops-admin', groups: [], roles: ['admin'] },
      [diagnostic],
      'users'
    );
    http.expectOne('/api/auth/users').flush({
      users: [
        {
          id: '1',
          username: 'ops-admin',
          displayName: 'Operations Admin',
          email: 'ops-admin@example.invalid',
          role: 'admin',
          active: true,
          mustChangePassword: false,
        },
      ],
    });
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('Operations-Konto anlegen');
    expect(compiled.textContent).toContain('keine VarLens-Nutzerverwaltung');
    expect(compiled.textContent).toContain('ops-admin');
    expect(compiled.textContent).toContain('Operations Admin');
  });

  it('does not show first-level diagnostic actions on the admin operations page', async () => {
    const { fixture } = bootstrap(
      { user: 'ops-admin', groups: [], roles: ['admin'] },
      [
        { ...diagnostic, id: 'platform-overview', title: 'Betriebsüberblick', role: 'admin' },
        { ...diagnostic, id: 'escalation-bundle', title: 'Eskalationspaket', role: 'first-level' },
        { ...diagnostic, id: 'smoke-result', title: 'Smoke-Status', role: 'first-level' },
      ]
    );
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('Betriebsüberblick');
    expect(compiled.textContent).not.toContain('Eskalationspaket');
    expect(compiled.textContent).not.toContain('Smoke-Status');
  });

  it('renders recent audit events for admins', async () => {
    const { fixture, http } = bootstrap(
      { user: 'ops-admin', groups: [], roles: ['admin'] },
      [diagnostic],
      'audit'
    );
    http.expectOne('/api/audit/events?limit=25&offset=0').flush({
      events: [
        {
          id: '2',
          occurredAt: new Date().toISOString(),
          actor: 'ops-admin',
          role: 'admin',
          action: 'auth-login',
          result: 'success',
          metadata: {},
        },
      ],
      total: 1,
      limit: 25,
      offset: 0,
    });
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('Audit-Aktivität');
    expect(compiled.textContent).toContain('1-1 von 1');
    expect(compiled.textContent).toContain('auth-login');
    expect(compiled.textContent).toContain('ops-admin');
  });

  it('should not run a mutation until it is confirmed', async () => {
    const { fixture, http } = bootstrap(
      { user: 'ops-admin', groups: [], roles: ['admin'] },
      [mutation],
      'platform'
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;

    (compiled.querySelector('[data-testid="run-action"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    // First click only arms the confirmation; no request is sent yet.
    http.expectNone('/api/actions/rollout-restart/runs');
    const confirmButton = compiled.querySelector('[data-testid="confirm-action"]') as HTMLButtonElement;
    expect(confirmButton).toBeTruthy();

    confirmButton.click();
    fixture.detectChanges();

    http
      .expectOne('/api/actions/rollout-restart/runs')
      .flush({
        run: {
          runId: 'r1',
          actionId: 'rollout-restart',
          status: 'succeeded',
          startedAt: new Date().toISOString(),
          targetApp: 'varlens',
          targetEnvironment: 'test',
          actor: 'ops-admin',
          role: 'admin',
          summary: 'Neustart angewendet.',
          evidence: [],
        },
      });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(compiled.textContent).toContain('Neustart angewendet.');
  });

  it('renders VarLens app tools separately from infrastructure operations', async () => {
    const { fixture, http } = bootstrap(
      { user: 'ops-admin', groups: [], roles: ['admin'] },
      [diagnostic, varlensUserMutation, mutation]
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;

    expect(compiled.textContent).toContain('VarLens-Nutzer verwalten');
    expect(compiled.textContent).toContain('VarLens-Nutzer anlegen');
    expect(compiled.textContent).toContain('Prüfen und Nachsehen');
    expect(compiled.textContent).not.toContain('Plattform-Eingriffe');
    const pageText = compiled.textContent || '';
    expect(pageText.indexOf('VarLens-Nutzer verwalten')).toBeLessThan(
      pageText.indexOf('Prüfen und Nachsehen')
    );

    const runButtons = compiled.querySelectorAll('[data-testid="run-action"]');
    (runButtons[0] as HTMLButtonElement).click();
    fixture.detectChanges();

    http.expectNone('/api/actions/varlens-user-create/runs');
    expect(document.body.textContent).toContain('VarLens-Nutzer anlegen');
  });

  it('renders infrastructure operations on their own page', async () => {
    const { fixture } = bootstrap(
      { user: 'ops-admin', groups: [], roles: ['admin'] },
      [diagnostic, varlensUserMutation, mutation],
      'platform'
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;

    expect(compiled.textContent).toContain('Plattform-Eingriffe');
    expect(compiled.textContent).toContain('Stateless Restart');
    expect(compiled.textContent).not.toContain('VarLens-Nutzer verwalten');
    expect(compiled.textContent).not.toContain('Prüfen und Nachsehen');
  });

  it('loads VarLens users for lifecycle dropdowns and separates block from unblock choices', async () => {
    const { fixture, http } = bootstrap(
      { user: 'ops-admin', groups: [], roles: ['admin'] },
      [varlensUserBlockMutation, varlensUserUnblockMutation]
    );
    http.expectOne('/api/apps/varlens/environments/test/varlens-users').flush({
      users: [
        {
          username: 'active-user',
          displayName: 'Active User',
          role: 'user',
          active: true,
          privateDbStatus: 'active',
        },
        {
          username: 'blocked-user',
          displayName: 'Blocked User',
          role: 'user',
          active: false,
          privateDbStatus: 'disabled',
        },
      ],
    });
    await fixture.whenStable();
    fixture.detectChanges();

    const component = fixture.componentInstance;
    expect(component.inputOptions(component.userMutations[0], component.userMutations[0].inputs[2])).toEqual([
      { value: 'active-user', label: 'active-user (aktiv)' },
    ]);
    expect(component.inputOptions(component.userMutations[1], component.userMutations[1].inputs[2])).toEqual([
      { value: 'blocked-user', label: 'blocked-user (gesperrt)' },
    ]);
    expect(component.actionReady(component.userMutations[0])).toBe(false);
    component.inputs['varlens-user-block']['username'] = 'active-user';
    expect(component.actionReady(component.userMutations[0])).toBe(true);
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });
});
