import { GoatPhysicsSnapshot } from '../types';

export interface TouchFrameState {
  anyTouchUsed: boolean;
  throttle: number;
  steer: number;
  airPitch: number;
  airSpin: number;
  jumpHeld: boolean;
  crouchHeld: boolean;
  jumpJustPressed: boolean;
  jumpJustReleased: boolean;
  headbuttJustPressed: boolean;
  bleatJustPressed: boolean;
  restartJustPressed: boolean;
  checkpointJustPressed: boolean;
  cameraToggleJustPressed: boolean;
  pauseJustPressed: boolean;
}

/** Detect phone/tablet touch environment (coarse pointer or multi-touch screen) */
export function isTouchCapableDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(pointer: coarse)').matches ||
    window.matchMedia('(hover: none)').matches ||
    navigator.maxTouchPoints > 0
  );
}

/**
 * Portrait-first multi-touch controller for APEX GOAT:
 * - Bottom-left floating analog stick: Carve L/R, Auto-Sprint forward, pull down to Brake (ground)
 *   or drag Up/Down mid-air for Frontflip/Backflip.
 * - Bottom-right 2+2 ergonomic thumb arc:
 *   - PUMP / DIVE (large outer hold; slide L/R mid-air for 360° Spins)
 *   - LEAP / WALL-KICK (large inner tap)
 *   - RAM & BLEAT (compact upper arc taps)
 * - Top-left tappable utility pills: Pause, Restart, Checkpoint, Camera.
 */
export class TouchControls {
  public readonly isTouchDevice: boolean;
  private hasReceivedTouch = false;

  // Floating stick state
  private stickPointerId: number | null = null;
  private stickOriginX = 0;
  private stickOriginY = 0;
  private stickNormX = 0;
  private stickNormY = 0;
  private readonly stickMaxRadius = 46;

  // Pump / Dive (+ airborne 360 slide) state
  private pumpPointerId: number | null = null;
  private pumpStartX = 0;
  private pumpAirSpin = 0;
  private pumpHeld = false;

  // Leap / Wall-Kick state
  private leapPointerId: number | null = null;
  private leapHeld = false;

  // Edge-triggered actions consumed once per poll()
  private pending = {
    jumpPressed: false,
    jumpReleased: false,
    headbutt: false,
    bleat: false,
    restart: false,
    checkpoint: false,
    camToggle: false,
    pause: false,
  };

  // DOM elements (optional so headless / unit contexts never crash)
  private readonly rootEl = document.getElementById('touch-controls');
  private readonly stickZoneEl = document.getElementById('touch-stick-zone');
  private readonly stickBaseEl = document.getElementById('touch-stick-base');
  private readonly stickKnobEl = document.getElementById('touch-stick-knob');
  private readonly stickUpEl = document.getElementById('touch-stick-up');
  private readonly stickDownEl = document.getElementById('touch-stick-down');
  private readonly stickCapEl = document.getElementById('touch-stick-caption');
  private readonly pumpBtnEl = document.getElementById('touch-btn-pump');
  private readonly pumpLblEl = document.getElementById('touch-pump-lbl');
  private readonly pumpSubEl = document.getElementById('touch-pump-sub');
  private readonly leapBtnEl = document.getElementById('touch-btn-leap');
  private readonly leapLblEl = document.getElementById('touch-leap-lbl');
  private readonly ramBtnEl = document.getElementById('touch-btn-ram');
  private readonly bleatBtnEl = document.getElementById('touch-btn-bleat');

  private readonly utilPauseEl = document.getElementById('hud-btn-pause');
  private readonly utilRestartEl = document.getElementById('hud-btn-restart');
  private readonly utilCpEl = document.getElementById('hud-btn-cp');
  private readonly utilCamEl = document.getElementById('hud-btn-cam');

  private lastAirborneVisual = false;
  private lastWallKickVisual = false;

