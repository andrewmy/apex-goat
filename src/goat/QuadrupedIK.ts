import * as THREE from 'three';
import { GoatPhysicsSnapshot, SurfaceType } from '../types';
import { AlpineCourse } from '../world/AlpineCourse';
import { GoatRig, LegJoints } from './GoatRig';

export interface HoofStepEvent {
  position: THREE.Vector3;
  surface: SurfaceType;
  intensity: number;
  isFront: boolean;
}

interface LegRuntime {
  phaseOffset: number;
  wasSwing: boolean;
  plantedWorld: THREE.Vector3;
  hasPlanted: boolean;
}

/**
 * Procedural 4-Leg Predictive Raycast IK + Spine/Neck/Head Stabilization.
 * Snaps hooves onto actual rock ledges & steep cliff faces via the course BVH,
 * and triggers HoofStepEvents for material-aware clack audio and pebble bursts.
 */
export class QuadrupedIK {
  private readonly rig: GoatRig;
  private readonly course: AlpineCourse;
  private readonly legStates: LegRuntime[];

  private readonly _ray = new THREE.Ray();
  private readonly _hipWorld = new THREE.Vector3();
  private readonly _targetWorld = new THREE.Vector3();
  private readonly _targetLocal = new THREE.Vector3();
  private readonly _down = new THREE.Vector3();
  private readonly _right = new THREE.Vector3();
  private readonly _rotMat = new THREE.Matrix4();
  private readonly _quat = new THREE.Quaternion();
  private readonly _invBodyMat = new THREE.Matrix4();

  constructor(rig: GoatRig, course: AlpineCourse) {
    this.rig = rig;
    this.course = course;

    // Rotary gallop / alpine bound phase offsets (FL, FR, BL, BR)
    const offsets = [0.0, 0.22, 0.52, 0.74];
    this.legStates = offsets.map((phaseOffset) => ({
      phaseOffset,
      wasSwing: false,
      plantedWorld: new THREE.Vector3(),
      hasPlanted: false,
    }));
  }

