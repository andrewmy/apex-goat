import { GoatPhysicsSnapshot, InputDevice, SurfaceType } from '../types';
import { getSurfaceConfig } from '../physics/SurfaceMaterials';
import { CameraMode } from '../camera/GoatCamera';
import { SplitEvent } from '../world/Checkpoints';

export function formatTime(sec: number): string {
  const clamped = Math.max(0, sec);
  const mins = Math.floor(clamped / 60);
  const rem = clamped - mins * 60;
  const whole = Math.floor(rem);
  const cs = Math.floor((rem - whole) * 100);
  return `${String(mins).padStart(2, '0')}:${String(whole).padStart(
    2,
    '0',
  )}.${String(cs).padStart(2, '0')}`;
}

export class Hud {
  private readonly timerEl = document.getElementById('timer-display')!;
  private readonly cpEl = document.getElementById('cp-display')!;
  private readonly altEl = document.getElementById('alt-display')!;
  private readonly deltaEl = document.getElementById('split-delta')!;
  private readonly speedEl = document.getElementById('speed-display')!;
  private readonly slopeEl = document.getElementById('slope-display')!;
  private readonly surfaceEl = document.getElementById('surface-display')!;
  private readonly speedoWrapEl = document.getElementById('speedo-wrap')!;
  private readonly speedArcEl = document.getElementById('speed-arc') as unknown as SVGCircleElement;
  private readonly pumpArcEl = document.getElementById('pump-arc') as unknown as SVGCircleElement;
  private readonly needleEl = document.getElementById('speed-needle') as unknown as SVGGElement;
  private readonly camLabelEl = document.getElementById('cam-label')!;
  private readonly pbEl = document.getElementById('m-pb')!;
  private readonly speedVigEl = document.getElementById('speed-vignette')!;
  private readonly lensOverlayEl = document.getElementById('lens-overlay')!;
  private readonly controlsHintEl = document.getElementById('controls-hint')!;
  private readonly gpStatusEl = document.getElementById('gp-status');
  private readonly startTipsEl = document.getElementById('start-tips');
  private readonly startBtnEl = document.getElementById('start-btn');
  private readonly resumeBtnEl = document.getElementById('resume-btn');
  private readonly pauseRestartBtnEl = document.getElementById('pause-restart-btn');
  private readonly pauseCamBtnEl = document.getElementById('pause-cam-btn');
  private readonly finishRetryBtnEl = document.getElementById('finish-retry-btn');

  private readonly speedArcLen = 326.73; // 260° of r=72
  private readonly pumpArcLen = 263.2; // 260° of r=58
  private readonly maxDialKmh = 180;
  private smoothedKmh = 0;

  private readonly bannerEl = document.getElementById('center-banner')!;
  private readonly bannerTitleEl = document.getElementById('banner-title')!;
  private readonly bannerSubEl = document.getElementById('banner-sub')!;
  private bannerTimeout: number | null = null;

  private lastSpeedText = '';
  private lastSlopeText = '';
  private lastSurface: SurfaceType | null = null;
  private currentCamMode: CameraMode = 'chase';
  private lastFpsDisplay = 0;
  private activeDevice: InputDevice = 'keyboard';
  private lastGpConnected: boolean | null = null;

  constructor() {
    this.buildSpeedoTicks();
  }

