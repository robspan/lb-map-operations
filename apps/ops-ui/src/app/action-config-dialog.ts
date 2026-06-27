import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { ActionInputDefinition, OperationAction } from '@lb-map-operations/ops-contract';
import { InfoButton } from './info-button';

export interface ActionConfigData {
  readonly action: OperationAction;
  readonly inputs: readonly ActionInputDefinition[];
  readonly values: Record<string, string>;
}

/** Explanations per advanced input, shown via info button in the dialog. */
const INPUT_HELP: Record<string, string> = {
  timeoutSeconds: 'Maximale Wartezeit pro HTTP-Aufruf in Sekunden, bevor er als fehlgeschlagen gilt.',
  endpointScope:
    'Welche Endpunkte geprüft werden: intern (im Cluster), öffentlich (von außen) oder beide.',
  podLimit: 'Wie viele Pods maximal angezeigt werden.',
  eventLimit: 'Wie viele der letzten Namespace-Events angezeigt werden.',
  podSelection:
    'Aus welchem Pod die Logs gelesen werden: bevorzugt laufender, neuester oder ältester.',
  previous:
    'Logs des vorherigen (abgestürzten) Containers lesen statt des aktuellen – hilfreich bei CrashLoops.',
  tailLines: 'Anzahl der zuletzt gelesenen Log-Zeilen.',
  jobLimit: 'Wie viele der letzten Smoke-Jobs angezeigt werden.',
  detailLevel: 'Detailgrad: nur Zusammenfassung oder zusätzlich einzelne ArgoCD-Ressourcen.',
  resourceLimit: 'Wie viele ArgoCD-Ressourcen bei „Detailgrad: resources“ angezeigt werden.',
};

@Component({
  selector: 'app-action-config-dialog',
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    InfoButton,
  ],
  template: `
    <h2 mat-dialog-title>{{ data.action.title }} – Konfiguration</h2>
    <mat-dialog-content>
      <p class="hint">{{ data.action.description }}</p>
      <div class="fields">
        @for (input of data.inputs; track input.name) {
          <div class="field-row">
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>{{ input.label }}</mat-label>
              @if (input.type === 'select') {
                <mat-select [(ngModel)]="values[input.name]" [attr.data-field]="input.name">
                  @for (option of input.options; track option) {
                    <mat-option [value]="option">{{ option }}</mat-option>
                  }
                </mat-select>
              } @else {
                <input
                  matInput
                  [(ngModel)]="values[input.name]"
                  [attr.data-field]="input.name"
                  [maxlength]="input.maxLength || 200"
                  autocomplete="off"
                />
              }
            </mat-form-field>
            @if (helpFor(input)) {
              <app-info [text]="helpFor(input)" />
            }
          </div>
        }
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" (click)="reset()">Zurücksetzen</button>
      <span class="spacer"></span>
      <button mat-button type="button" (click)="cancel()">Abbrechen</button>
      <button mat-flat-button color="primary" type="button" data-testid="config-apply" (click)="apply()">
        Übernehmen
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .hint {
        margin: 0 0 12px;
        color: #5f7079;
        font-size: 0.85rem;
      }
      .fields {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
        gap: 12px;
        min-width: min(440px, 70vw);
      }
      .field-row {
        display: flex;
        align-items: center;
        gap: 2px;
      }
      .field-row mat-form-field {
        flex: 1 1 auto;
      }
      .spacer {
        flex: 1 1 auto;
      }
    `,
  ],
})
export class ActionConfigDialog {
  private readonly dialogRef = inject<MatDialogRef<ActionConfigDialog, Record<string, string>>>(MatDialogRef);
  readonly data = inject<ActionConfigData>(MAT_DIALOG_DATA);
  values: Record<string, string> = { ...this.data.values };

  helpFor(input: ActionInputDefinition): string {
    return INPUT_HELP[input.name] || '';
  }

  reset(): void {
    for (const input of this.data.inputs) {
      this.values[input.name] = input.defaultValue ?? '';
    }
  }

  cancel(): void {
    this.dialogRef.close();
  }

  apply(): void {
    this.dialogRef.close({ ...this.values });
  }
}
