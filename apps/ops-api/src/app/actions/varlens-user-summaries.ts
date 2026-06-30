import { VarLensUserSummary } from '@lb-map-operations/ops-contract';

export type VarLensUserRow = {
  readonly username: string;
  readonly display_name: string | null;
  readonly role: string;
  readonly is_active: boolean;
  readonly private_db_status: string | null;
};

export function summarizeVarLensUserRows(
  rows: readonly VarLensUserRow[],
  usernameBySubject: ReadonlyMap<string, string>,
): readonly VarLensUserSummary[] {
  return rows.map((row) => {
    const username = usernameBySubject.get(row.username) || row.username;
    const displayName =
      row.display_name && row.display_name !== row.username ? row.display_name : username;
    return {
      username,
      displayName,
      role: row.role,
      active: row.is_active,
      privateDbStatus: row.private_db_status || undefined,
    };
  });
}