  /** Generates crisp radial tick marks & scale numbers (0..180 km/h) inside the SVG dial */
  private buildSpeedoTicks(): void {
    const g = document.getElementById('speedo-ticks');
    if (!g) return;
    const ns = 'http://www.w3.org/2000/svg';
    const steps = 18; // every 10 km/h
    for (let i = 0; i <= steps; i++) {
      const frac = i / steps;
      const kmhVal = i * 10;
      const isMajor = kmhVal % 20 === 0;
      const isRedline = kmhVal >= 140;
      const deg = -130 + frac * 260;
      const rad = ((deg - 90) * Math.PI) / 180;

      const rOuter = 82;
      const rInner = isMajor ? 75 : 78;
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', (90 + Math.cos(rad) * rInner).toFixed(1));
      line.setAttribute('y1', (90 + Math.sin(rad) * rInner).toFixed(1));
      line.setAttribute('x2', (90 + Math.cos(rad) * rOuter).toFixed(1));
      line.setAttribute('y2', (90 + Math.sin(rad) * rOuter).toFixed(1));
      line.setAttribute(
        'stroke',
        isRedline
          ? 'rgba(255, 92, 92, 0.85)'
          : isMajor
            ? 'rgba(235, 245, 255, 0.72)'
            : 'rgba(235, 245, 255, 0.28)',
      );
      line.setAttribute('stroke-width', isMajor ? '1.8' : '1');
      line.setAttribute('stroke-linecap', 'round');
      g.appendChild(line);

      // Major speed labels at 0, 60, 120, 180
      if (kmhVal % 60 === 0) {
        const rTxt = 47;
        const txt = document.createElementNS(ns, 'text');
        txt.setAttribute('x', (90 + Math.cos(rad) * rTxt).toFixed(1));
        txt.setAttribute('y', (90 + Math.sin(rad) * rTxt + 3).toFixed(1));
        txt.setAttribute('text-anchor', 'middle');
        txt.setAttribute('font-size', '8.5');
        txt.setAttribute('font-weight', '700');
        txt.setAttribute(
          'fill',
          isRedline ? 'rgba(255, 118, 108, 0.85)' : 'rgba(210, 228, 248, 0.5)',
        );
        txt.textContent = String(kmhVal);
        g.appendChild(txt);
      }
    }
  }

  public setPersonalBest(pbSec: number | null): void {
    this.pbEl.textContent = pbSec !== null ? formatTime(pbSec) : '--:--.--';
  }

  public setCameraMode(mode: CameraMode): void {
    this.currentCamMode = mode;
    this.renderCamLabel(this.lastFpsDisplay);
    this.lensOverlayEl.style.opacity = mode === 'gopro' ? '1' : '0.35';
  }

  private renderCamLabel(fps: number): void {
    const camName = this.currentCamMode === 'gopro' ? 'GOPRO POV' : 'CHASE CAM';
    const fpsStr = fps > 0 ? `${fps} FPS` : '-- FPS';
    this.camLabelEl.textContent = `${camName} · ${fpsStr}`;
  }

  public showBanner(title: string, sub: string, durationMs = 1750): void {
    this.bannerTitleEl.textContent = title;
    this.bannerSubEl.textContent = sub;
    this.bannerEl.classList.add('visible');
    if (this.bannerTimeout !== null) {
      window.clearTimeout(this.bannerTimeout);
    }
    this.bannerTimeout = window.setTimeout(() => {
      this.bannerEl.classList.remove('visible');
    }, durationMs);
  }

  public onSplit(ev: SplitEvent, isNewPb: boolean): void {
    let deltaText = '';
    if (ev.deltaVsPb !== null) {
      const sign = ev.deltaVsPb <= 0 ? '-' : '+';
      deltaText = `${sign}${Math.abs(ev.deltaVsPb).toFixed(2)}s`;
      this.deltaEl.textContent = deltaText;
      this.deltaEl.className = `split-delta ${ev.deltaVsPb <= 0 ? 'delta-fast' : 'delta-slow'}`;
    } else {
      this.deltaEl.textContent = formatTime(ev.splitTime);
      this.deltaEl.className = 'split-delta delta-fast';
    }

    if (ev.isFinish) {
      const pbTag = isNewPb ? ' · NEW PERSONAL BEST!' : '';
      this.showBanner(
        `${ev.medal ?? 'FINISHED'} · ${formatTime(ev.splitTime)}`,
        `PRESS R TO RACE YOUR GHOST${pbTag}`,
        5000,
      );
    } else {
      this.showBanner(
        ev.checkpoint.name,
        deltaText ? `${deltaText} VS PB` : formatTime(ev.splitTime),
        1400,
      );
    }
  }

  public clearSplitDelta(): void {
    this.deltaEl.textContent = '';
    this.bannerEl.classList.remove('visible');
  }

