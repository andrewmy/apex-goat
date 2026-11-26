const ONBOARDING_STORAGE_KEY = 'apex-goat-onboarded-v1';

export type OnboardingCalloutId = 'map' | 'scene' | 'help';

/**
 * First-visit floating pointer callouts highlighting desktop HUD discovery keys
 * (Map M, Scene/Weather T, GoPro POV C / Controls Help H).
 *
 * Behavior:
 * - Only runs once for first-time desktop visitors (persisted via apex-goat-onboarded-v1)
 * - Fades in cleanly 1.2s after clicking Drop In (never clutters the Start Modal)
 * - Dismisses each callout individually as soon as its hotkey is pressed or clicked
 * - Auto-dismisses all remaining callouts after 10s of active play or at Checkpoint 1
 */
export class OnboardingPointers {
  private readonly layerEl: HTMLElement | null;
  private readonly items = new Map<OnboardingCalloutId, HTMLElement>();
  private readonly dismissed = new Set<OnboardingCalloutId>();

  private completed = false;
  private active = false;
  private shown = false;
  private elapsed = 0;

  constructor(isMobileProfile: boolean) {
    this.layerEl = document.getElementById('onboarding-pointers');
    if (isMobileProfile || window.innerWidth <= 820) {
      this.completed = true;
      return;
    }

    try {
      if (window.localStorage.getItem(ONBOARDING_STORAGE_KEY) === '1') {
        this.completed = true;
        return;
      }
    } catch {
      // Proceed even if storage is unavailable
    }

    if (!this.layerEl) {
      this.completed = true;
      return;
    }

    const nodes = this.layerEl.querySelectorAll<HTMLElement>('[data-callout]');
    nodes.forEach((el) => {
      const id = el.dataset.callout as OnboardingCalloutId | undefined;
      if (!id) return;
      this.items.set(id, el);
      el.addEventListener('click', () => {
        this.dismiss(id);
      });
    });

    if (this.items.size === 0) {
      this.completed = true;
    }
  }

  public startAfterDropIn(): void {
    if (this.completed || this.active) return;
    if (window.innerWidth <= 820) {
      this.completeAll();
      return;
    }
    this.active = true;
    this.elapsed = 0;
  }

  public setSuspended(suspended: boolean): void {
    if (!this.layerEl || this.completed || !this.shown) return;
    this.layerEl.classList.toggle('suspended', suspended);
  }

  public update(dt: number, checkpointIndex: number): void {
    if (this.completed || !this.active) return;

    if (checkpointIndex >= 1) {
      this.completeAll();
      return;
    }

    this.elapsed += dt;

    if (!this.shown && this.elapsed >= 1.2) {
      this.shown = true;
      this.layerEl?.classList.add('visible');
    }

    if (this.shown && this.elapsed >= 11.2) {
      this.completeAll();
    }
  }

  public dismiss(id: OnboardingCalloutId): void {
    if (this.completed || this.dismissed.has(id)) return;
    this.dismissed.add(id);
    const el = this.items.get(id);
    if (el) {
      el.classList.add('dismissed');
    }
    if (this.dismissed.size >= this.items.size) {
      this.completeAll();
    }
  }

  private completeAll(): void {
    if (this.completed) return;
    this.completed = true;
    this.active = false;
    this.layerEl?.classList.remove('visible');
    try {
      window.localStorage.setItem(ONBOARDING_STORAGE_KEY, '1');
    } catch {
      // Ignore storage failures
    }
  }
}
