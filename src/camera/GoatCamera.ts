import * as THREE from 'three';
import { GoatRig } from '../goat/GoatRig';
import { GoatPhysicsSnapshot } from '../types';
import { AlpineCourse } from '../world/AlpineCourse';

export type CameraMode = 'chase' | 'gopro';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Dual-mode alpine camera:
 * - 'chase' (Default): Crisp, ultra-readable Steep/Trackmania action chase cam that
 *   elevates cleanly over crests and tilts down on steep drops so upcoming ledges &
 *   roller landing slopes are always crystal clear.
 * - 'gopro' (Toggle with C): Elevated, gimbal-stabilized dorsal GoPro cam mounted high
 *   behind the horns & ears (decoupled from vertical hoof bob) so the horns frame the
 *   bottom edge without obscuring the cliff line ahead.
 */
export class GoatCamera {
  public readonly camera: THREE.PerspectiveCamera;
  public mode: CameraMode = 'chase';

  private smoothedPos = new THREE.Vector3();
  private smoothedLook = new THREE.Vector3();
  private smoothedUp = new THREE.Vector3(0, 1, 0);
  private shakeIntensity = 0;
  private initialized = false;
  private victoryOrbitAngle = 0;
  public victoryOrbit = false;

  private readonly _mountPos = new THREE.Vector3();
  private readonly _lookTarget = new THREE.Vector3();
  private readonly _desiredPos = new THREE.Vector3();
  private readonly _desiredUp = new THREE.Vector3();
  private readonly _velDir = new THREE.Vector3();
  private readonly _right = new THREE.Vector3();
  private readonly _ray = new THREE.Ray();
  private readonly _anchor = new THREE.Vector3();
  private readonly _camToDesired = new THREE.Vector3();
  private readonly _outwardBias = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(80, aspect, 0.08, 4200);
  }

  public toggleMode(rig: GoatRig): CameraMode {
    this.mode = this.mode === 'chase' ? 'gopro' : 'chase';
    rig.setFirstPersonMode(this.mode === 'gopro');
    this.initialized = false;
    return this.mode;
  }

  public addShake(amount: number): void {
    this.shakeIntensity = Math.min(1.0, this.shakeIntensity + amount);
  }

  public reset(): void {
    this.initialized = false;
    this.shakeIntensity = 0;
    this.victoryOrbit = false;
    this.victoryOrbitAngle = 0;
  }

  public resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  public update(dt: number, snap: GoatPhysicsSnapshot, rig: GoatRig, course?: AlpineCourse): void {
    if (this.victoryOrbit) {
      rig.setFirstPersonMode(false);
      this.victoryOrbitAngle += dt * 0.52;
      const radius = 5.4;
      this._desiredPos.set(
        snap.position.x + Math.sin(this.victoryOrbitAngle) * radius,
        snap.position.y + 2.4,
        snap.position.z + Math.cos(this.victoryOrbitAngle) * radius,
      );
      this._lookTarget.copy(snap.position).add(new THREE.Vector3(0, 0.5, 0));
      this.smoothedPos.lerp(this._desiredPos, Math.min(1, dt * 4.5));
      this.smoothedLook.lerp(this._lookTarget, Math.min(1, dt * 6));
      this.smoothedUp.lerp(WORLD_UP, Math.min(1, dt * 6)).normalize();
      this.camera.fov += (70 - this.camera.fov) * Math.min(1, dt * 4);
      this.camera.updateProjectionMatrix();
      this.camera.position.copy(this.smoothedPos);
      this.camera.up.copy(this.smoothedUp);
      this.camera.lookAt(this.smoothedLook);
      return;
    }

    this.shakeIntensity = Math.max(0, this.shakeIntensity - dt * 4.2);
    const speedNorm = THREE.MathUtils.clamp(snap.speed / 42, 0, 1);

    // Subtle tactile micro-rumble at high speed + impact shake
    const groundRumble = snap.grounded && snap.speed > 10 ? speedNorm * 0.016 : 0;
    const totalShake = this.shakeIntensity * 0.13 + groundRumble;

    // Direction of travel blended smoothly with goat facing
    this._velDir.copy(snap.forward);
    if (snap.speed > 4.5) {
      const vNorm = snap.velocity.clone().normalize();
      this._velDir.lerp(vNorm, 0.48).normalize();
    }

    if (this.mode === 'chase') {
      rig.setFirstPersonMode(false);

      // In portrait aspect ratios (aspect < 1), widen vertical FOV and pull back slightly so
      // horizontal cliff visibility stays generous and the goat frames cleanly above thumb controls.
      const aspect = this.camera.aspect;
      const isPortrait = aspect < 1;
      const portraitPullback = isPortrait ? THREE.MathUtils.clamp((1 - aspect) * 1.6, 0, 0.9) : 0;
      const portraitFovBoost = isPortrait ? THREE.MathUtils.clamp((1 - aspect) * 32, 0, 18) : 0;

      // Pull back smoothly at high speed & during big airs; lift slightly over steep drop crests
      // so you can spot the backside of every roller for Slope-Pumping!
      const airPullback = snap.grounded ? 0 : Math.min(2.4, snap.airTime * 1.9);
      const downhillPitch = THREE.MathUtils.clamp(-this._velDir.y, 0, 0.75);
      const backDist = 4.2 + speedNorm * 1.85 + airPullback + portraitPullback;
      const heightOff =
        2.05 +
        speedNorm * 0.5 +
        downhillPitch * 1.45 +
        airPullback * 0.45 +
        portraitPullback * 0.32 -
        snap.crouchAmount * 0.2;

      this._desiredPos
        .copy(snap.position)
        .addScaledVector(this._velDir, -backDist)
        .addScaledVector(WORLD_UP, heightOff);

      // When climbing or running on steep inner cliff walls, stick the camera gracefully toward
      // the open valley side along the slope normal so the goat climbs slightly off-center
      // while the camera stays comfortably in open air — NEVER clipping behind the cliff!
      const wallBiasStrength = snap.wallRunning
        ? 2.8
        : snap.grounded && snap.slopeDeg > 32
          ? THREE.MathUtils.clamp((snap.slopeDeg - 32) / 30, 0, 1) * 2.4
          : 0;
      if (wallBiasStrength > 0.01) {
        const pushNormal = snap.wallRunning ? snap.wallNormal : snap.groundNormal;
        this._outwardBias.set(pushNormal.x, 0, pushNormal.z);
        if (this._outwardBias.lengthSq() > 0.001) {
          this._outwardBias.normalize();
          this._desiredPos.addScaledVector(this._outwardBias, wallBiasStrength);
        }
      }

      // Ironclad BVH cliff collision check: cast from goat shoulder to desired camera position
      // and keep at least 0.85m of open-air clearance in front of any rock face!
      if (course) {
        this._anchor.copy(snap.position).addScaledVector(WORLD_UP, 0.95);
        this._camToDesired.subVectors(this._desiredPos, this._anchor);
        const targetDist = this._camToDesired.length();
        if (targetDist > 0.1) {
          this._camToDesired.divideScalar(targetDist);
          this._ray.set(this._anchor, this._camToDesired);
          const hit = course.bvh.raycastFirst(this._ray, THREE.DoubleSide);
          if (hit && hit.distance < targetDist + 0.85) {
            const safeDist = Math.max(1.35, hit.distance - 0.85);
            this._desiredPos.copy(this._anchor).addScaledVector(this._camToDesired, safeDist);
            // Also nudge slightly outward along hit face normal so the lens never grazes rock
            if (hit.face) {
              this._desiredPos.addScaledVector(hit.face.normal, 0.45);
            }
          }
        }
      }

      // Look well ahead along the downhill trajectory (kept slightly biased toward open course center
      // when wall-climbing so the goat shifts naturally off-center in the frame!)
      this._lookTarget
        .copy(snap.position)
        .addScaledVector(this._velDir, 11.5)
        .add(new THREE.Vector3(0, 0.25 - downhillPitch * 1.6, 0));
      if (wallBiasStrength > 0.01 && this._outwardBias.lengthSq() > 0.001) {
        this._lookTarget.addScaledVector(this._outwardBias, wallBiasStrength * 0.45);
      }

      // Subtle bank into steep wall-runs & sharp turns, mostly horizon-locked for crisp readability
      this._right.crossVectors(this._velDir, WORLD_UP).normalize();
      const wallRoll = snap.wallRunning ? -snap.wallSide * 0.18 : 0;
      const steerRoll = -snap.steerAngle * (0.06 + 0.06 * speedNorm);
      this._desiredUp
        .copy(WORLD_UP)
        .addScaledVector(this._right, wallRoll + steerRoll)
        .lerp(snap.up, 0.1)
        .normalize();

      // Dynamic FOV: 78° idle -> 104° terminal velocity + punchy +8° kick on Slope-Pump boost!
      // Widened gracefully in portrait so horizontal cliff sightlines stay readable.
      const targetFov = Math.min(
        118,
        78 +
          portraitFovBoost +
          speedNorm * 24 +
          snap.pumpBoostFlash * 8.5 +
          (snap.crouching && !snap.grounded ? 5 : 0),
      );
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 8.5);
      this.camera.updateProjectionMatrix();

      if (!this.initialized) {
        this.smoothedPos.copy(this._desiredPos);
        this.smoothedLook.copy(this._lookTarget);
        this.smoothedUp.copy(this._desiredUp);
        this.initialized = true;
      } else {
        this.smoothedPos.lerp(this._desiredPos, Math.min(1, dt * 13));
        this.smoothedLook.lerp(this._lookTarget, Math.min(1, dt * 15));
        this.smoothedUp.lerp(this._desiredUp, Math.min(1, dt * 9)).normalize();
      }
    } else {
      // Refined, usable GoPro Action POV:
      // Mounted elevated behind the neck & decoupled from vertical gallop bounce so the
      // ears & horns frame only the bottom 15% of the screen while keeping sightlines wide open!
      rig.setFirstPersonMode(true);

      this._mountPos
        .copy(snap.position)
        .addScaledVector(WORLD_UP, 0.74 - snap.crouchAmount * 0.14)
        .addScaledVector(this._velDir, -0.35);

      const downhillPitch = THREE.MathUtils.clamp(-this._velDir.y, 0, 0.8);
      this._lookTarget
        .copy(this._mountPos)
        .addScaledVector(this._velDir, 18)
        .add(new THREE.Vector3(0, -1.6 - downhillPitch * 2.2, 0));

      // Gentle 22% horizon roll + wall-run lean (keeps GoPro thrills without disorientation)
      this._right.crossVectors(this._velDir, WORLD_UP).normalize();
      const wallRoll = snap.wallRunning ? -snap.wallSide * 0.25 : 0;
      this._desiredUp
        .copy(WORLD_UP)
        .addScaledVector(this._right, wallRoll)
        .lerp(snap.up, 0.22)
        .normalize();

      const portraitFovBoost =
        this.camera.aspect < 1 ? THREE.MathUtils.clamp((1 - this.camera.aspect) * 24, 0, 14) : 0;
      const targetFov = Math.min(
        128,
        102 + portraitFovBoost + speedNorm * 20 + snap.pumpBoostFlash * 7.5,
      );
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 8.5);
      this.camera.updateProjectionMatrix();

      if (!this.initialized) {
        this.smoothedPos.copy(this._mountPos);
        this.smoothedLook.copy(this._lookTarget);
        this.smoothedUp.copy(this._desiredUp);
        this.initialized = true;
      } else {
        this.smoothedPos.lerp(this._mountPos, Math.min(1, dt * 24));
        this.smoothedLook.lerp(this._lookTarget, Math.min(1, dt * 16));
        this.smoothedUp.lerp(this._desiredUp, Math.min(1, dt * 10)).normalize();
      }
    }

    this.camera.position.copy(this.smoothedPos);
    if (totalShake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * totalShake;
      this.camera.position.y += (Math.random() - 0.5) * totalShake;
      this.camera.position.z += (Math.random() - 0.5) * totalShake;
    }
    this.camera.up.copy(this.smoothedUp);
    this.camera.lookAt(this.smoothedLook);
  }
}
