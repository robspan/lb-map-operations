import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { DiagnosePanel } from './diagnose-panel';

function runWithFinding(role: 'admin' | 'first-level' = 'admin') {
  return {
    runId: 'd1',
    actionId: 'diagnose-target',
    status: 'succeeded',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    targetApp: 'varlens',
    targetEnvironment: 'test',
    actor: 'admin',
    role,
    summary: 'Diagnose abgeschlossen.',
    evidence: [],
    diagnosis: {
      targetApp: 'varlens',
      targetEnvironment: 'test',
      generatedAt: new Date().toISOString(),
      findings: [
        {
          findingId: 'argocd-out-of-sync',
          severity: 'critical',
          confidence: 'high',
          summary: 'ArgoCD meldet OutOfSync.',
          likelyCause: 'Der Cluster-Stand weicht von Git ab.',
          evidence: [{ label: 'ArgoCD Sync', value: 'OutOfSync' }],
          remedies: [
            {
              remedyId: 'argo-sync-no-prune',
              title: 'ArgoCD Sync ausführen',
              description:
                'Wendet den GitOps-Sollzustand erneut ohne Prune an.',
              actionId: 'argo-sync',
              requiredRole: 'admin',
              risk: 'low',
              enabled: role === 'admin',
              disabledReason:
                role === 'admin' ? undefined : 'Benötigt Rolle admin.',
            },
            {
              remedyId: 'read-argo-status',
              title: 'ArgoCD Details anzeigen',
              description: 'Zeigt Sync und Health.',
              actionId: 'argo-status',
              requiredRole: 'first-level',
              risk: 'none',
              enabled: true,
            },
          ],
        },
      ],
    },
  };
}

function runWithoutFindings() {
  return {
    ...runWithFinding(),
    runId: 'd2',
    diagnosis: {
      targetApp: 'varlens',
      targetEnvironment: 'test',
      generatedAt: new Date().toISOString(),
      findings: [
        {
          findingId: 'no-obvious-fault',
          severity: 'info',
          confidence: 'medium',
          summary: 'Keine eindeutige Standardstörung erkannt.',
          likelyCause: 'Die geprüften Standardsignale sind unauffällig.',
          evidence: [],
          remedies: [],
        },
      ],
    },
  };
}

function repairStreamResponse(result: unknown) {
  const phases = [
    {
      type: 'phase',
      runId: 'repair-1',
      phase: {
        phaseId: 'before-scan',
        label: 'Aktuellen Zustand prüfen',
        status: 'succeeded',
        detail: '1 Befund(e).',
        estimatedSeconds: 15,
      },
    },
    {
      type: 'phase',
      runId: 'repair-1',
      phase: {
        phaseId: 'repair-argo-sync',
        label: 'Reparatur ausführen: GitOps-Abgleich',
        status: 'succeeded',
        detail: 'Sync angefordert.',
        estimatedSeconds: 30,
      },
    },
    {
      type: 'phase',
      runId: 'repair-1',
      phase: {
        phaseId: 'wait-gitops',
        label: 'GitOps-Abgleich abwarten',
        status: 'succeeded',
        detail: 'ArgoCD meldet keinen laufenden Sync mehr.',
        estimatedSeconds: 90,
      },
    },
    {
      type: 'phase',
      runId: 'repair-1',
      phase: {
        phaseId: 'after-scan',
        label: 'Nach Reparatur erneut prüfen',
        status: 'succeeded',
        detail: '0 Befund(e).',
        estimatedSeconds: 15,
      },
    },
  ];
  const events = [
    {
      type: 'started',
      runId: 'repair-1',
      targetApp: 'varlens',
      targetEnvironment: 'test',
      startedAt: new Date().toISOString(),
      estimatedSeconds: 120,
    },
    ...phases,
    { type: 'result', runId: 'repair-1', result },
  ];
  const body = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  const encoded = new TextEncoder().encode(body);
  let sent = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) {
            return { done: true, value: undefined };
          }
          sent = true;
          return { done: false, value: encoded };
        },
      }),
    },
  };
}

