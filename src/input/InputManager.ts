import { GamepadLayout, InputDevice, InputState } from '../types';

function detectGamepadLayout(padId: string): GamepadLayout {
  const id = padId.toLowerCase();
  if (
    id.includes('dualsense') ||
    id.includes('dualshock') ||
    id.includes('playstation') ||
    id.includes('sony') ||
    id.includes('054c')
  ) {
    return 'playstation';
  }
  return 'xbox';
}

export class InputManager {
  private keys = new Set<string>();
  private activeDevice: InputDevice = 'keyboard';
  private gamepadLayout: GamepadLayout = 'xbox';
  private userTouchedKeyboard = false;
  private rumblePriorityUntil = 0;
  private lastScreeRumbleAt = 0;
  private prevJump = false;
  private prevHeadbutt = false;
  private prevBleat = false;
  private prevRestart = false;
  private prevCheckpoint = false;
  private prevCamToggle = false;
  private prevPause = false;
  private prevBack = false;
  private pendingActions = {
    jumpPressed: false,
    jumpReleased: false,
    headbutt: false,
    bleat: false,
    restart: false,
    checkpoint: false,
    camToggle: false,
    pause: false,
  };

  private onKeyDownBound: (e: KeyboardEvent) => void;
  private onKeyUpBound: (e: KeyboardEvent) => void;
  private onBlurBound: () => void;

  constructor() {
    this.onKeyDownBound = this.onKeyDown.bind(this);
    this.onKeyUpBound = this.onKeyUp.bind(this);
    this.onBlurBound = this.onBlur.bind(this);

    window.addEventListener('keydown', this.onKeyDownBound, { passive: false });
    window.addEventListener('keyup', this.onKeyUpBound);
    window.addEventListener('blur', this.onBlurBound);
  }

