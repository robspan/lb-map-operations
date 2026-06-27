import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { DiagnosePanel } from './diagnose-panel';

function runWithFinding() {
  return {
    runId: 'd1',
    actionId: 'diagnose-target',
    status: 'succeeded',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    targetApp: 'varlens',
    targetEnvironment: 'test',
    actor: 'op',
    role: 'operator',
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
              remedyId: 'read-pod-summary',
              title: 'Pod-Übersicht anzeigen',
              description: 'Pods und Events lesen.',
              actionId: 'pod-summary',
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

describe('DiagnosePanel', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DiagnosePanel],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations()],
    }).compileComponents();
  });

  function create(selectedRun?: unknown) {
    const fixture = TestBed.createComponent(DiagnosePanel);
    fixture.componentRef.setInput('app', 'varlens');
    fixture.componentRef.setInput('environment', 'test');
    fixture.componentRef.setInput('roles', ['operator']);
    if (selectedRun) {
      // Set before first change detection so the rendered state is stable.
      (fixture.componentInstance as unknown as { selectedRun: unknown }).selectedRun = selectedRun;
    }
    fixture.detectChanges();
    return fixture;
  }

  it('shows the diagnosis button and an empty state initially', () => {
    const fixture = create();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('[data-testid="diagnose-start"]')).toBeTruthy();
    expect(compiled.textContent).toContain('Noch keine Diagnose');
  });

  it('renders findings, severity, cause and remedies; expands evidence on demand', () => {
    const fixture = create(runWithFinding());
    const compiled = fixture.nativeElement as HTMLElement;

    expect(compiled.querySelectorAll('[data-testid="finding"]')).toHaveLength(1);
    expect(compiled.textContent).toContain('ArgoCD meldet OutOfSync.');
    expect(compiled.textContent).toContain('Mögliche Ursache:');
    expect(compiled.textContent).toContain('Pod-Übersicht anzeigen');

    // Evidence is hidden until expanded.
    expect(compiled.querySelector('.evidence')).toBeNull();
    (compiled.querySelector('[data-testid="finding-details"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(compiled.querySelector('.evidence')?.textContent).toContain('OutOfSync');
  });

  it('applies a read-only remedy and shows its result', async () => {
    const fixture = create(runWithFinding());
    const http = TestBed.inject(HttpTestingController);
    const compiled = fixture.nativeElement as HTMLElement;

    (compiled.querySelector('[data-testid="remedy-run"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    http.expectOne('/api/actions/pod-summary/runs').flush({
      run: {
        runId: 'r9',
        actionId: 'pod-summary',
        status: 'succeeded',
        startedAt: new Date().toISOString(),
        targetApp: 'varlens',
        targetEnvironment: 'test',
        actor: 'op',
        role: 'operator',
        summary: '2 Pods gefunden.',
        evidence: [{ label: 'Pod varlens-1', value: 'Running' }],
      },
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(compiled.querySelector('.remedy-result')?.textContent).toContain('2 Pods gefunden.');
    http.verify();
  });
});
