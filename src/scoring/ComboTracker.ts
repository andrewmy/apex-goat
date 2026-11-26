const BEST_STYLE_KEY = 'apex-goat-best-style-v1';

export interface ComboSnapshot {
  totalScore: number;
  bestStyle: number;
  activePoints: number;
  multiplier: number;
  timeRemainingFrac: number; // 0..1
  recentTricks: string[];
  lastEvent: 'none' | 'step' | 'bank' | 'bust';
  lastBankedAmount: number;
  eventAge: number;
}

export interface ComboTickResult {
  bankedAmount: number;
}

/**
 * Tony Hawk × Steep style trick-chain tracker:
 * - Chains Wall-Kicks, Slope-Pumps, Headbutt Rams, Apex Bleats, and Mid-Air Flips/Spins
 * - Pauses combo decay while airborne or actively ground-pumping
 * - Banks `activePoints × multiplier` when the timer expires or at the Finish Arch
 * - Busts unbanked points on Wipeout / Off-Cliff
 */
export class ComboTracker {
  public totalScore = 0;
  public bestStyle = 0;
  public maxMultiplier = 0;

  private activePoints = 0;
  private multiplier = 0;
  private timer = 0;
  private readonly maxWindow = 4.6;
  private recentTricks: string[] = [];

  private lastEvent: ComboSnapshot['lastEvent'] = 'none';
  private lastBankedAmount = 0;
  private eventAge = 99;

  constructor() {
    try {
      const saved = Number(localStorage.getItem(BEST_STYLE_KEY) ?? '0');
      if (Number.isFinite(saved) && saved > 0) this.bestStyle = saved;
    } catch {
      // Ignore storage errors
    }
  }

  public reset(): void {
    this.totalScore = 0;
    this.maxMultiplier = 0;
    this.activePoints = 0;
    this.multiplier = 0;
    this.timer = 0;
    this.recentTricks = [];
    this.lastEvent = 'none';
    this.lastBankedAmount = 0;
    this.eventAge = 99;
  }

  /** Adds a trick to the current chain and returns the new multiplier. */
  public addTrick(label: string, basePoints: number): number {
    this.activePoints += basePoints;
    this.multiplier += 1;
    if (this.multiplier > this.maxMultiplier) {
      this.maxMultiplier = this.multiplier;
    }
    this.timer = this.maxWindow;
    this.recentTricks.push(label);
    if (this.recentTricks.length > 4) {
      this.recentTricks.shift();
    }
    this.lastEvent = 'step';
    this.eventAge = 0;
    return this.multiplier;
  }

  public update(dt: number, holdDecay: boolean): ComboTickResult {
    this.eventAge += dt;
    if (this.multiplier <= 0) {
      return { bankedAmount: 0 };
    }

    if (!holdDecay) {
      this.timer -= dt;
      if (this.timer <= 0) {
        const banked = this.bank();
        return { bankedAmount: banked };
      }
    }
    return { bankedAmount: 0 };
  }

  public bank(): number {
    if (this.multiplier <= 0 || this.activePoints <= 0) return 0;
    const banked = this.activePoints * this.multiplier;
    this.totalScore += banked;
    this.lastBankedAmount = banked;
    this.lastEvent = 'bank';
    this.eventAge = 0;
    this.activePoints = 0;
    this.multiplier = 0;
    this.timer = 0;
    this.recentTricks = [];
    return banked;
  }

  public bust(): boolean {
    if (this.multiplier <= 0) return false;
    this.activePoints = 0;
    this.multiplier = 0;
    this.timer = 0;
    this.recentTricks = [];
    this.lastEvent = 'bust';
    this.eventAge = 0;
    return true;
  }

  public finalizeRun(): { totalScore: number; isNewBestStyle: boolean } {
    this.bank();
    let isNewBestStyle = false;
    if (this.totalScore > this.bestStyle && this.totalScore > 0) {
      this.bestStyle = this.totalScore;
      isNewBestStyle = true;
      try {
        localStorage.setItem(BEST_STYLE_KEY, String(this.bestStyle));
      } catch {
        // Ignore storage errors
      }
    }
    return { totalScore: this.totalScore, isNewBestStyle };
  }

  public getSnapshot(): ComboSnapshot {
    return {
      totalScore: this.totalScore,
      bestStyle: this.bestStyle,
      activePoints: this.activePoints,
      multiplier: this.multiplier,
      timeRemainingFrac: this.multiplier > 0 ? Math.max(0, this.timer / this.maxWindow) : 0,
      recentTricks: this.recentTricks,
      lastEvent: this.lastEvent,
      lastBankedAmount: this.lastBankedAmount,
      eventAge: this.eventAge,
    };
  }
}
