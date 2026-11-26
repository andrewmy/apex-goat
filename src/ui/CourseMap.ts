import * as THREE from 'three';
import { HerdProgressDot } from '../ghosts/GhostHerd';
import { SurfaceType } from '../types';
import { AlpineCourse } from '../world/AlpineCourse';

const MAP_STORAGE_KEY = 'apex-goat-map-visible-v1';

const SURFACE_COLORS: Record<SurfaceType, string> = {
  [SurfaceType.Granite]: '#e2dcd0',
  [SurfaceType.Scree]: '#ffbe6b',
  [SurfaceType.Snow]: '#7ce4ff',
  [SurfaceType.Turf]: '#6ef09c',
};

/**
 * Unified alpine navigation widget:
 * 1. Top-Down Spline Minimap (surface-colored polyline, Chasm Leap gap, checkpoints,
 *    28-goat herd pack, PB ghost dot, and player heading cone)
 * 2. 2D Side-View Elevation Profile (765m vertical plunge curve + live position needle)
 * 3. Ultra-slim mobile elevation strip below the timer so portrait sightlines stay open
 *
 * Performance: Static terrain splines are pre-rendered ONCE onto offscreen canvases;
 * dynamic markers redraw at 25 Hz (every 40ms) with zero per-frame allocations.
 */
export class CourseMap {
  private readonly course: AlpineCourse;
  private readonly cardEl: HTMLElement | null;
  private readonly togglePillEl: HTMLElement | null;
  private readonly topCanvas: HTMLCanvasElement | null;
  private readonly topCtx: CanvasRenderingContext2D | null;
  private readonly elevCanvas: HTMLCanvasElement | null;
  private readonly elevCtx: CanvasRenderingContext2D | null;
  private readonly mobileElevCanvas: HTMLCanvasElement | null;
  private readonly mobileElevCtx: CanvasRenderingContext2D | null;

  private readonly topStatic: HTMLCanvasElement;
  private readonly elevStatic: HTMLCanvasElement;
  private readonly mobileElevStatic: HTMLCanvasElement;

  private readonly topW = 164;
  private readonly topH = 168;
  private readonly elevW = 164;
  private readonly elevH = 62;
  private readonly mobileElevW = 176;
  private readonly mobileElevH = 24;
  private readonly dpr: number;

  // Normalized projection bounds
  private readonly maxT: number;
  private minX = 0;
  private maxX = 1;
  private minZ = 0;
  private maxZ = 1;
  private minY = -155;
  private maxY = 655;
  private mapScale = 1;
  private mapOffsetX = 0;
  private mapOffsetY = 0;

  private visible: boolean;
  private accum = 0.05; // Draw immediately on first frame

  constructor(course: AlpineCourse, isMobileDefault: boolean) {
    this.course = course;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.maxT = Math.min(1, course.finishT + 0.045);

    this.cardEl = document.getElementById('course-map-card');
    this.togglePillEl = document.getElementById('map-toggle-pill');
    this.topCanvas = document.getElementById('minimap-canvas') as HTMLCanvasElement | null;
    this.elevCanvas = document.getElementById('elev-canvas') as HTMLCanvasElement | null;
    this.mobileElevCanvas = document.getElementById(
      'mobile-elev-canvas',
    ) as HTMLCanvasElement | null;

    this.topCtx = this.setupCanvas(this.topCanvas, this.topW, this.topH);
    this.elevCtx = this.setupCanvas(this.elevCanvas, this.elevW, this.elevH);
    this.mobileElevCtx = this.setupCanvas(
      this.mobileElevCanvas,
      this.mobileElevW,
      this.mobileElevH,
    );

    this.topStatic = this.createOffscreen(this.topW, this.topH);
    this.elevStatic = this.createOffscreen(this.elevW, this.elevH);
    this.mobileElevStatic = this.createOffscreen(this.mobileElevW, this.mobileElevH);

    this.computeBounds();
    this.bakeTopDownStatic();
    this.bakeElevationStatic(this.elevStatic, this.elevW, this.elevH, true);
    this.bakeElevationStatic(this.mobileElevStatic, this.mobileElevW, this.mobileElevH, false);

    this.visible = this.loadInitialVisibility(isMobileDefault);
    this.applyVisibility();
  }

