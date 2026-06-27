import {
  ActionInputDefinition,
  OperationAction,
  OpsRole,
  roleAllows,
} from '@lb-map-operations/ops-contract';

export const targetAppInput: ActionInputDefinition = {
  name: 'targetApp',
  label: 'App',
  type: 'select',
  required: true,
  options: ['varlens'],
  defaultValue: 'varlens',
};

export const targetEnvironmentInput: ActionInputDefinition = {
  name: 'targetEnvironment',
  label: 'Umgebung',
  type: 'select',
  required: true,
  options: ['dev', 'test'],
  defaultValue: 'test',
};

const timeoutSecondsInput: ActionInputDefinition = {
  name: 'timeoutSeconds',
  label: 'Timeout',
  type: 'select',
  required: true,
  options: ['3', '8', '15'],
  defaultValue: '8',
};

const endpointScopeInput: ActionInputDefinition = {
  name: 'endpointScope',
  label: 'Endpunkt',
  type: 'select',
  required: true,
  options: ['both', 'internal', 'public'],
  defaultValue: 'both',
};

const podLimitInput: ActionInputDefinition = {
  name: 'podLimit',
  label: 'Pods',
  type: 'select',
  required: true,
  options: ['5', '10', '20'],
  defaultValue: '10',
};

const eventLimitInput: ActionInputDefinition = {
  name: 'eventLimit',
  label: 'Events',
  type: 'select',
  required: true,
  options: ['4', '8', '12', '20'],
  defaultValue: '8',
};

const podSelectionInput: ActionInputDefinition = {
  name: 'podSelection',
  label: 'Pod-Auswahl',
  type: 'select',
  required: true,
  options: ['running-first', 'newest', 'oldest'],
  defaultValue: 'running-first',
};

const previousLogsInput: ActionInputDefinition = {
  name: 'previous',
  label: 'Vorheriger Container',
  type: 'select',
  required: true,
  options: ['false', 'true'],
  defaultValue: 'false',
};

const smokeJobLimitInput: ActionInputDefinition = {
  name: 'jobLimit',
  label: 'Jobs',
  type: 'select',
  required: true,
  options: ['5', '10', '20'],
  defaultValue: '10',
};

const argoDetailLevelInput: ActionInputDefinition = {
  name: 'detailLevel',
  label: 'Detailgrad',
  type: 'select',
  required: true,
  options: ['summary', 'resources'],
  defaultValue: 'summary',
};

const resourceLimitInput: ActionInputDefinition = {
  name: 'resourceLimit',
  label: 'Ressourcen',
  type: 'select',
  required: true,
  options: ['5', '10', '20'],
  defaultValue: '10',
};

