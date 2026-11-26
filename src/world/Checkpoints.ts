import * as THREE from 'three';
import { CheckpointDef } from '../types';

export interface SplitEvent {
  checkpoint: CheckpointDef;
  splitTime: number;
  deltaVsPb: number | null;
  isFinish: boolean;
  medal: 'GOLD' | 'SILVER' | 'BRONZE' | 'NONE' | null;
}

export class CheckpointManager {
  public readonly checkpoints: CheckpointDef[];
  public nextIndex = 0;
  public runTime = 0;
  public runStarted = false;
  public runFinished = false;
  public currentSplits: number[] = [];

  public readonly medals = {
    gold: 32.0,
    silver: 38.0,
    bronze: 46.0,
  };

  private lastPassedCp: CheckpointDef | null = null;
  private toPlayer = new THREE.Vector3();

  constructor(checkpoints: CheckpointDef[]) {
    this.checkpoints = checkpoints;
  }

  public reset(): void {
    this.nextIndex = 0;
    this.runTime = 0;
    this.runStarted = false;
    this.runFinished = false;
    this.currentSplits = [];
    this.lastPassedCp = null;
  }

  public getLastCheckpoint(): CheckpointDef | null {
    return this.lastPassedCp;
  }

  public startRun(): void {
    this.runStarted = true;
  }

  public update(
    dt: number,
    playerPos: THREE.Vector3,
    pbSplits: number[] | null,
  ): SplitEvent | null {
    if (this.runStarted && !this.runFinished) {
      this.runTime += dt;
    }

    if (this.runFinished || this.nextIndex >= this.checkpoints.length) {
      return null;
    }

    const cp = this.checkpoints[this.nextIndex];
    this.toPlayer.subVectors(playerPos, cp.position);

    // Check forward plane crossing + generous lateral/vertical corridor
    const forwardDist = this.toPlayer.dot(cp.forward);
    const lateralDist = Math.abs(this.toPlayer.dot(cp.right));
    const verticalDist = Math.abs(this.toPlayer.y);

    if (
      forwardDist >= -1.2 &&
      forwardDist <= 14.0 &&
      lateralDist <= cp.width * 0.85 &&
      verticalDist <= 18.0
    ) {
      const splitTime = this.runTime;
      this.currentSplits[cp.index] = splitTime;
      const pbVal = pbSplits && pbSplits[cp.index] !== undefined ? pbSplits[cp.index] : null;
      const deltaVsPb = pbVal !== null ? splitTime - pbVal : null;

      this.lastPassedCp = cp;
      this.nextIndex++;

      let medal: SplitEvent['medal'] = null;
      if (cp.isFinish) {
        this.runFinished = true;
        if (splitTime <= this.medals.gold) medal = 'GOLD';
        else if (splitTime <= this.medals.silver) medal = 'SILVER';
        else if (splitTime <= this.medals.bronze) medal = 'BRONZE';
        else medal = 'NONE';
      }

      return {
        checkpoint: cp,
        splitTime,
        deltaVsPb,
        isFinish: cp.isFinish,
        medal,
      };
    }

    return null;
  }
}