  public update(
    dt: number,
    snap: GoatPhysicsSnapshot,
    onHoofStep?: (e: HoofStepEvent) => void,
  ): void {
    // 1. Place rig root at interpolated physics position (feet level = pos - 0.84m)
    const feetOffset = 0.84;
    this.rig.root.position.copy(snap.position).addScaledVector(snap.up, -feetOffset);

    // Orient root using physics basis (forward = -Z, up = +Y, right = +X)
    this._right.crossVectors(snap.forward, snap.up).normalize();
    const orthoUp = new THREE.Vector3().crossVectors(this._right, snap.forward).normalize();

    this._rotMat.makeBasis(this._right, orthoUp, snap.forward.clone().negate());
    this._quat.setFromRotationMatrix(this._rotMat);
    this.rig.root.quaternion.copy(this._quat);

    // 2. Dynamic body suspension (crouch compression, gallop bounce, steer/wall-run lean)
    const speedNorm = THREE.MathUtils.clamp(snap.speed / 38, 0, 1);
    const gallopBounce =
      snap.grounded || snap.wallRunning
        ? Math.sin(snap.gaitPhase * Math.PI * 2) * (0.04 + 0.065 * speedNorm)
        : 0;
    const crouchDrop = snap.crouchAmount * 0.24;

    this.rig.bodyPivot.position.y = 0.88 - crouchDrop + gallopBounce;
    const wallLean = snap.wallRunning ? -snap.wallSide * 0.42 : 0;
    this.rig.bodyPivot.rotation.z = -snap.steerAngle * (0.15 + 0.16 * speedNorm) + wallLean;

    // Pitch body subtly during gallop, aerial dive tuck, or mid-air leap
    const aerialDivePitch = !snap.grounded && snap.crouching ? -0.35 : 0;
    const airPitch = snap.grounded
      ? Math.cos(snap.gaitPhase * Math.PI * 2) * 0.08 * speedNorm
      : THREE.MathUtils.clamp(snap.velocity.y * 0.03, -0.45, 0.45) + aerialDivePitch;
    this.rig.bodyPivot.rotation.x = airPitch - snap.crouchAmount * 0.1;

    // 3. Head & Horn Stabilization (mountain goats keep their heads eerily level!)
    const targetHeadYaw = -snap.steerAngle * 0.42;
    const slopePitchComp = THREE.MathUtils.clamp((snap.slopeDeg / 90) * 0.45, -0.35, 0.45);
    const targetHeadPitch =
      -airPitch * 0.65 +
      slopePitchComp * 0.35 +
      Math.sin(snap.gaitPhase * Math.PI * 2 + 0.4) * 0.045 * speedNorm;
    const targetHeadRoll = snap.steerAngle * 0.18;

    const smooth = Math.min(1, dt * 16);
    this.rig.headPivot.rotation.y += (targetHeadYaw - this.rig.headPivot.rotation.y) * smooth;
    this.rig.headPivot.rotation.x += (targetHeadPitch - this.rig.headPivot.rotation.x) * smooth;
    this.rig.headPivot.rotation.z += (targetHeadRoll - this.rig.headPivot.rotation.z) * smooth;

    // Wind-pinned ears & bouncy tail!
    const earSweep = 0.18 + speedNorm * 0.68;
    const earFlutter = Math.sin(snap.gaitPhase * 12) * 0.07 * speedNorm;
    this.rig.leftEar.rotation.y = -earSweep + earFlutter;
    this.rig.rightEar.rotation.y = earSweep - earFlutter;
    this.rig.leftEar.rotation.z = 0.12 - speedNorm * 0.22;
    this.rig.rightEar.rotation.z = -0.12 + speedNorm * 0.22;
    this.rig.tailPivot.rotation.x = 0.25 + Math.sin(snap.gaitPhase * 9) * 0.22;

    // Update world matrices so hip transforms are accurate for raycast IK
    this.rig.root.updateMatrixWorld(true);
    this._invBodyMat.copy(this.rig.bodyPivot.matrixWorld).invert();

    // 4. Solve 4-Leg Predictive Raycast IK (projects into wall when wall-running!)
    if (snap.wallRunning) {
      this._down.copy(snap.wallNormal).negate();
    } else {
      this._down.copy(snap.up).negate();
    }
    const strideLen = THREE.MathUtils.lerp(0.14, 0.56, speedNorm);
    const liftHeight = THREE.MathUtils.lerp(0.08, 0.28, speedNorm);

    for (let i = 0; i < this.rig.legs.length; i++) {
      const leg = this.rig.legs[i];
      const st = this.legStates[i];
      const cycle = (snap.gaitPhase + st.phaseOffset) % 1;
      const isSwing = cycle < 0.45;

      leg.hip.getWorldPosition(this._hipWorld);

      if (!snap.grounded && !snap.wallRunning) {
        // Mid-air pose: tucked tight when holding SHIFT for Aerial Dive, stretched when soaring!
        const tuckScale = snap.crouching ? 0.55 : 1.0;
        const reach = (leg.isFront ? -0.34 : 0.36) * tuckScale;
        const tuck = leg.isFront
          ? -0.44 +
            (snap.crouching ? 0.14 : 0) +
            THREE.MathUtils.clamp(snap.velocity.y * 0.015, -0.15, 0.18)
          : -0.56 +
            (snap.crouching ? 0.16 : 0) -
            THREE.MathUtils.clamp(snap.velocity.y * 0.015, -0.12, 0.15);
        this._targetLocal.set(leg.hipLocalOffset.x, tuck, leg.hipLocalOffset.z + reach);
        this.solveTwoBoneLeg(leg, this._targetLocal);
        st.wasSwing = true;
        st.hasPlanted = false;
        continue;
      }

      // Compute ideal foot target along forward stride cycle
      const swingProgress = isSwing ? cycle / 0.45 : (cycle - 0.45) / 0.55;
      const strideOffset = isSwing
        ? THREE.MathUtils.lerp(-strideLen * 0.65, strideLen * 0.9, swingProgress)
        : THREE.MathUtils.lerp(strideLen * 0.9, -strideLen * 0.65, swingProgress);

      // Probe cliff BVH underneath predicted hoof position
      const probeStart = this._targetWorld
        .copy(this._hipWorld)
        .addScaledVector(snap.forward, strideOffset)
        .addScaledVector(snap.up, 0.35);

      this._ray.set(probeStart, this._down);
      const hit = this.course.bvh.raycastFirst(this._ray, THREE.FrontSide);

      if (hit && hit.distance < 1.75) {
        this._targetWorld.copy(hit.point);
        if (isSwing) {
          const arc = Math.sin(swingProgress * Math.PI) * liftHeight;
          this._targetWorld.addScaledVector(snap.up, arc);
        } else if (st.wasSwing) {
          // Foot just planted! Fire hoof-clack audio & pebble spray!
          st.plantedWorld.copy(hit.point);
          st.hasPlanted = true;
          if (snap.speed > 1.8) {
            const hitSurface = this.course.getSurfaceForFace(hit.faceIndex ?? -1);
            onHoofStep?.({
              position: hit.point.clone(),
              surface: hitSurface,
              intensity: THREE.MathUtils.clamp(0.28 + speedNorm * 0.85, 0.25, 1.0),
              isFront: leg.isFront,
            });
          }
        }
      } else {
        // Fallback under hip if hovering off a razor ledge edge
        this._targetWorld
          .copy(this._hipWorld)
          .addScaledVector(snap.up, -0.74)
          .addScaledVector(snap.forward, strideOffset * 0.5);
      }

      st.wasSwing = isSwing;

      // Convert target into bodyPivot local space & solve 2-bone IK in sagittal (Y-Z) plane
      this._targetLocal.copy(this._targetWorld).applyMatrix4(this._invBodyMat);
      this.solveTwoBoneLeg(leg, this._targetLocal);
    }
  }