function mockFetch(response: unknown) {
  const originalFetch = globalThis.fetch;
  const fetchMock = jest.fn().mockResolvedValue(response);
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: fetchMock,
  });
  return {
    fetchMock,
    restore: () => {
      if (originalFetch) {
        Object.defineProperty(globalThis, 'fetch', {
          configurable: true,
          writable: true,
          value: originalFetch,
        });
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    },
  };
}

async function settleUi(fixture: ComponentFixture<DiagnosePanel>) {
  await fixture.whenStable();
  await Promise.resolve();
  fixture.detectChanges();
}

describe('DiagnosePanel', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DiagnosePanel],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideNoopAnimations(),
      ],
    }).compileComponents();
  });

  function create(selectedRun?: unknown, roles: readonly string[] = ['admin']) {
    const fixture = TestBed.createComponent(DiagnosePanel);
    fixture.componentRef.setInput('app', 'varlens');
    fixture.componentRef.setInput('environment', 'test');
    fixture.componentRef.setInput('roles', roles);
    if (selectedRun) {
      // Set before first change detection so the rendered state is stable.
      (
        fixture.componentInstance as unknown as { selectedRun: unknown }
      ).selectedRun = selectedRun;
    }
    fixture.detectChanges();
    return fixture;
  }

  it('shows the diagnosis button and an empty state initially', () => {
    const fixture = create();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(
      compiled.querySelector('[data-testid="diagnose-start"]'),
    ).toBeTruthy();
    expect(compiled.textContent).toContain('Noch keine Diagnose');
  });

  it('renders findings, severity and cause without per-finding remedy actions', () => {
    const fixture = create(runWithFinding());
    const compiled = fixture.nativeElement as HTMLElement;

    expect(compiled.querySelectorAll('[data-testid="finding"]')).toHaveLength(
      1,
    );
    expect(compiled.textContent).toContain('ArgoCD meldet OutOfSync.');
    expect(compiled.textContent).toContain('Mögliche Ursache:');
    expect(compiled.textContent).toContain('Automatische Reparatur');
    expect(compiled.textContent).not.toContain('Vorgeschlagene Abhilfe');
    expect(compiled.querySelector('[data-testid="remedy-run"]')).toBeNull();
    expect(compiled.querySelector('[data-testid="repair-all"]')).toBeTruthy();

    // Evidence is hidden until expanded.
    expect(compiled.querySelector('.evidence')).toBeNull();
    (
      compiled.querySelector(
        '[data-testid="finding-details"]',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    expect(compiled.querySelector('.evidence')?.textContent).toContain(
      'OutOfSync',
    );
  });

  it('does not show unconfigured diagnosis checks', () => {
    const fixture = TestBed.createComponent(DiagnosePanel);
    fixture.componentRef.setInput('app', 'varlens');
    fixture.componentRef.setInput('environment', 'test');
    fixture.componentRef.setInput('roles', ['admin']);
    const component = fixture.componentInstance as unknown as {
      stepsExpanded: boolean;
      upsertStep: (step: {
        stepId: string;
        label: string;
        status: 'running' | 'succeeded' | 'failed' | 'skipped';
        detail?: string;
      }) => void;
    };

    component.upsertStep({
      stepId: 'public-health',
      label: 'Nutzer-Erreichbarkeit prüfen',
      status: 'skipped',
      detail: 'Keine öffentliche Health-URL konfiguriert.',
    });
    component.upsertStep({
      stepId: 'prometheus',
      label: 'Betriebssignale prüfen',
      status: 'running',
    });
    component.stepsExpanded = true;
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).not.toContain('Nutzer-Erreichbarkeit prüfen');
    expect(compiled.textContent).not.toContain('Keine öffentliche Health-URL');
    expect(compiled.textContent).toContain('Betriebssignale prüfen');
  });

  it('runs the diagnosis repair endpoint and switches to the after-scan result', async () => {
    const fixture = create(runWithFinding());
    const compiled = fixture.nativeElement as HTMLElement;
    const { fetchMock, restore } = mockFetch(
      repairStreamResponse({
        beforeRun: runWithFinding(),
        repairRuns: [
          {
            runId: 'r9',
            actionId: 'argo-sync',
            status: 'succeeded',
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            targetApp: 'varlens',
            targetEnvironment: 'test',
            actor: 'admin',
            role: 'admin',
            summary: 'Sync angefordert.',
            evidence: [],
          },
        ],
        afterRun: runWithoutFindings(),
        resolvedFindingIds: ['argocd-out-of-sync'],
        remainingFindingIds: [],
        summary: 'Automatische Reparatur abgeschlossen: 1 Befund(e) behoben.',
      }),
    );

    (
      compiled.querySelector('[data-testid="repair-all"]') as HTMLButtonElement
    ).click();
    await settleUi(fixture);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/diagnosis/repair/stream',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(compiled.textContent).toContain('1 Befund(e) behoben');
    expect(compiled.textContent).toContain(
      'Keine eindeutige Standardstörung erkannt.',
    );
    expect(compiled.textContent).toContain('GitOps-Abgleich: Erfolg');
    expect(compiled.textContent).toContain('GitOps-Abgleich abwarten');
    expect(compiled.querySelector('[data-testid="repair-progress"]')).toBeTruthy();
    restore();
  });

  it('shows the same single repair control for first-level users', async () => {
    const fixture = create(runWithFinding('first-level'), ['first-level']);
    const compiled = fixture.nativeElement as HTMLElement;
    const { restore } = mockFetch(
      repairStreamResponse({
        beforeRun: runWithFinding('first-level'),
        repairRuns: [
          {
            runId: 'r10',
            actionId: 'argo-sync',
            status: 'succeeded',
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            targetApp: 'varlens',
            targetEnvironment: 'test',
            actor: 'support',
            role: 'first-level',
            summary: 'Sync angefordert.',
            evidence: [],
          },
        ],
        afterRun: {
          ...runWithFinding('first-level'),
          runId: 'd3',
          diagnosis: {
            ...runWithFinding('first-level').diagnosis,
            findings: [
              {
                ...runWithFinding('first-level').diagnosis.findings[0],
                findingId: 'liveness-failing',
                summary: 'Liveness-Endpunkt antwortet nicht erfolgreich.',
              },
            ],
          },
        },
        resolvedFindingIds: ['argocd-out-of-sync'],
        remainingFindingIds: ['liveness-failing'],
        summary:
          'Automatische Reparatur teilweise erfolgreich: 1 Befund(e) behoben, 1 weiterhin sichtbar.',
      }),
    );

    expect(compiled.querySelector('[data-testid="repair-all"]')).toBeTruthy();
    expect(compiled.querySelector('[data-testid="remedy-run"]')).toBeNull();
    expect(compiled.textContent).not.toContain('Risiko:');
    expect(compiled.textContent).not.toContain('Benötigt Rolle admin');

    (
      compiled.querySelector('[data-testid="repair-all"]') as HTMLButtonElement
    ).click();
    await settleUi(fixture);

    expect(compiled.textContent).toContain('teilweise erfolgreich');
    expect(compiled.textContent).toContain('weiterhin sichtbar');
    expect(compiled.textContent).not.toContain('Vorgeschlagene Abhilfe');
    restore();
  });

  it('does not show a repair button when the diagnosis has no repairable issue', () => {
    const fixture = create(runWithoutFindings());
    const compiled = fixture.nativeElement as HTMLElement;

    expect(compiled.textContent).toContain(
      'Keine eindeutige Standardstörung erkannt.',
    );
    expect(compiled.querySelector('[data-testid="repair-all"]')).toBeNull();
  });
});