export const ACTIONS: readonly OperationAction[] = [
  {
    id: 'diagnose-target',
    title: 'Diagnose starten',
    description:
      'Standarddiagnose aus ArgoCD, Kubernetes, Endpunkten, frischem Smoke-Job, Prometheus und Loki ausführen und passende Abhilfe vorschlagen.',
    role: 'first-level',
    kind: 'diagnostic',
    targetApp: 'varlens',
    inputs: [targetAppInput, targetEnvironmentInput, timeoutSecondsInput],
  },
  {
    id: 'app-health',
    title: 'App-Gesundheit',
    description: 'Deployment, Pods und Health-Endpunkt zusammenfassen.',
    role: 'first-level',
    kind: 'diagnostic',
    targetApp: 'varlens',
    inputs: [targetAppInput, targetEnvironmentInput, timeoutSecondsInput],
  },
  {
    id: 'argo-status',
    title: 'ArgoCD-Status',
    description: 'GitOps-Sync und Health der Ziel-App lesen.',
    role: 'first-level',
    kind: 'diagnostic',
    targetApp: 'varlens',
    inputs: [
      targetAppInput,
      targetEnvironmentInput,
      argoDetailLevelInput,
      resourceLimitInput,
    ],
  },
  {
    id: 'endpoint-check',
    title: 'Endpoint prüfen',
    description: 'Internen oder öffentlichen Health-Endpunkt prüfen.',
    role: 'first-level',
    kind: 'diagnostic',
    targetApp: 'varlens',
    inputs: [
      targetAppInput,
      targetEnvironmentInput,
      endpointScopeInput,
      timeoutSecondsInput,
    ],
  },
  {
    id: 'pod-summary',
    title: 'Pod-Übersicht',
    description: 'Pods, Phasen, Neustarts und Events anzeigen.',
    role: 'first-level',
    kind: 'diagnostic',
    targetApp: 'varlens',
    inputs: [
      targetAppInput,
      targetEnvironmentInput,
      podLimitInput,
      eventLimitInput,
    ],
  },
  {
    id: 'log-summary',
    title: 'Log-Auszug',
    description: 'Letzte technische Logs ohne Secret- oder Env-Ausgaben lesen.',
    role: 'first-level',
    kind: 'diagnostic',
    targetApp: 'varlens',
    inputs: [
      targetAppInput,
      targetEnvironmentInput,
      {
        name: 'tailLines',
        label: 'Zeilen',
        type: 'select',
        required: true,
        options: ['40', '80', '120'],
        defaultValue: '80',
      },
      podSelectionInput,
      previousLogsInput,
    ],
  },
  {
    id: 'smoke-result',
    title: 'Smoke-Status',
    description: 'Letzte in-cluster Smoke-Jobs und deren Ergebnis anzeigen.',
    role: 'first-level',
    kind: 'diagnostic',
    targetApp: 'varlens',
    inputs: [targetAppInput, targetEnvironmentInput, smokeJobLimitInput],
  },
  {
    id: 'observability-links',
    title: 'Observability-Links',
    description:
      'Standardisierte Links und Queries für Grafana, Loki, Prometheus und ArgoCD anzeigen.',
    role: 'first-level',
    kind: 'diagnostic',
    targetApp: 'varlens',
    inputs: [targetAppInput, targetEnvironmentInput],
  },
  {
    id: 'escalation-bundle',
    title: 'Eskalationspaket',
    description:
      'Status, Pods, Events und ArgoCD-Zustand für interne IT-Eskalation bündeln.',
    role: 'first-level',
    kind: 'diagnostic',
    targetApp: 'varlens',
    inputs: [
      targetAppInput,
      targetEnvironmentInput,
      podLimitInput,
      eventLimitInput,
    ],
  },
  {
    id: 'argo-sync',
    title: 'ArgoCD Sync',
    description: 'Nicht-prunenden Sync der Ziel-App auslösen.',
    role: 'operator',
    kind: 'mutation',
    targetApp: 'varlens',
    inputs: [targetAppInput, targetEnvironmentInput],
  },
  {
    id: 'rollout-restart',
    title: 'Stateless Restart',
    description: 'Deployment per Rollout-Annotation neu starten.',
    role: 'operator',
    kind: 'mutation',
    targetApp: 'varlens',
    inputs: [targetAppInput, targetEnvironmentInput],
  },
  {
    id: 'smoke-trigger',
    title: 'Smoke-Job starten',
    description:
      'Einen kurzlebigen Health-Smoke-Job in der Ziel-Umgebung starten.',
    role: 'operator',
    kind: 'mutation',
    targetApp: 'varlens',
    inputs: [targetAppInput, targetEnvironmentInput],
  },
] as const;

const FORBIDDEN_ACTION_FRAGMENTS = [
  'delete',
  'destroy',
  'down',
  'prune',
  'restore',
  'secret',
  'sops',
  'tofu',
  'terraform',
  'ssh',
  'shell',
  'role',
];

export function visibleActions(
  roles: readonly OpsRole[],
): readonly OperationAction[] {
  return ACTIONS.filter((action) => roleAllows(roles, action.role));
}

export function actionById(actionId: string): OperationAction | undefined {
  return ACTIONS.find((action) => action.id === actionId);
}

export function assertSafeCatalog(
  actions: readonly OperationAction[] = ACTIONS,
): void {
  for (const action of actions) {
    if (action.kind !== 'diagnostic' && action.kind !== 'mutation') {
      throw new Error(`unsupported action kind: ${action.id}`);
    }
    for (const fragment of FORBIDDEN_ACTION_FRAGMENTS) {
      if (action.id.toLowerCase().includes(fragment)) {
        throw new Error(
          `forbidden action id fragment ${fragment}: ${action.id}`,
        );
      }
    }
  }
}
