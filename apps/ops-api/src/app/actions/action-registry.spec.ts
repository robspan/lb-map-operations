import { ACTIONS, assertSafeCatalog, visibleActions } from './action-registry';

describe('action registry', () => {
  it('contains no destructive or privilege-escalating action IDs', () => {
    expect(() => assertSafeCatalog()).not.toThrow();
    expect(ACTIONS.map((action) => action.id)).toEqual([
      'diagnose-target',
      'app-health',
      'argo-status',
      'endpoint-check',
      'pod-summary',
      'log-summary',
      'smoke-result',
      'observability-links',
      'escalation-bundle',
      'argo-sync',
      'rollout-restart',
    ]);
  });

  it('hides admin actions from first-level support', () => {
    const firstLevelActions = visibleActions(['first-level']).map(
      (action) => action.id,
    );
    expect(firstLevelActions).toContain('app-health');
    expect(firstLevelActions).toContain('escalation-bundle');
    expect(firstLevelActions).not.toContain('argo-sync');
    expect(firstLevelActions).not.toContain('rollout-restart');
  });

  it('shows the full catalog to admins', () => {
    expect(visibleActions(['admin']).map((action) => action.id)).toEqual(
      ACTIONS.map((action) => action.id),
    );
  });

  it('advertises bounded action-specific inputs', () => {
    expect(inputNames('endpoint-check')).toEqual([
      'targetApp',
      'targetEnvironment',
      'endpointScope',
      'timeoutSeconds',
    ]);
    expect(inputOptions('endpoint-check', 'endpointScope')).toEqual([
      'both',
      'internal',
      'public',
    ]);
    expect(inputNames('log-summary')).toEqual([
      'targetApp',
      'targetEnvironment',
      'tailLines',
      'podSelection',
      'previous',
    ]);
    expect(inputNames('pod-summary')).toEqual([
      'targetApp',
      'targetEnvironment',
      'podLimit',
      'eventLimit',
    ]);
  });
});

function inputNames(actionId: string): string[] {
  return (
    ACTIONS.find((action) => action.id === actionId)?.inputs.map(
      (input) => input.name,
    ) || []
  );
}

function inputOptions(actionId: string, inputName: string): readonly string[] {
  return (
    ACTIONS.find((action) => action.id === actionId)?.inputs.find(
      (input) => input.name === inputName,
    )?.options || []
  );
}
