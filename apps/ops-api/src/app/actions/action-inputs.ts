import { BadRequestException } from '@nestjs/common';
import { ActionInputDefinition, OperationAction } from '@lb-map-operations/ops-contract';

const TARGET_INPUTS = new Set(['targetApp', 'targetEnvironment']);

export function normalizeActionInputs(
  action: OperationAction,
  rawInputs: unknown
): Record<string, string> {
  if (rawInputs === undefined || rawInputs === null) {
    rawInputs = {};
  }
  if (typeof rawInputs !== 'object' || Array.isArray(rawInputs)) {
    throw new BadRequestException('inputs must be an object');
  }

  const raw = rawInputs as Record<string, unknown>;
  const knownInputs = new Set(action.inputs.map((input) => input.name));
  for (const name of Object.keys(raw)) {
    if (!knownInputs.has(name)) {
      throw new BadRequestException(`unsupported input ${name} for action ${action.id}`);
    }
  }

  const normalized: Record<string, string> = {};
  for (const input of action.inputs) {
    if (TARGET_INPUTS.has(input.name)) {
      continue;
    }
    const value = raw[input.name] ?? input.defaultValue;
    if (value === undefined || value === null || value === '') {
      if (input.required) {
        throw new BadRequestException(`input ${input.name} is required`);
      }
      continue;
    }
    normalized[input.name] = validateInputValue(input, value);
  }
  return normalized;
}

function validateInputValue(input: ActionInputDefinition, value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`input ${input.name} must be a string`);
  }
  if (input.maxLength && value.length > input.maxLength) {
    throw new BadRequestException(`input ${input.name} exceeds ${input.maxLength} characters`);
  }
  if (input.options && !input.options.includes(value)) {
    throw new BadRequestException(
      `input ${input.name} must be one of ${input.options.join(', ')}`
    );
  }
  if (input.pattern && !new RegExp(input.pattern).test(value)) {
    throw new BadRequestException(`input ${input.name} has an invalid format`);
  }
  return value;
}
