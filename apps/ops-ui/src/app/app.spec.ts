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
  role: 'operator',
  kind: 'mutation',
  targetApp: 'varlens',
  inputs: [],
};

const contract = {
  app: 'varlens',
  environment: 'test',
  endpoints: {
    livenessPath: '/livez',
    readinessPath: '/readyz',
    healthPath: '/healthz',
    internalBaseUrl: 'http://varlens.varlens-test.svc.cluster.local',
    livenessUrl: 'http://varlens.varlens-test.svc.cluster.local/livez',
    readinessUrl: 'http://varlens.varlens-test.svc.cluster.local/readyz',
    healthUrl: 'http://varlens.varlens-test.svc.cluster.local/healthz',
  },
  workload: {
    namespace: 'varlens-test',
    deployment: 'varlens',
    serviceName: 'varlens',
    podSelector: 'app.kubernetes.io/instance=varlens',
    statelessRestartAllowed: true,
  },
  argo: { application: 'varlens-test', namespace: 'argocd-dev-test' },
  observability: {
    prometheusMetrics: [
      {
        name: 'http_requests_total',
        description: 'Requests',
        requiredLabels: ['app'],
        sampleQuery: 'sum(http_requests_total)',
      },
    ],
    loki: {
      selector: '{namespace="varlens-test"}',
      requiredFields: ['request_id'],
      redactedFields: ['token'],
      sampleQuery: '{namespace="varlens-test"} | json',
    },
    grafanaDashboards: [{ label: 'VarLens test', url: 'http://grafana.example/d/varlens' }],
  },
  smoke: {
    jobLabelSelector: 'app.kubernetes.io/name=varlens',
    triggerAllowed: true,
    coreChecks: ['health-contract'],
  },
  firstLevel: {
    issueClasses: ['app-unreachable'],
    evidenceSources: ['http', 'prometheus'],
    escalationFields: ['request_id', 'failure_class'],
  },
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
    contracts: unknown[] = [contract],
    view: 'diagnose' | 'operations' | 'contract' = 'operations'
  ) {
    const fixture = TestBed.createComponent(App);
    // Set the active tab before the first change detection to keep the rendered state stable.
    fixture.componentInstance.activeView = view;
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/me').flush({ principal });
    http.expectOne('/api/actions').flush({ actions });
    http.expectOne('/api/contracts').flush({ contracts });
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
      [contract],
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

  it('should render only the actions the API returns', async () => {
    const { fixture } = bootstrap(
      { user: 'support', groups: [], roles: ['first-level'] },
      [diagnostic]
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelectorAll('[data-testid="action-card"]')).toHaveLength(1);
    expect(compiled.textContent).toContain('Endpoint prüfen');
  });

  it('renders URL evidence as a link and long evidence as a log block', async () => {
    const { fixture, http } = bootstrap(
      { user: 'support', groups: [], roles: ['first-level'] },
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
        actor: 'support',
        role: 'first-level',
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

  it('should hide the config wheel in easy mode', async () => {
    const { fixture } = bootstrap(
      { user: 'support', groups: [], roles: ['first-level'] },
      [diagnosticWithConfig]
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance.expertMode).toBe(false);
    expect(compiled.querySelector('[data-testid="config-button"]')).toBeNull();
  });

  it('should show the config wheel in expert mode', async () => {
    localStorage.setItem('ops.expertMode', '1');
    const { fixture } = bootstrap(
      { user: 'support', groups: [], roles: ['first-level'] },
      [diagnosticWithConfig]
    );
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance.expertMode).toBe(true);
    expect(compiled.querySelector('[data-testid="config-button"]')).toBeTruthy();
  });

  it('should render the standardized contract in the Standard-Setup view', async () => {
    const { fixture } = bootstrap(
      { user: 'support', groups: [], roles: ['first-level'] },
      [diagnostic],
      [contract],
      'contract'
    );
    await fixture.whenStable();
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const panel = compiled.querySelector('[data-testid="contract-panel"]');
    expect(panel).toBeTruthy();
    expect(panel?.textContent).toContain('varlens-test');
    expect(panel?.textContent).toContain('http_requests_total');
    expect(panel?.textContent).toContain('App nicht erreichbar');
  });

  it('should not run a mutation until it is confirmed', async () => {
    const { fixture, http } = bootstrap(
      { user: 'op', groups: [], roles: ['operator'] },
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
          actor: 'op',
          role: 'operator',
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
