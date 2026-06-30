import { summarizeVarLensUserRows } from './varlens-user-summaries';

describe('ActionRunnerService VarLens user summaries', () => {
  it('uses entitlement usernames for subject-backed VarLens users', () => {
    const users = summarizeVarLensUserRows(
      [
        {
          username: 'baf1cf86-05f3-418c-9d36-b19345505ae7',
          display_name: 'baf1cf86-05f3-418c-9d36-b19345505ae7',
          role: 'user',
          is_active: true,
          private_db_status: 'active',
        },
      ],
      new Map([['baf1cf86-05f3-418c-9d36-b19345505ae7', 'robspan']]),
    );

    expect(users).toEqual([
      {
        username: 'robspan',
        displayName: 'robspan',
        role: 'user',
        active: true,
        privateDbStatus: 'active',
      },
    ]);
  });

  it('keeps legacy VarLens usernames when no entitlement mapping exists', () => {
    const users = summarizeVarLensUserRows(
      [
        {
          username: 'legacy-user',
          display_name: 'Legacy User',
          role: 'user',
          is_active: false,
          private_db_status: 'disabled',
        },
      ],
      new Map(),
    );

    expect(users).toEqual([
      {
        username: 'legacy-user',
        displayName: 'Legacy User',
        role: 'user',
        active: false,
        privateDbStatus: 'disabled',
      },
    ]);
  });
});
