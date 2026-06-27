import { BadRequestException } from '@nestjs/common';
import { OperationAction } from '@lb-map-operations/ops-contract';
import { normalizeActionInputs } from './action-inputs';
import { actionById } from './action-registry';

describe('action input normalization', () => {
  it('applies defaults for action-specific inputs', () => {
    const action = mustAction('log-summary');

    expect(normalizeActionInputs(action, {})).toEqual({
      tailLines: '80',
      podSelection: 'running-first',
      previous: 'false',
    });
  });

  it('accepts target fields in inputs for generic clients but does not duplicate them', () => {
    const action = mustAction('endpoint-check');

    expect(
      normalizeActionInputs(action, {
        targetApp: 'varlens',
        targetEnvironment: 'test',
      })
    ).toEqual({
      endpointScope: 'both',
      timeoutSeconds: '8',
    });
  });

  it('rejects unknown inputs', () => {
    const action = mustAction('endpoint-check');

    expect(() => normalizeActionInputs(action, { command: 'kubectl get pods' })).toThrow(
      BadRequestException
    );
  });

  it('rejects values outside the advertised options', () => {
    const action = mustAction('endpoint-check');

    expect(() => normalizeActionInputs(action, { endpointScope: 'all' })).toThrow(
      BadRequestException
    );
  });
});

function mustAction(actionId: string): OperationAction {
  const action = actionById(actionId);
  if (!action) {
    throw new Error(`missing action ${actionId}`);
  }
  return action;
}
