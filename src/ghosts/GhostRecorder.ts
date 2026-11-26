import { GhostRecording, GhostSample, GoatPhysicsSnapshot } from '../types';

const PB_STORAGE_KEY = 'apex-goat-pb-v1';
const LEGACY_PB_STORAGE_KEY = 'goat-racer-pb-v1';

/**
 * Records runs at 30 Hz and persists Personal Best ghosts to localStorage
 * for classic Trackmania ghost-chasing & live checkpoint deltas.
 */
export class GhostRecorder {
  private samples: GhostSample[] = [];
  private nextSampleTime = 0;
  private readonly sampleInterval = 1 / 30;
  public personalBest: GhostRecording | null = null;

  constructor() {
    this.personalBest = this.loadPersonalBest();
  }

  public reset(): void {
    this.samples = [];
    this.nextSampleTime = 0;
  }

  public record(runTime: number, snap: GoatPhysicsSnapshot): void {
    if (runTime < this.nextSampleTime) return;
    this.nextSampleTime = runTime + this.sampleInterval;

    this.samples.push({
      t: Number(runTime.toFixed(3)),
      px: Number(snap.position.x.toFixed(2)),
      py: Number(snap.position.y.toFixed(2)),
      pz: Number(snap.position.z.toFixed(2)),
      fx: Number(snap.forward.x.toFixed(3)),
      fy: Number(snap.forward.y.toFixed(3)),
      fz: Number(snap.forward.z.toFixed(3)),
      ux: Number(snap.up.x.toFixed(3)),
      uy: Number(snap.up.y.toFixed(3)),
      uz: Number(snap.up.z.toFixed(3)),
      crouch: Number(snap.crouchAmount.toFixed(2)),
      grounded: snap.grounded,
      gait: Number(snap.gaitPhase.toFixed(2)),
    });
  }

  public finishRun(totalTime: number, splits: number[]): boolean {
    if (this.personalBest === null || totalTime < this.personalBest.totalTime) {
      const rec: GhostRecording = {
        name: 'PERSONAL BEST',
        totalTime,
        splits: [...splits],
        samples: this.samples,
      };
      this.personalBest = rec;
      try {
        localStorage.setItem(PB_STORAGE_KEY, JSON.stringify(rec));
      } catch {
        // Ignore quota errors
      }
      return true;
    }
    return false;
  }

  private loadPersonalBest(): GhostRecording | null {
    try {
      const raw =
        localStorage.getItem(PB_STORAGE_KEY) ?? localStorage.getItem(LEGACY_PB_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as GhostRecording;
      if (parsed && Array.isArray(parsed.samples) && parsed.samples.length > 5) {
        return parsed;
      }
    } catch {
      // Corrupted storage
    }
    return null;
  }
}