  private setupCanvas(
    canvas: HTMLCanvasElement | null,
    cssW: number,
    cssH: number,
  ): CanvasRenderingContext2D | null {
    if (!canvas) return null;
    canvas.width = Math.round(cssW * this.dpr);
    canvas.height = Math.round(cssH * this.dpr);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.scale(this.dpr, this.dpr);
    }
    return ctx;
  }

  private createOffscreen(cssW: number, cssH: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = Math.round(cssW * this.dpr);
    c.height = Math.round(cssH * this.dpr);
    return c;
  }

  private loadInitialVisibility(isMobileDefault: boolean): boolean {
    const compact = isMobileDefault || window.innerWidth <= 820;
    try {
      const saved = window.localStorage.getItem(MAP_STORAGE_KEY);
      if (saved === '1') return true;
      if (saved === '0') return false;
    } catch {
      // Ignore storage failures
    }
    return !compact;
  }

  public isVisible(): boolean {
    return this.visible;
  }

  public setVisible(next: boolean, persist = true): void {
    this.visible = next;
    this.applyVisibility();
    this.accum = 0.05;
    if (persist) {
      try {
        window.localStorage.setItem(MAP_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // Ignore storage failures
      }
    }
  }

  public toggle(): boolean {
    this.setVisible(!this.visible, true);
    return this.visible;
  }

  private applyVisibility(): void {
    if (this.cardEl) {
      this.cardEl.classList.toggle('hidden', !this.visible);
    }
    if (this.togglePillEl) {
      this.togglePillEl.classList.toggle('active', this.visible);
    }
  }

  private computeBounds(): void {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const s of this.course.samples) {
      if (s.t > this.maxT) break;
      if (s.position.x < minX) minX = s.position.x;
      if (s.position.x > maxX) maxX = s.position.x;
      if (s.position.z < minZ) minZ = s.position.z;
      if (s.position.z > maxZ) maxZ = s.position.z;
      if (s.position.y < minY) minY = s.position.y;
      if (s.position.y > maxY) maxY = s.position.y;
    }

    this.minX = minX;
    this.maxX = maxX;
    this.minZ = minZ;
    this.maxZ = maxZ;
    this.minY = minY - 12;
    this.maxY = maxY + 14;

    // Fit course top-to-bottom (Summit at top, Valley Finish at bottom) with comfortable margins
    const padX = 24;
    const padY = 14;
    const spanX = Math.max(120, this.maxX - this.minX);
    const spanZ = Math.max(120, this.maxZ - this.minZ);
    const availW = this.topW - padX * 2;
    const availH = this.topH - padY * 2;
    // Slight horizontal exaggeration (1.45x) makes tight switchbacks super readable!
    this.mapScale = Math.min(availW / (spanX * 1.45), availH / spanZ);
    const drawnW = spanX * 1.45 * this.mapScale;
    const drawnH = spanZ * this.mapScale;
    this.mapOffsetX = (this.topW - drawnW) * 0.5;
    this.mapOffsetY = (this.topH - drawnH) * 0.5;
  }

  /** Projects world (x, z) onto top-down minimap pixel coords (Summit at top, Finish at bottom) */
  private projectTopX(worldX: number): number {
    return this.mapOffsetX + (worldX - this.minX) * 1.45 * this.mapScale;
  }

  private projectTopY(worldZ: number): number {
    // Summit starts near maxZ (0), descends toward minZ (~ -1060) -> top to bottom!
    return this.mapOffsetY + (this.maxZ - worldZ) * this.mapScale;
  }

  private projectElevX(t: number, width: number, padX: number): number {
    const frac = THREE.MathUtils.clamp(t / this.maxT, 0, 1);
    return padX + frac * (width - padX * 2);
  }

  private projectElevY(worldY: number, height: number, padTop: number, padBot: number): number {
    const frac = THREE.MathUtils.clamp((worldY - this.minY) / (this.maxY - this.minY), 0, 1);
    return height - padBot - frac * (height - padTop - padBot);
  }

  private bakeTopDownStatic(): void {
    const ctx = this.topStatic.getContext('2d');
    if (!ctx) return;
    ctx.scale(this.dpr, this.dpr);

    const samples = this.course.samples;

    // Soft outer translucent alpine halo (no dark inner border)
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 10.5;
    let inStroke = false;
    ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (s.t > this.maxT) break;
      const px = this.projectTopX(s.position.x);
      const py = this.projectTopY(s.position.z);
      if (s.hasGap) {
        inStroke = false;
        continue;
      }
      if (!inStroke) {
        ctx.moveTo(px, py);
        inStroke = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();

    // Bold, clean surface-colored vector trail (zero dark outline/shadow)
    ctx.lineWidth = 3.8;
    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i];
      const b = samples[i + 1];
      if (a.t > this.maxT) break;

      const ax = this.projectTopX(a.position.x);
      const ay = this.projectTopY(a.position.z);
      const bx = this.projectTopX(b.position.x);
      const by = this.projectTopY(b.position.z);

      if (a.hasGap || b.hasGap) {
        ctx.save();
        ctx.setLineDash([2.5, 3.2]);
        ctx.strokeStyle = 'rgba(255, 200, 110, 0.9)';
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      ctx.strokeStyle = SURFACE_COLORS[a.surface] ?? '#e2dcd0';
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    // Minimal start summit dot
    const startX = this.projectTopX(this.course.startPosition.x);
    const startY = this.projectTopY(this.course.startPosition.z);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.beginPath();
    ctx.arc(startX, startY, 2.8, 0, Math.PI * 2);
    ctx.fill();

    // Clean borderless checkpoint pips & finish flag
    ctx.font = '700 8.5px Inter, -apple-system, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.78)';
    ctx.shadowBlur = 3;
    for (const cp of this.course.checkpoints) {
      const cx = this.projectTopX(cp.position.x);
      const cy = this.projectTopY(cp.position.z);
      ctx.fillStyle = cp.isFinish ? '#47ff9c' : 'rgba(255, 224, 118, 0.98)';
      ctx.beginPath();
      ctx.arc(cx, cy, cp.isFinish ? 3.5 : 2.5, 0, Math.PI * 2);
      ctx.fill();

      const labelOnRight = cx < this.topW * 0.62;
      ctx.textAlign = labelOnRight ? 'left' : 'right';
      ctx.fillStyle = cp.isFinish ? '#6effb4' : 'rgba(244, 250, 255, 0.9)';
      const lbl = cp.isFinish ? 'FIN' : `${cp.index + 1}`;
      ctx.fillText(lbl, cx + (labelOnRight ? 8 : -8), cy);
    }
    ctx.shadowBlur = 0;
  }

  private bakeElevationStatic(
    target: HTMLCanvasElement,
    width: number,
    height: number,
    detailed: boolean,
  ): void {
    const ctx = target.getContext('2d');
    if (!ctx) return;
    ctx.scale(this.dpr, this.dpr);

    const padX = detailed ? 8 : 5;
    const padTop = detailed ? 10 : 4;
    const padBot = detailed ? 13 : 4;
    const samples = this.course.samples;

    // Airy snow-silhouette area gradient under the plunge curve
    const grad = ctx.createLinearGradient(0, padTop, 0, height - padBot);
    grad.addColorStop(0, 'rgba(232, 244, 255, 0.24)');
    grad.addColorStop(1, 'rgba(232, 244, 255, 0.02)');

    ctx.beginPath();
    let firstX = padX;
    let lastX = width - padX;
    let started = false;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (s.t > this.maxT) break;
      const px = this.projectElevX(s.t, width, padX);
      const py = this.projectElevY(s.position.y, height, padTop, padBot);
      if (!started) {
        firstX = px;
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
      lastX = px;
    }
    ctx.lineTo(lastX, height - padBot);
    ctx.lineTo(firstX, height - padBot);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Hair-thin vertical checkpoint ticks
    if (detailed) {
      ctx.save();
      ctx.setLineDash([1.5, 2.5]);
      ctx.lineWidth = 0.85;
      for (const cp of this.course.checkpoints) {
        const cx = this.projectElevX(cp.t, width, padX);
        ctx.strokeStyle = cp.isFinish ? 'rgba(71, 255, 156, 0.55)' : 'rgba(255, 255, 255, 0.2)';
        ctx.beginPath();
        ctx.moveTo(cx, padTop);
        ctx.lineTo(cx, height - padBot);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Soft outer translucent halo + bold clean surface-colored elevation curve
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = detailed ? 6.8 : 5.2;
    let inElevHalo = false;
    ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (s.t > this.maxT) break;
      const px = this.projectElevX(s.t, width, padX);
      const py = this.projectElevY(s.position.y, height, padTop, padBot);
      if (s.hasGap) {
        inElevHalo = false;
        continue;
      }
      if (!inElevHalo) {
        ctx.moveTo(px, py);
        inElevHalo = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();

    ctx.lineWidth = detailed ? 2.9 : 2.3;
    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i];
      const b = samples[i + 1];
      if (a.t > this.maxT) break;
      const ax = this.projectElevX(a.t, width, padX);
      const ay = this.projectElevY(a.position.y, height, padTop, padBot);
      const bx = this.projectElevX(b.t, width, padX);
      const by = this.projectElevY(b.position.y, height, padTop, padBot);

      if (a.hasGap || b.hasGap) {
        ctx.save();
        ctx.setLineDash([2.2, 2.5]);
        ctx.lineWidth = detailed ? 2.1 : 1.7;
        ctx.strokeStyle = 'rgba(255, 200, 110, 0.9)';
        ctx.beginPath();
        ctx.moveTo(ax, ay + 3.5);
        ctx.lineTo(bx, by + 3.5);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      ctx.strokeStyle = SURFACE_COLORS[a.surface] ?? '#e2dcd0';
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    if (detailed) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
      ctx.shadowBlur = 3;
      ctx.font = '700 8px Inter, -apple-system, sans-serif';
      ctx.fillStyle = 'rgba(240, 248, 255, 0.85)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('2760m', padX, 1);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = '#6effb4';
      ctx.fillText('1995m', width - padX, height - 1);
    }
    ctx.shadowBlur = 0;
  }

  public update(
    dt: number,
    playerPos: THREE.Vector3,
    playerFwd: THREE.Vector3,
    playerT: number,
    herdDots: readonly HerdProgressDot[],
    pbPos: THREE.Vector3 | null,
  ): void {
    this.accum += dt;
    if (this.accum < 0.04) return; // 25 Hz throttle
    this.accum = 0;

    const isCompactViewport = window.innerWidth <= 820;

    // Resolve PB ghost spline t once if active
    let pbT: number | null = null;
    if (pbPos) {
      pbT = this.course.findNearestSample(pbPos).sample.t;
    }

    // Desktop / expanded map card (Top-Down + Detailed Elevation)
    if (this.visible && !isCompactViewport && this.topCtx && this.elevCtx) {
      this.drawTopDownDynamic(this.topCtx, playerPos, playerFwd, herdDots, pbPos);
      this.drawElevationDynamic(
        this.elevCtx,
        this.elevStatic,
        this.elevW,
        this.elevH,
        true,
        playerT,
        playerPos.y,
        herdDots,
        pbPos,
        pbT,
      );
    }

    // Slim mobile elevation strip (only when compact viewport is active)
    if (isCompactViewport && this.mobileElevCtx) {
      this.drawElevationDynamic(
        this.mobileElevCtx,
        this.mobileElevStatic,
        this.mobileElevW,
        this.mobileElevH,
        false,
        playerT,
        playerPos.y,
        herdDots,
        pbPos,
        pbT,
      );
    }
  }

  private drawTopDownDynamic(
    ctx: CanvasRenderingContext2D,
    playerPos: THREE.Vector3,
    playerFwd: THREE.Vector3,
    herdDots: readonly HerdProgressDot[],
    pbPos: THREE.Vector3 | null,
  ): void {
    ctx.clearRect(0, 0, this.topW, this.topH);
    ctx.drawImage(this.topStatic, 0, 0, this.topW, this.topH);

    // Herd dots
    for (let i = 0; i < herdDots.length; i++) {
      const h = herdDots[i];
      const hx = this.projectTopX(h.x);
      const hy = this.projectTopY(h.z);
      ctx.fillStyle = h.knocked ? 'rgba(255, 118, 108, 0.72)' : 'rgba(255, 245, 225, 0.56)';
      ctx.beginPath();
      ctx.arc(hx, hy, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // Personal Best ghost dot
    if (pbPos) {
      const gx = this.projectTopX(pbPos.x);
      const gy = this.projectTopY(pbPos.z);
      ctx.fillStyle = 'rgba(93, 242, 255, 0.32)';
      ctx.beginPath();
      ctx.arc(gx, gy, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#5df2ff';
      ctx.beginPath();
      ctx.arc(gx, gy, 2.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // Player heading cone + crisp glowing marker
    const px = this.projectTopX(playerPos.x);
    const py = this.projectTopY(playerPos.z);
    // World forward (fx, fz) -> map direction (fx * 1.45, -fz) since -Z points DOWN on the map!
    const dirX = playerFwd.x * 1.45;
    const dirY = -playerFwd.z;
    const headingAngle = Math.atan2(dirY, dirX);

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(headingAngle);
    const coneGrad = ctx.createRadialGradient(0, 0, 2, 0, 0, 17);
    coneGrad.addColorStop(0, 'rgba(71, 255, 156, 0.55)');
    coneGrad.addColorStop(1, 'rgba(71, 255, 156, 0)');
    ctx.fillStyle = coneGrad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 17, -0.45, 0.45);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = 'rgba(71, 255, 156, 0.32)';
    ctx.beginPath();
    ctx.arc(px, py, 5.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(px, py, 2.8, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawElevationDynamic(
    ctx: CanvasRenderingContext2D,
    staticLayer: HTMLCanvasElement,
    width: number,
    height: number,
    detailed: boolean,
    playerT: number,
    playerY: number,
    herdDots: readonly HerdProgressDot[],
    pbPos: THREE.Vector3 | null,
    pbT: number | null,
  ): void {
    const padX = detailed ? 8 : 5;
    const padTop = detailed ? 10 : 4;
    const padBot = detailed ? 13 : 4;

    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(staticLayer, 0, 0, width, height);

    // Herd dots along the plunge
    if (detailed) {
      ctx.fillStyle = 'rgba(255, 244, 224, 0.52)';
      for (let i = 0; i < herdDots.length; i++) {
        const h = herdDots[i];
        if (h.t > this.maxT) continue;
        const hx = this.projectElevX(h.t, width, padX);
        const hy = this.projectElevY(h.y, height, padTop, padBot);
        ctx.beginPath();
        ctx.arc(hx, hy, 1.35, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // PB Ghost dot
    if (pbPos && pbT !== null) {
      const gx = this.projectElevX(pbT, width, padX);
      const gy = this.projectElevY(pbPos.y, height, padTop, padBot);
      ctx.fillStyle = '#5df2ff';
      ctx.beginPath();
      ctx.arc(gx, gy, detailed ? 2.5 : 2.1, 0, Math.PI * 2);
      ctx.fill();
    }

    // Player vertical needle + marker dot
    const px = this.projectElevX(playerT, width, padX);
    const py = this.projectElevY(playerY, height, padTop, padBot);

    ctx.strokeStyle = 'rgba(71, 255, 156, 0.72)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(px, padTop - 2);
    ctx.lineTo(px, height - padBot + 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(71, 255, 156, 0.32)';
    ctx.beginPath();
    ctx.arc(px, py, detailed ? 4.8 : 3.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(px, py, detailed ? 2.5 : 2.1, 0, Math.PI * 2);
    ctx.fill();
  }
}
