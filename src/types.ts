import * as THREE from 'three';

export enum SurfaceType {
  Granite = 0,
  Scree = 1,
  Snow = 2,
  Turf = 3,
}

export interface SurfaceConfig {
  id: SurfaceType;
  name: string;
  colorHex: string;
  /** Lateral grip multiplier (1 = sharp carving, lower = wide drift) */
  lateralGrip: number;
  /** Forward acceleration multiplier */
  accelMul: number;
  /** Extra downhill gravity boost (huge on Scree!) */
  downhillSlideBoost: number;
  /** Rolling/hoof drag when coasting */
  drag: number;
  /** Max slope angle (degrees) before losing traction while upright */
  maxUprightSlopeDeg: number;
  /** Max slope angle (degrees) while crouched/pumping or carrying lateral momentum */
  maxCrouchSlopeDeg: number;
  /** Jump impulse multiplier */
  jumpMul: number;
  /** Landing speed retention (higher = smoother energy transfer) */
  landingRetention: number;
  /** Pebble/dust particle color */
  particleColor: number;
  /** Particle spawn intensity */
  particleIntensity: number;
}

export type InputDevice = 'keyboard' | 'gamepad' | 'touch';
export type GamepadLayout = 'xbox' | 'playstation';

export interface InputState {
  device: InputDevice;
  gamepadConnected: boolean;
  gamepadLayout: GamepadLayout;
  throttle: number; // -1..1
  steer: number; // -1..1 (-1 left, +1 right)
  airPitch: number; // -1..1 (-1 backflip, +1 frontflip)
  airSpin: number; // -1..1 (dedicated 360 spin decoupled from air-steering!)
  jumpHeld: boolean;
  jumpJustPressed: boolean;
  jumpJustReleased: boolean;
  crouchHeld: boolean;
  headbuttJustPressed: boolean;
  bleatJustPressed: boolean;
  restartJustPressed: boolean;
  checkpointJustPressed: boolean;
  cameraToggleJustPressed: boolean;
  pauseJustPressed: boolean;
  backJustPressed: boolean;
}

export interface GoatPhysicsSnapshot {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  forward: THREE.Vector3;
  up: THREE.Vector3;
  speed: number;
  grounded: boolean;
  crouching: boolean;
  crouchAmount: number; // 0..1
  jumpCharge: number; // 0..1
  pumpBoostFlash: number; // 0..1 visual indicator of landing pump boost
  pumpingNow: boolean;
  pumpReady: boolean;
  lastPumpGainKmh: number;
  slopeDeg: number;
  surface: SurfaceType;
  groundNormal: THREE.Vector3;
  wallRunning: boolean;
  wallNormal: THREE.Vector3;
  wallSide: -1 | 0 | 1;
  steerAngle: number;
  bailedOut: boolean;
  bailTimer: number;
  outOfBounds: boolean;
  airTime: number;
  gaitPhase: number;
  headbuttAnim: number; // 0..1 horn-charge lunge animation
  bleatAnim: number; // 0..1 proud skyward bleat animation
  apexBleatReady: boolean;
  flipAngle: number; // accumulated mid-air pitch flip radians (+ frontflip, - backflip)
  spinAngle: number; // accumulated mid-air 360 spin radians
  exposureHeight: number; // estimated cliff drop distance right beside player
}

export interface GhostSample {
  t: number;
  px: number;
  py: number;
  pz: number;
  fx: number;
  fy: number;
  fz: number;
  ux: number;
  uy: number;
  uz: number;
  crouch: number;
  grounded: boolean;
  gait: number;
}

export interface GhostRecording {
  name: string;
  totalTime: number;
  splits: number[];
  samples: GhostSample[];
}

export interface CheckpointDef {
  index: number;
  name: string;
  t: number; // spline parameter 0..1
  position: THREE.Vector3;
  forward: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  width: number;
  isFinish: boolean;
}

export interface CourseSplineSample {
  t: number;
  position: THREE.Vector3;
  tangent: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  width: number;
  bankRad: number;
  surface: SurfaceType;
  wallSide: -1 | 1; // which side has the towering vertical cliff wall
  hasGap: boolean;
}
