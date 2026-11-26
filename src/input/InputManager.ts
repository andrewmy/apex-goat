import { InputDevice, InputState } from '../types';

export class InputManager {
  private keys = new Set<string>();
  private activeDevice: InputDevice = 'keyboard';
  private userTouchedKeyboard = false;
  private prevJump = false;
  private prevBleat = false;
  private prevRestart = false;
  private prevCheckpoint = false;
  private prevCamToggle = false;
  private prevPause = false;
  private prevBack = false;
  private pendingActions = {
    jumpPressed: false,
    jumpReleased: false,
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
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) throttle += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) throttle -= 1;

    let steer = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) steer -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) steer += 1;

    let jumpHeld = this.keys.has('Space');
    let crouchHeld =
      this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.keys.has('KeyE');

    let jumpJustPressed = this.pendingActions.jumpPressed;
    let jumpJustReleased = this.pendingActions.jumpReleased;
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
      // If a controller is already connected on load before any keyboard input, default UI to gamepad!
      if (!this.userTouchedKeyboard) {
        this.activeDevice = 'gamepad';
      }
      const rawStickX = pad.axes[0] ?? 0;
      const dpadLeft = pad.buttons[14]?.pressed ? -1 : 0;
      const dpadRight = pad.buttons[15]?.pressed ? 1 : 0;
      const stickX = Math.abs(rawStickX) > 0.14 ? rawStickX : dpadLeft + dpadRight;
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;

      const gpJump = pad.buttons[0]?.pressed ?? false; // A / Cross
      const gpBack = pad.buttons[1]?.pressed ?? false; // B / Circle (Back in menus, alt crouch in play)
      const gpCrouch = gpBack || (pad.buttons[5]?.pressed ?? false); // B / Circle or RB / R1
      const gpBleat = pad.buttons[2]?.pressed ?? false; // X / Square
      const gpRestart = pad.buttons[3]?.pressed ?? false; // Y / Triangle
      const gpCp = pad.buttons[4]?.pressed ?? false; // LB / L1
      const gpCam = pad.buttons[8]?.pressed ?? false; // View / Share
      const gpPause = pad.buttons[9]?.pressed ?? false; // Menu / Options

      // Auto-switch HUD glyphs to controller the moment any stick/trigger/button moves!
      if (
        Math.abs(stickX) > 0.15 ||
        rt > 0.08 ||
        lt > 0.08 ||
        gpJump ||
        gpCrouch ||
        gpBleat ||
        gpRestart ||
        gpCp ||
        gpCam ||
        gpPause
      ) {
        this.activeDevice = 'gamepad';
      }

      if (Math.abs(stickX) > Math.abs(steer)) steer = stickX;
      if (rt > 0.05 || lt > 0.05) {
        throttle = Math.max(-1, Math.min(1, rt - lt));
      }

      if (gpJump) jumpHeld = true;
      if (gpCrouch) crouchHeld = true;
      if (gpJump && !this.prevJump) jumpJustPressed = true;
      if (!gpJump && this.prevJump) jumpJustReleased = true;
      if (gpBleat && !this.prevBleat) bleatJustPressed = true;
      if (gpRestart && !this.prevRestart) restartJustPressed = true;
      if (gpCp && !this.prevCheckpoint) checkpointJustPressed = true;
      if (gpCam && !this.prevCamToggle) cameraToggleJustPressed = true;
      if (gpPause && !this.prevPause) pauseJustPressed = true;
      if (gpBack && !this.prevBack) backJustPressed = true;

      this.prevJump = gpJump;
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
    this.pendingActions.bleat = false;
    this.pendingActions.restart = false;
    this.pendingActions.checkpoint = false;
    this.pendingActions.camToggle = false;
    this.pendingActions.pause = false;

    return {
      device: this.activeDevice,
      gamepadConnected,
      throttle,
      steer,
      jumpHeld,
      jumpJustPressed,
      jumpJustReleased,
      crouchHeld,
      bleatJustPressed,
      restartJustPressed,
      checkpointJustPressed,
      cameraToggleJustPressed,
      pauseJustPressed,
      backJustPressed,
    };
  }

  public dispose(): void {
    window.removeEventListener('keydown', this.onKeyDownBound);
    window.removeEventListener('keyup', this.onKeyUpBound);
    window.removeEventListener('blur', this.onBlurBound);
  }
}