  public setInputDevice(device: InputDevice, gamepadConnected: boolean): void {
    if (this.gpStatusEl && gamepadConnected !== this.lastGpConnected) {
      this.lastGpConnected = gamepadConnected;
      this.gpStatusEl.textContent = gamepadConnected
        ? '● CONTROLLER CONNECTED'
        : '○ NO CONTROLLER DETECTED (PLUG IN & PRESS ANY BUTTON)';
      this.gpStatusEl.style.color = gamepadConnected ? '#47ff9c' : 'rgba(215, 230, 250, 0.55)';
    }

    if (device === this.activeDevice) return;
    this.activeDevice = device;
    if (device === 'gamepad') {
      this.controlsHintEl.innerHTML = `
        <div><kbd>RT</kbd>/<kbd>LT</kbd> Sprint &amp; Brake · <kbd>L-STICK</kbd> Carve · <kbd>A</kbd> Leap</div>
        <div><kbd>RB</kbd>/<kbd>B</kbd> Slope-Pump / Dive · <kbd>X</kbd> Bleat</div>
        <div><kbd>Y</kbd> Restart · <kbd>LB</kbd> Checkpoint · <kbd>VIEW</kbd> Cam · <kbd>MENU</kbd> Pause</div>
      `;
      if (this.startTipsEl) {
        this.startTipsEl.innerHTML = `
          <div><strong>Slope-Pumping (RB / B):</strong> Hold <strong>RB</strong> or <strong>B</strong> in mid-air to fast-dive onto steep roller backsides—landing crouched converts drop into a massive speed surge!</div>
          <div><strong>Climbing &amp; Wall-Kicks:</strong> Hold <strong>RT</strong> to claw up steep granite, or carve onto steep cliff walls at speed and tap <strong>A / &times;</strong> to Wall-Kick.</div>
          <div><strong>Cameras &amp; Instant Loop:</strong> Starts in Chase Cam; press <strong>VIEW</strong> for GoPro Action POV, <strong>Y</strong> for instant restart, or <strong>LB</strong> for last checkpoint.</div>
        `;
      }
      if (this.startBtnEl) this.startBtnEl.textContent = 'Drop In (Press A / Menu)';
      if (this.resumeBtnEl) this.resumeBtnEl.textContent = 'Resume (Menu / B)';
      if (this.pauseRestartBtnEl) this.pauseRestartBtnEl.textContent = 'Restart Run (Y)';
      if (this.pauseCamBtnEl) this.pauseCamBtnEl.textContent = 'Toggle Camera (View)';
      if (this.finishRetryBtnEl) this.finishRetryBtnEl.textContent = 'Race Your Ghost (A / Y)';
    } else {
      this.controlsHintEl.innerHTML = `
        <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> Sprint &amp; Carve · <kbd>SPACE</kbd> Leap</div>
        <div><kbd>SHIFT</kbd> Hoof-Grip / Dive-Pump · <kbd>B</kbd> Bleat</div>
        <div><kbd>R</kbd> Restart · <kbd>BKSP</kbd> Checkpoint · <kbd>C</kbd> Camera · <kbd>ESC</kbd>/<kbd>P</kbd> Pause</div>
      `;
      if (this.startTipsEl) {
        this.startTipsEl.innerHTML = `
          <div><strong>Slope-Pumping (SHIFT):</strong> Hold <strong>SHIFT</strong> in mid-air to fast-dive onto steep roller backsides—landing crouched converts drop into a massive speed surge!</div>
          <div><strong>Climbing &amp; Wall-Kicks:</strong> Hold <strong>W</strong> to claw up steep granite, or carve onto steep cliff walls at speed and tap <strong>SPACE</strong> to Wall-Kick.</div>
          <div><strong>Cameras &amp; Instant Loop:</strong> Starts in Chase Cam; press <strong>C</strong> for GoPro Action POV, <strong>R</strong> for instant restart, or <strong>BKSP</strong> for last checkpoint.</div>
        `;
      }
      if (this.startBtnEl) this.startBtnEl.textContent = 'Drop In (Click or Press Space)';
      if (this.resumeBtnEl) this.resumeBtnEl.textContent = 'Resume (ESC / P)';
      if (this.pauseRestartBtnEl) this.pauseRestartBtnEl.textContent = 'Restart Run (R)';
      if (this.pauseCamBtnEl) this.pauseCamBtnEl.textContent = 'Toggle Camera (C)';
      if (this.finishRetryBtnEl) this.finishRetryBtnEl.textContent = 'Race Your Ghost (R / Space)';
    }
  }