  /** Analytical 2-bone IK solver in the leg's local sagittal plane */
  private solveTwoBoneLeg(leg: LegJoints, targetInBody: THREE.Vector3): void {
    const dx = targetInBody.x - leg.hipLocalOffset.x;
    const dy = targetInBody.y - leg.hipLocalOffset.y;
    const dz = targetInBody.z - leg.hipLocalOffset.z;

    const L1 = leg.upperLen;
    const L2 = leg.lowerLen;
    const maxReach = (L1 + L2) * 0.98;
    const minReach = Math.abs(L1 - L2) + 0.08;

    const dist = THREE.MathUtils.clamp(Math.sqrt(dy * dy + dz * dz), minReach, maxReach);

    // Base angle from straight down (-Y) toward forward (-Z)
    const baseAngle = Math.atan2(-dz, -dy);

    // Law of cosines for shoulder/hip flexion & knee/hock bend
    const cosA = THREE.MathUtils.clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1);
    const angleA = Math.acos(cosA);

    const cosB = THREE.MathUtils.clamp((L1 * L1 + L2 * L2 - dist * dist) / (2 * L1 * L2), -1, 1);
    const kneeInterior = Math.acos(cosB);

    // Front knees bend slightly backward, hind hocks bend forward-backward
    const bendSign = leg.isFront ? 1 : -1;
    const hipPitch = baseAngle + bendSign * angleA;
    const kneePitch = -bendSign * (Math.PI - kneeInterior);

    leg.upper.rotation.x = hipPitch;
    leg.upper.rotation.z = THREE.MathUtils.clamp(dx * 0.85, -0.35, 0.35);
    leg.lower.rotation.x = kneePitch;
  }
}