  private onKeyDown(e: KeyboardEvent): void {
    const code = e.code;
    if (
      code === 'Space' ||
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight' ||
      code === 'Backspace'
    ) {
      e.preventDefault();
    }

    if (!this.keys.has(code)) {
      this.activeDevice = 'keyboard';
      this.userTouchedKeyboard = true;
      if (code === 'Space') this.pendingActions.jumpPressed = true;
      if (code === 'KeyF') this.pendingActions.headbutt = true;
      if (code === 'KeyB') this.pendingActions.bleat = true;
      if (code === 'KeyR') this.pendingActions.restart = true;
      if (code === 'Backspace') this.pendingActions.checkpoint = true;
      if (code === 'KeyC') this.pendingActions.camToggle = true;
      if (code === 'Escape' || code === 'KeyP') this.pendingActions.pause = true;
    }
    this.keys.add(code);
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.code === 'Space' && this.keys.has('Space')) {
      this.pendingActions.jumpReleased = true;
    }
    this.keys.delete(e.code);
  }

  private onBlur(): void {
    this.keys.clear();
  }

  public poll(): InputState {
    let throttle = 0;
    if (this.keys.has('KeyW')) throttle += 1;
    if (this.keys.has('KeyS')) throttle -= 1;

    let steer = 0;
    if (this.keys.has('KeyA')) steer -= 1;
    if (this.keys.has('KeyD')) steer += 1;

    // Keyboard air tricks (no modifier!):
    // Arrow keys whip flips & 360 spins cleanly without fighting WASD sprint/air-steering
    // (S also tilts backflip Elasto-Mania style when airborne!).
    let airPitch = 0;
    if (this.keys.has('ArrowUp')) airPitch += 1;
    if (this.keys.has('ArrowDown') || this.keys.has('KeyS')) airPitch -= 1;
    let airSpin = 0;
    if (this.keys.has('ArrowLeft')) airSpin -= 1;
    if (this.keys.has('ArrowRight')) airSpin += 1;
    // Allow Arrow keys to also drive/steer if user prefers arrows on the ground
    if (throttle === 0) {
      if (this.keys.has('ArrowUp')) throttle += 1;
      if (this.keys.has('ArrowDown')) throttle -= 1;
    }
    if (steer === 0) {
      if (this.keys.has('ArrowLeft')) steer -= 1;
      if (this.keys.has('ArrowRight')) steer += 1;
    }

    let jumpHeld = this.keys.has('Space');
    let crouchHeld =
      this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.keys.has('KeyE');

    let jumpJustPressed = this.pendingActions.jumpPressed;
    let jumpJustReleased = this.pendingActions.jumpReleased;
    let headbuttJustPressed = this.pendingActions.headbutt;
    let bleatJustPressed = this.pendingActions.bleat;
    let restartJustPressed = this.pendingActions.restart;
    let checkpointJustPressed = this.pendingActions.checkpoint;
    let cameraToggleJustPressed = this.pendingActions.camToggle;
    let pauseJustPressed = this.pendingActions.pause;
    let backJustPressed = false;

    // Poll standard HTML5 Gamepad API if connected
    let gamepadConnected = false;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      gamepadConnected = true;
      this.gamepadLayout = detectGamepadLayout(pad.id);
      // If a controller is already connected on load before any keyboard input, default UI to gamepad!
      if (!this.userTouchedKeyboard) {
        this.activeDevice = 'gamepad';
      }
      const rawStickX = pad.axes[0] ?? 0;
      const rawStickY = pad.axes[1] ?? 0; // -1 stick up (frontflip), +1 stick down (backflip)
      const rawRightX = pad.axes[2] ?? 0; // Right Stick X -> clean 360 spin (no heading drift!)
      const rawRightY = pad.axes[3] ?? 0; // Right Stick Y -> alt flip pitch!
      const dpadLeft = pad.buttons[14]?.pressed ? -1 : 0;
      const dpadRight = pad.buttons[15]?.pressed ? 1 : 0;
      const stickX = Math.abs(rawStickX) > 0.14 ? rawStickX : dpadLeft + dpadRight;
      const stickY = Math.abs(rawStickY) > 0.22 ? -rawStickY : 0;
      const rightX = Math.abs(rawRightX) > 0.2 ? rawRightX : 0;
      const rightY = Math.abs(rawRightY) > 0.2 ? -rawRightY : 0;
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;

      const gpJump = pad.buttons[0]?.pressed ?? false; // A / Cross
      const gpBack = pad.buttons[1]?.pressed ?? false; // B / Circle (Back in menus, alt crouch in play)
      const gpCrouch = gpBack || (pad.buttons[5]?.pressed ?? false); // B / Circle or RB / R1
      const gpHeadbutt = pad.buttons[2]?.pressed ?? false; // X / Square -> Headbutt Ram!
      const gpRestart = pad.buttons[3]?.pressed ?? false; // Y / Triangle
      const gpCp = pad.buttons[4]?.pressed ?? false; // LB / L1
      const gpCam = pad.buttons[8]?.pressed ?? false; // View / Share
      const gpPause = pad.buttons[9]?.pressed ?? false; // Menu / Options
      const gpBleat = (pad.buttons[12]?.pressed || pad.buttons[11]?.pressed) ?? false; // D-Pad Up or R3

      // Auto-switch HUD glyphs to controller the moment any stick/trigger/button moves!
      if (
        Math.abs(stickX) > 0.15 ||
        Math.abs(stickY) > 0.22 ||
        Math.abs(rightX) > 0.22 ||
        Math.abs(rightY) > 0.22 ||
        rt > 0.08 ||
        lt > 0.08 ||
        gpJump ||
        gpCrouch ||
        gpHeadbutt ||
        gpBleat ||
        gpRestart ||
        gpCp ||
        gpCam ||
        gpPause
      ) {
        this.activeDevice = 'gamepad';
      }

      if (Math.abs(stickX) > Math.abs(steer)) steer = stickX;
      // Direct Elasto-Mania style flips on Left Stick Y OR Right Stick Y; 360 spins on Right Stick X!
      const gpPitch = Math.abs(rightY) > Math.abs(stickY) ? rightY : stickY;
      if (Math.abs(gpPitch) > Math.abs(airPitch)) airPitch = gpPitch;
      if (Math.abs(rightX) > Math.abs(airSpin)) airSpin = rightX;
      if (rt > 0.05 || lt > 0.05) {
        throttle = Math.max(-1, Math.min(1, rt - lt));
      }

      if (gpJump) jumpHeld = true;
      if (gpCrouch) crouchHeld = true;
      if (gpJump && !this.prevJump) jumpJustPressed = true;
      if (!gpJump && this.prevJump) jumpJustReleased = true;
      if (gpHeadbutt && !this.prevHeadbutt) headbuttJustPressed = true;
      if (gpBleat && !this.prevBleat) bleatJustPressed = true;
      if (gpRestart && !this.prevRestart) restartJustPressed = true;
      if (gpCp && !this.prevCheckpoint) checkpointJustPressed = true;
      if (gpCam && !this.prevCamToggle) cameraToggleJustPressed = true;
      if (gpPause && !this.prevPause) pauseJustPressed = true;
      if (gpBack && !this.prevBack) backJustPressed = true;

      this.prevJump = gpJump;
      this.prevHeadbutt = gpHeadbutt;
      this.prevBleat = gpBleat;
      this.prevRestart = gpRestart;
      this.prevCheckpoint = gpCp;
      this.prevCamToggle = gpCam;
      this.prevPause = gpPause;
      this.prevBack = gpBack;
      break;
    }

    // Clear edge-triggered flags after consumption
    this.pendingActions.jumpPressed = false;
    this.pendingActions.jumpReleased = false;
    this.pendingActions.headbutt = false;
    this.pendingActions.bleat = false;
    this.pendingActions.restart = false;
    this.pendingActions.checkpoint = false;
    this.pendingActions.camToggle = false;
    this.pendingActions.pause = false;

    return {
      device: this.activeDevice,
      gamepadConnected,
      gamepadLayout: this.gamepadLayout,
      throttle,
      steer,
      airPitch,
      airSpin,
      jumpHeld,
      jumpJustPressed,
      jumpJustReleased,
      crouchHeld,
      headbuttJustPressed,
      bleatJustPressed,
      restartJustPressed,
      checkpointJustPressed,
      cameraToggleJustPressed,
      pauseJustPressed,
      backJustPressed,
    };
  }

  /**
   * Triggers DualSense / Xbox dual-rumble haptic feedback via the HTML5 Gamepad API.
   * Priority impacts (ram hits, landings, wall-kicks) automatically override subtle surface texture rumble.
   */
  public rumble(
    strongMagnitude: number,
    weakMagnitude: number,
    durationMs: number,
    isSurfaceTexture = false,
  ): void {
    const now = performance.now();
    if (isSurfaceTexture) {
      if (now < this.rumblePriorityUntil || now - this.lastScreeRumbleAt < 90) return;
      this.lastScreeRumbleAt = now;
    } else {
      this.rumblePriorityUntil = Math.max(this.rumblePriorityUntil, now + durationMs);
    }

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const actuator = (
        pad as Gamepad & {
          vibrationActuator?: {
            playEffect?: (
              type: string,
              params: {
                startDelay?: number;
                duration: number;
                weakMagnitude: number;
                strongMagnitude: number;
              },
            ) => Promise<string>;
          };
          hapticActuators?: Array<{
            pulse?: (value: number, duration: number) => Promise<boolean>;
          }>;
        }
      ).vibrationActuator;

      const s = Math.max(0, Math.min(1, strongMagnitude));
      const w = Math.max(0, Math.min(1, weakMagnitude));

      if (actuator && typeof actuator.playEffect === 'function') {
        actuator
          .playEffect('dual-rumble', {
            startDelay: 0,
            duration: durationMs,
            strongMagnitude: s,
            weakMagnitude: w,
          })
          .catch(() => {});
        break;
      }

      // Fallback for older Safari / Firefox hapticActuators
      const legacy = (
        pad as Gamepad & {
          hapticActuators?: Array<{
            pulse?: (value: number, duration: number) => Promise<boolean>;
          }>;
        }
      ).hapticActuators;
      if (legacy && legacy[0] && typeof legacy[0].pulse === 'function') {
        legacy[0].pulse(Math.max(s, w), durationMs).catch(() => {});
        break;
      }
    }
  }

  public dispose(): void {
    window.removeEventListener('keydown', this.onKeyDownBound);
    window.removeEventListener('keyup', this.onKeyUpBound);
    window.removeEventListener('blur', this.onBlurBound);
  }
}
