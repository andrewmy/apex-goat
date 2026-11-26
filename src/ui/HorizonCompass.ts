import * as THREE from 'three';
import { CheckpointDef } from '../types';

interface HorizonPeak {
  name: string;
  elevationM: number;
  position: THREE.Vector3;
}

const CARDINALS: ReadonlyArray<{ deg: number; label: string; major: boolean }> = [
  { deg: 0, label: 'N', major: true },
  { deg: 45, label: 'NE', major: false },
  { deg: 90, label: 'E', major: true },
  { deg: 135, label: 'SE', major: false },
  { deg: 180, label: 'S', major: true },
  { deg: -135, label: 'SW', major: false },
  { deg: -90, label: 'W', major: true },
  { deg: -45, label: 'NW', major: false },
];

/** Fixed world-space peaks matching Environment.ts ridges & valley geography */
const ALPINE_PEAKS: readonly HorizonPeak[] = [
  { name: 'GLACIER HORN', elevationM: 3120, position: new THREE.Vector3(-220, 960, -1720) },
  { name: 'EASTERN CRAG', elevationM: 2890, position: new THREE.Vector3(960, 740, -680) },
  { name: 'GOAT SPIRE', elevationM: 2760, position: new THREE.Vector3(-120, 665, 35) },
];

function wrapAngleRad(rad: number): number {
  let a = rad;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * Whisper-thin borderless top-center horizon compass:
 * - Cardinal & intercardinal ticks projected onto [-65°, +65°] relative to camera yaw
 * - Highlighted Next Checkpoint pip + live distance in meters (with off-axis chevron)
 * - Iconic distant alpine peaks with elevation & live km readout
 */
export class HorizonCompass {
  private readonly canvas: HTMLCanvasElement | null;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly dpr: number;
  private readonly width = 340;
  private readonly height = 28;
  private readonly halfFovRad = (65 * Math.PI) / 180;
  private readonly _camDir = new THREE.Vector3();

  constructor() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas = document.getElementById('horizon-compass') as HTMLCanvasElement | null;
    if (this.canvas) {
      this.canvas.width = Math.round(this.width * this.dpr);
      this.canvas.height = Math.round(this.height * this.dpr);
      this.ctx = this.canvas.getContext('2d');
      if (this.ctx) {
        this.ctx.scale(this.dpr, this.dpr);
      }
    } else {
      this.ctx = null;
    }
  }

  public update(
    camera: THREE.Camera,
    playerPos: THREE.Vector3,
    nextCheckpoint: CheckpointDef | null,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;

    camera.getWorldDirection(this._camDir);
    const camYaw = Math.atan2(this._camDir.x, -this._camDir.z);

    const w = this.width;
    const h = this.height;
    const cx = w * 0.5;
    const scaleX = (w * 0.48) / this.halfFovRad;

    ctx.clearRect(0, 0, w, h);

    // Hairline horizon baseline
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(10, 15.5);
    ctx.lineTo(w - 10, 15.5);
    ctx.stroke();

    // Minor 15° heading ticks
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    for (let deg = -180; deg < 180; deg += 15) {
      if (deg % 45 === 0) continue;
      const diff = wrapAngleRad((deg * Math.PI) / 180 - camYaw);
      if (Math.abs(diff) > this.halfFovRad) continue;
      const x = cx + diff * scaleX;
      ctx.beginPath();
      ctx.moveTo(x, 13);
      ctx.lineTo(x, 16);
      ctx.stroke();
    }

    // Cardinal & intercardinal markers
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.94)';
    ctx.shadowBlur = 5;
    ctx.shadowOffsetY = 1;
    for (let i = 0; i < CARDINALS.length; i++) {
      const c = CARDINALS[i];
      const diff = wrapAngleRad((c.deg * Math.PI) / 180 - camYaw);
      if (Math.abs(diff) > this.halfFovRad) continue;
      const x = cx + diff * scaleX;
      ctx.strokeStyle = c.major ? 'rgba(255, 255, 255, 0.72)' : 'rgba(255, 255, 255, 0.44)';
      ctx.beginPath();
      ctx.moveTo(x, c.major ? 10.5 : 12);
      ctx.lineTo(x, 16);
      ctx.stroke();

      ctx.font = c.major
        ? '800 9px Inter, -apple-system, sans-serif'
        : '700 8px Inter, -apple-system, sans-serif';
      ctx.fillStyle = c.major ? 'rgba(255, 255, 255, 0.92)' : 'rgba(236, 245, 255, 0.68)';
      ctx.fillText(c.label, x, 17);
    }

    // Compute Next Checkpoint screen X first so distant peaks avoid overlapping its label
    let cpX: number | null = null;
    let cpDiff = 0;
    let cpDistM = 0;
    if (nextCheckpoint) {
      const dx = nextCheckpoint.position.x - playerPos.x;
      const dy = nextCheckpoint.position.y - playerPos.y;
      const dz = nextCheckpoint.position.z - playerPos.z;
      cpDistM = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz));
      const cpYaw = Math.atan2(dx, -dz);
      cpDiff = wrapAngleRad(cpYaw - camYaw);
      const clampedDiff = THREE.MathUtils.clamp(
        cpDiff,
        -this.halfFovRad * 0.9,
        this.halfFovRad * 0.9,
      );
      cpX = cx + clampedDiff * scaleX;
    }

    // Distant iconic alpine peaks (upper rail)
    ctx.textBaseline = 'top';
    for (let i = 0; i < ALPINE_PEAKS.length; i++) {
      const peak = ALPINE_PEAKS[i];
      const dx = peak.position.x - playerPos.x;
      const dz = peak.position.z - playerPos.z;
      const distKm = Math.sqrt(dx * dx + dz * dz) / 1000;
      const peakYaw = Math.atan2(dx, -dz);
      const diff = wrapAngleRad(peakYaw - camYaw);
      if (Math.abs(diff) > this.halfFovRad * 0.88) continue;

      const x = cx + diff * scaleX;
      // Avoid crowding the active checkpoint label
      if (cpX !== null && Math.abs(x - cpX) < 76) continue;

      // Subtle mountain triangle pip
      ctx.fillStyle = 'rgba(185, 224, 255, 0.65)';
      ctx.beginPath();
      ctx.moveTo(x, 9.5);
      ctx.lineTo(x - 3, 14.5);
      ctx.lineTo(x + 3, 14.5);
      ctx.closePath();
      ctx.fill();

      ctx.font = '700 7.5px Inter, -apple-system, sans-serif';
      ctx.fillStyle = 'rgba(234, 246, 255, 0.88)';
      ctx.fillText(`${peak.name} ${distKm.toFixed(1)}KM`, x, 0.5);
    }

    // Active Next Checkpoint marker (highest priority)
    if (nextCheckpoint && cpX !== null) {
      const accent = nextCheckpoint.isFinish ? '#47ff9c' : '#5ff3ff';
      const offLeft = cpDiff < -this.halfFovRad * 0.9;
      const offRight = cpDiff > this.halfFovRad * 0.9;

      // Glowing diamond pip
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.moveTo(cpX, 10);
      ctx.lineTo(cpX + 3.5, 13.8);
      ctx.lineTo(cpX, 17.6);
      ctx.lineTo(cpX - 3.5, 13.8);
      ctx.closePath();
      ctx.fill();

      const prefix = offLeft ? '◀ ' : '';
      const suffix = offRight ? ' ▶' : '';
      ctx.font = '800 8.5px Inter, -apple-system, sans-serif';
      ctx.fillStyle = accent;
      ctx.fillText(`${prefix}${nextCheckpoint.name} · ${cpDistM}M${suffix}`, cpX, 0.5);
    }

    // Center heading reticle tick
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.beginPath();
    ctx.moveTo(cx, 15.5);
    ctx.lineTo(cx - 2.6, 12.2);
    ctx.lineTo(cx + 2.6, 12.2);
    ctx.closePath();
    ctx.fill();
  }
}