  public update(
    runTime: number,
    cpIndex: number,
    cpTotal: number,
    snap: GoatPhysicsSnapshot,
    fps?: number,
  ): void {
    if (fps !== undefined && fps !== this.lastFpsDisplay) {
      this.lastFpsDisplay = fps;
      this.renderCamLabel(fps);
    }
    this.timerEl.textContent = formatTime(runTime);
    this.cpEl.textContent = `CP ${cpIndex} / ${cpTotal}`;
    // Dramatic alpine altitude readout (start ~2450m above sea level)
    const altM = Math.round(2110 + snap.position.y);
    this.altEl.textContent = `ALT ${altM}m`;

    const kmh = Math.round(snap.speed * 3.6);
    const speedStr = String(kmh);
    if (speedStr !== this.lastSpeedText) {
      this.lastSpeedText = speedStr;
      this.speedEl.textContent = speedStr;
    }

    const isPad = this.activeDevice === 'gamepad';
    const jumpKey = isPad ? 'A' : 'SPACE';
    const pumpKey = isPad ? 'RB/B' : 'SHIFT';

    const wallKickReady =
      snap.wallRunning || (snap.grounded && snap.slopeDeg >= 40 && snap.speed >= 6.0);
    let slopeStr: string;
    let slopeColor = '#9be0ff';

    if (snap.pumpingNow) {
      slopeStr = `PUMPING ++ (${Math.round(snap.slopeDeg)}°)`;
      slopeColor = '#47ff9c';
    } else if (wallKickReady) {
      slopeStr = `WALL KICK · ${jumpKey}! (${Math.round(snap.slopeDeg)}°)`;
      slopeColor = '#ffd447';
    } else if (!snap.grounded && snap.crouching) {
      slopeStr = 'DIVE PUMP ↓ LAND ON SLOPE';
      slopeColor = '#47ff9c';
    } else if (snap.pumpReady) {
      slopeStr = snap.grounded
        ? `PUMP · HOLD ${pumpKey}! (${Math.round(snap.slopeDeg)}°)`
        : `DIVE PUMP · HOLD ${pumpKey}!`;
      slopeColor = '#5ff3ff';
    } else if (snap.grounded) {
      slopeStr = `SLOPE ${Math.round(snap.slopeDeg)}°`;
    } else {
      slopeStr = `AIR ${snap.airTime.toFixed(1)}s`;
    }

    if (slopeStr !== this.lastSlopeText) {
      this.lastSlopeText = slopeStr;
      this.slopeEl.textContent = slopeStr;
      this.slopeEl.style.color = slopeColor;
    }

    if (snap.surface !== this.lastSurface) {
      this.lastSurface = snap.surface;
      const cfg = getSurfaceConfig(snap.surface);
      this.surfaceEl.textContent = cfg.name;
      this.surfaceEl.style.color = cfg.colorHex;
    }

    // Smooth needle & sweeping circular arcs for silky motorsport feel
    const rawKmh = snap.speed * 3.6;
    this.smoothedKmh += (rawKmh - this.smoothedKmh) * 0.25;
    const speedFrac = Math.max(0, Math.min(1, this.smoothedKmh / this.maxDialKmh));
    this.speedArcEl.style.strokeDashoffset = (this.speedArcLen * (1 - speedFrac)).toFixed(2);
    const needleDeg = -130 + speedFrac * 260;
    this.needleEl.setAttribute('transform', `rotate(${needleDeg.toFixed(1)} 90 90)`);

    // Inner concentric Pump / Charge ring
    const pumpFrac = Math.max(
      0,
      Math.min(1, Math.max(snap.jumpCharge, snap.pumpBoostFlash, snap.crouchAmount * 0.55)),
    );
    this.pumpArcEl.style.strokeDashoffset = (this.pumpArcLen * (1 - pumpFrac)).toFixed(2);

    // Dynamic bezel glow on Slope-Pump surge or high-speed redline (> 130 km/h)
    this.speedoWrapEl.classList.toggle('surge', snap.pumpingNow || snap.pumpBoostFlash > 0.25);
    this.speedoWrapEl.classList.toggle('redline', kmh >= 130 && !snap.pumpingNow);

    // Speed rush vignette above 75 km/h
    const speedRush = Math.max(0, Math.min(1, (kmh - 70) / 70));
    this.speedVigEl.style.opacity = String(
      Math.min(1, speedRush * 0.85 + snap.pumpBoostFlash * 0.45),
    );
  }
}
