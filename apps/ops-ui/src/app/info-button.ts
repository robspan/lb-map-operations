import { Component, Input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';

@Component({
  selector: 'app-info',
  imports: [MatButtonModule, MatTooltipModule],
  template: `
    <button
      mat-icon-button
      type="button"
      class="info-button"
      [matTooltip]="text"
      matTooltipClass="info-tooltip"
      matTooltipPosition="above"
      matTooltipTouchGestures="on"
      [attr.aria-label]="'Erklärung: ' + text"
      (click)="$event.stopPropagation()"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm-1-11h2V7h-2zm0 8h2v-6h-2z"
        />
      </svg>
    </button>
  `,
  styles: [
    `
      .info-button {
        width: 30px;
        height: 30px;
        line-height: 30px;
        flex: 0 0 auto;
        color: #5f7079;
      }
      .info-button:hover {
        color: #1f2a30;
      }
    `,
  ],
})
export class InfoButton {
  @Input() text = '';
}
