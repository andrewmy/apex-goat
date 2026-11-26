import { BUILD_STAMP } from 'virtual:build-info';

/**
 * Tiny corner build marker (`YmdHis`) + live reload indicator.
 * Shows the exact running build number and lights up into a clickable reload button
 * whenever a newer build is detected on the dev server.
 */
export class BuildBadge {
  private readonly badgeEl: HTMLButtonElement;
  private readonly loadedStamp: string;
  private updateDetected = false;
  private pollHandle: number | null = null;

  constructor() {
    this.loadedStamp = BUILD_STAMP;
    this.badgeEl = document.getElementById('build-badge') as HTMLButtonElement;
    this.renderIdle();

    this.badgeEl.addEventListener('click', () => {
      window.location.reload();
    });

    if (import.meta.hot) {
      import.meta.hot.on('goat:update', (payload: { stamp?: string }) => {
        if (payload?.stamp && payload.stamp !== this.loadedStamp) {
          this.markOutdated(payload.stamp);
        }
      });

      this.pollHandle = window.setInterval(() => {
        void this.checkServerStamp();
      }, 2500);
    }
  }

  private renderIdle(): void {
    this.badgeEl.classList.remove('needs-reload');
    this.badgeEl.textContent = `b${this.loadedStamp}`;
    this.badgeEl.title = `Build ${this.loadedStamp} (click to reload)`;
  }

  private markOutdated(nextStamp: string): void {
    if (this.updateDetected) return;
    this.updateDetected = true;
    this.badgeEl.classList.add('needs-reload');
    this.badgeEl.textContent = `↻ RELOAD · b${nextStamp}`;
    this.badgeEl.title = `New build ${nextStamp} ready — click to reload`;
  }

  private async checkServerStamp(): Promise<void> {
    if (this.updateDetected || document.hidden) return;
    try {
      const res = await fetch('/__build-info', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { stamp?: string };
      if (data.stamp && data.stamp !== this.loadedStamp) {
        this.markOutdated(data.stamp);
      }
    } catch {
      // Ignore transient dev-server restart blips
    }
  }

  public dispose(): void {
    if (this.pollHandle !== null) {
      window.clearInterval(this.pollHandle);
    }
  }
}