  constructor() {
    this.isTouchDevice = isTouchCapableDevice();
    this.bindStick();
    this.bindPumpButton();
    this.bindLeapButton();
    this.bindTapButton(this.ramBtnEl, 'headbutt');
    this.bindTapButton(this.bleatBtnEl, 'bleat');
    this.bindUtilityButtons();

    window.addEventListener('blur', () => this.resetAllPointers());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.resetAllPointers();
    });
  }

  private markTouchUsed(): void {
    this.hasReceivedTouch = true;
    document.body.classList.add('touch-active');
  }

  private bindStick(): void {
    const zone = this.stickZoneEl;
    if (!zone) return;

    zone.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (this.stickPointerId !== null) return;
      e.preventDefault();
      if (e.pointerType === 'touch') this.markTouchUsed();

      this.stickPointerId = e.pointerId;
      try {
        zone.setPointerCapture(e.pointerId);
      } catch {
        // Ignore capture errors on synthetic/unsupported pointers
      }

      const rect = zone.getBoundingClientRect();
      const pad = 42;
      const localX = Math.max(pad, Math.min(rect.width - pad, e.clientX - rect.left));
      const localY = Math.max(pad, Math.min(rect.height - pad, e.clientY - rect.top));
      this.stickOriginX = rect.left + localX;
      this.stickOriginY = rect.top + localY;
      this.stickNormX = 0;
      this.stickNormY = 0;

      if (this.stickBaseEl) {
        this.stickBaseEl.style.left = `${localX}px`;
        this.stickBaseEl.style.top = `${localY}px`;
        this.stickBaseEl.classList.add('engaged');
      }
      this.updateStickKnob(0, 0);
    });

    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.stickPointerId) return;
      e.preventDefault();
      const dx = e.clientX - this.stickOriginX;
      const dy = e.clientY - this.stickOriginY;
      const dist = Math.hypot(dx, dy);
      const maxR = this.stickMaxRadius;
      const scale = dist > maxR && dist > 0.001 ? maxR / dist : 1;
      const cx = dx * scale;
      const cy = dy * scale;
      this.stickNormX = cx / maxR;
      this.stickNormY = cy / maxR;
      this.updateStickKnob(cx, cy);
    });

    const releaseStick = (e: PointerEvent) => {
      if (e.pointerId !== this.stickPointerId) return;
      this.resetStick();
    };
    zone.addEventListener('pointerup', releaseStick);
    zone.addEventListener('pointercancel', releaseStick);
    zone.addEventListener('lostpointercapture', releaseStick);
  }

  private updateStickKnob(cx: number, cy: number): void {
    if (!this.stickKnobEl) return;
    this.stickKnobEl.style.transform = `translate3d(${cx.toFixed(1)}px, ${cy.toFixed(1)}px, 0)`;
  }

  private resetStick(): void {
    this.stickPointerId = null;
    this.stickNormX = 0;
    this.stickNormY = 0;
    this.updateStickKnob(0, 0);
    if (this.stickBaseEl) {
      this.stickBaseEl.style.left = '50%';
      this.stickBaseEl.style.top = '52%';
      this.stickBaseEl.classList.remove('engaged');
    }
  }

  private bindPumpButton(): void {
    const btn = this.pumpBtnEl;
    if (!btn) return;

    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (this.pumpPointerId !== null) return;
      e.preventDefault();
      if (e.pointerType === 'touch') this.markTouchUsed();

      this.pumpPointerId = e.pointerId;
      this.pumpStartX = e.clientX;
      this.pumpAirSpin = 0;
      this.pumpHeld = true;
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        // Ignore capture errors on synthetic/unsupported pointers
      }
      btn.classList.add('pressed');
    });

    btn.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.pumpPointerId) return;
      e.preventDefault();
      const dx = e.clientX - this.pumpStartX;
      const deadzone = 15;
      if (Math.abs(dx) > deadzone) {
        const sign = dx > 0 ? 1 : -1;
        const mag = Math.min(1, (Math.abs(dx) - deadzone) / 42);
        this.pumpAirSpin = sign * mag;
        btn.style.transform = `translate3d(${(sign * mag * 9).toFixed(1)}px, 0, 0) scale(0.95)`;
      } else {
        this.pumpAirSpin = 0;
        btn.style.transform = '';
      }
    });

    const releasePump = (e: PointerEvent) => {
      if (e.pointerId !== this.pumpPointerId) return;
      this.pumpPointerId = null;
      this.pumpHeld = false;
      this.pumpAirSpin = 0;
      btn.classList.remove('pressed');
      btn.style.transform = '';
    };
    btn.addEventListener('pointerup', releasePump);
    btn.addEventListener('pointercancel', releasePump);
    btn.addEventListener('lostpointercapture', releasePump);
  }

  private bindLeapButton(): void {
    const btn = this.leapBtnEl;
    if (!btn) return;

    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (this.leapPointerId !== null) return;
      e.preventDefault();
      if (e.pointerType === 'touch') this.markTouchUsed();

      this.leapPointerId = e.pointerId;
      this.leapHeld = true;
      this.pending.jumpPressed = true;
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        // Ignore capture errors on synthetic/unsupported pointers
      }
      btn.classList.add('pressed');
    });

    const releaseLeap = (e: PointerEvent) => {
      if (e.pointerId !== this.leapPointerId) return;
      this.leapPointerId = null;
      if (this.leapHeld) {
        this.leapHeld = false;
        this.pending.jumpReleased = true;
      }
      btn.classList.remove('pressed');
    };
    btn.addEventListener('pointerup', releaseLeap);
    btn.addEventListener('pointercancel', releaseLeap);
    btn.addEventListener('lostpointercapture', releaseLeap);
  }

  private bindTapButton(el: HTMLElement | null, action: 'headbutt' | 'bleat'): void {
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      if (e.pointerType === 'touch') this.markTouchUsed();
      this.pending[action] = true;
      el.classList.add('pressed');
    });
    const release = () => el.classList.remove('pressed');
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);
  }

  private bindUtilityButtons(): void {
    const wire = (
      el: HTMLElement | null,
      action: 'pause' | 'restart' | 'checkpoint' | 'camToggle',
    ) => {
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.pointerType === 'touch') this.markTouchUsed();
        this.pending[action] = true;
        el.classList.add('pressed');
      });
      const release = () => el.classList.remove('pressed');
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('pointerleave', release);
    };

    wire(this.utilPauseEl, 'pause');
    wire(this.utilRestartEl, 'restart');
    wire(this.utilCpEl, 'checkpoint');
    wire(this.utilCamEl, 'camToggle');
  }

  public resetAllPointers(): void {
    this.resetStick();
    this.pumpPointerId = null;
    this.pumpHeld = false;
    this.pumpAirSpin = 0;
    this.leapPointerId = null;
    this.leapHeld = false;
    this.pumpBtnEl?.classList.remove('pressed');
    if (this.pumpBtnEl) this.pumpBtnEl.style.transform = '';
    this.leapBtnEl?.classList.remove('pressed');
    this.ramBtnEl?.classList.remove('pressed');
    this.bleatBtnEl?.classList.remove('pressed');
  }

  public setVisible(visible: boolean): void {
    if (!this.rootEl) return;
    this.rootEl.classList.toggle('hidden', !visible);
    if (!visible) {
      this.resetAllPointers();
    }
  }

  /** Polls current touch state & consumes edge-triggered taps */
  public poll(): TouchFrameState {
    // Analog horizontal steer with smooth response curve & light deadzone
    const rawX = this.stickNormX;
    let steer = 0;
    if (Math.abs(rawX) > 0.08) {
      const sign = rawX > 0 ? 1 : -1;
      const mag = (Math.abs(rawX) - 0.08) / 0.92;
      steer = sign * Math.pow(Math.min(1, mag), 1.15);
    }

    // Auto-sprint forward (+1) by default on mobile; pull stick strongly down to brake
    const rawY = this.stickNormY; // -1 up, +1 down
    let throttle = 1;
    if (rawY > 0.48) {
      throttle = -Math.min(1, (rawY - 0.48) / 0.52);
    }

    // Mid-air flips on stick Y (up = frontflip +1, down = backflip -1)
    let airPitch = 0;
    if (Math.abs(rawY) > 0.24) {
      const sign = rawY < 0 ? 1 : -1;
      const mag = Math.min(1, (Math.abs(rawY) - 0.24) / 0.76);
      airPitch = sign * mag;
    }

    const anyTouchUsed =
      this.hasReceivedTouch ||
      this.stickPointerId !== null ||
      this.pumpHeld ||
      this.leapHeld ||
      this.pending.jumpPressed ||
      this.pending.headbutt ||
      this.pending.bleat ||
      this.pending.restart ||
      this.pending.checkpoint ||
      this.pending.camToggle ||
      this.pending.pause;

    const state: TouchFrameState = {
      anyTouchUsed,
      throttle,
      steer,
      airPitch,
      airSpin: this.pumpAirSpin,
      jumpHeld: this.leapHeld,
      crouchHeld: this.pumpHeld,
      jumpJustPressed: this.pending.jumpPressed,
      jumpJustReleased: this.pending.jumpReleased,
      headbuttJustPressed: this.pending.headbutt,
      bleatJustPressed: this.pending.bleat,
      restartJustPressed: this.pending.restart,
      checkpointJustPressed: this.pending.checkpoint,
      cameraToggleJustPressed: this.pending.camToggle,
      pauseJustPressed: this.pending.pause,
    };

    // Consume edge-triggered actions
    this.pending.jumpPressed = false;
    this.pending.jumpReleased = false;
    this.pending.headbutt = false;
    this.pending.bleat = false;
    this.pending.restart = false;
    this.pending.checkpoint = false;
    this.pending.camToggle = false;
    this.pending.pause = false;

    return state;
  }

  /** Updates contextual glow & airborne labels on touch buttons */
  public updateVisuals(snap: GoatPhysicsSnapshot): void {
    if (!this.rootEl || this.rootEl.classList.contains('hidden')) return;

    const airborne = !snap.grounded && snap.airTime > 0.12;
    const wallKickReady =
      snap.wallRunning || (snap.grounded && snap.slopeDeg >= 40 && snap.speed >= 6.0);

    if (airborne !== this.lastAirborneVisual) {
      this.lastAirborneVisual = airborne;
      this.rootEl.classList.toggle('airborne', airborne);
      if (this.stickUpEl) this.stickUpEl.textContent = airborne ? 'FLIP↑' : '▲';
      if (this.stickDownEl) this.stickDownEl.textContent = airborne ? 'BACK↓' : 'BRK';
      if (this.stickCapEl) this.stickCapEl.textContent = airborne ? 'STEER + FLIP' : 'CARVE STICK';
      if (this.pumpLblEl) this.pumpLblEl.textContent = airborne ? 'DIVE' : 'PUMP';
      if (this.pumpSubEl) this.pumpSubEl.textContent = airborne ? 'HOLD · 360↔' : 'HOLD';
    }

    if (wallKickReady !== this.lastWallKickVisual) {
      this.lastWallKickVisual = wallKickReady;
      if (this.leapLblEl) this.leapLblEl.textContent = wallKickReady ? 'KICK' : 'LEAP';
    }

    this.pumpBtnEl?.classList.toggle('ready', snap.pumpReady && !snap.pumpingNow);
    this.pumpBtnEl?.classList.toggle('surge', snap.pumpingNow || snap.pumpBoostFlash > 0.25);
    this.leapBtnEl?.classList.toggle('ready', wallKickReady);
    this.bleatBtnEl?.classList.toggle('ready', snap.apexBleatReady);
  }
}
