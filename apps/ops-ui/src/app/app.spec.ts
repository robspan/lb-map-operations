import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { App } from './app';

const diagnostic = {
  id: 'endpoint-check',
  title: 'Endpoint prüfen',
  description: 'Health endpoint prüfen.',
  role: 'first-level',
  kind: 'diagnostic',
  targetApp: 'varlens',
  inputs: [],
};

const diagnosticWithConfig = {
  id: 'log-summary',
  title: 'Log-Auszug',
  description: 'Logs lesen.',
  role: 'first-level',
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
    view: 'diagnose' | 'operations' | 'users' | 'audit' = 'operations'
  ) {
    const fixture = TestBed.createComponent(App);
    // Set the active tab before the first change detection to keep the rendered state stable.
    fixture.componentInstance.activeView = view;
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/me').flush({ principal });
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

  it('forces first-level users back to the diagnose tab', async () => {
    const { fixture } = bootstrap(
      { user: 'support', groups: [], roles: ['first-level'] },
      [diagnostic]
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance.activeView).toBe('diagnose');
    expect(compiled.textContent).not.toContain('Operationen');
    expect(compiled.querySelector('[data-testid="action-card"]')).toBeNull();
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

  it('shows action configuration controls for admins without an expert toggle', async () => {
    const { fixture } = bootstrap(
      { user: 'ops-admin', groups: [], roles: ['admin'] },
      [diagnosticWithConfig]
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('[data-testid="config-button"]')).toBeTruthy();
    expect(compiled.querySelector('[data-testid="expert-toggle"]')).toBeNull();
    expect(compiled.textContent).not.toContain('Standard-Setup');
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
    expect(compiled.textContent).toContain('Benutzer anlegen');
    expect(compiled.textContent).toContain('ops-admin');
    expect(compiled.textContent).toContain('Operations Admin');
  });

  it('renders recent audit events for admins', async () => {
    const { fixture, http } = bootstrap(
      { user: 'ops-admin', groups: [], roles: ['admin'] },
      [diagnostic],
      'audit'
    );
    http.expectOne('/api/audit/events?limit=100').flush({
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
    });
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('Audit-Aktivität');
    expect(compiled.textContent).toContain('auth-login');
    expect(compiled.textContent).toContain('ops-admin');
  });

  it('should not run a mutation until it is confirmed', async () => {
    const { fixture, http } = bootstrap(
      { user: 'ops-admin', groups: [], roles: ['admin'] },
      [mutation]
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

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });
});
