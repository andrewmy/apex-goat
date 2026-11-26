import * as THREE from 'three';
import { GoatRig } from '../goat/GoatRig';
import { GhostRecording, SurfaceType } from '../types';
import { AlpineCourse } from '../world/AlpineCourse';
import { PebbleParticles } from '../vfx/PebbleParticles';

interface HerdMate {
  rig: GoatRig;
  /** Progress along spline 0..1 */
  t: number;
  baseSpeedT: number;
  lateralOffset: number;
  lateralPhase: number;
  gaitPhase: number;
  particleTimer: number;
  startLeadT: number;
  smoothedPos: THREE.Vector3;
  smoothedQuat: THREE.Quaternion;
  initialized: boolean;
}

/**
 * Populates the cliff with:
 * 1. A lively pack of 4 alpine mountain goats smoothly bounding down the ledges & scree chutes
 *    ahead of your GoPro (continuous spline interpolation + quaternion smoothing = zero jitter!).
 * 2. Your translucent cyan Personal Best Trackmania ghost once you set a time.
 */
export class GhostHerd {
  private readonly course: AlpineCourse;
  private readonly herd: HerdMate[] = [];
  private readonly pbRig: GoatRig;
  private readonly _ray = new THREE.Ray();
  private readonly _down = new THREE.Vector3(0, -1, 0);
  private readonly _rotMat = new THREE.Matrix4();
  private readonly _targetQuat = new THREE.Quaternion();
  private readonly _samplePos = new THREE.Vector3();
  private readonly _sampleTan = new THREE.Vector3();
  private readonly _sampleRight = new THREE.Vector3();
  private readonly _sampleUp = new THREE.Vector3();
  private readonly _right = new THREE.Vector3();
  private readonly _up = new THREE.Vector3();
  private readonly _fwd = new THREE.Vector3();
  private readonly _pos = new THREE.Vector3();
  private readonly _rayOrigin = new THREE.Vector3();

  constructor(scene: THREE.Scene, course: AlpineCourse) {
    this.course = course;

    const herdSpecs = [
      { coat: 0xf5f2ea, accent: 0xe3dcd0, startLeadT: 0.012, durationSec: 38.0, lat: -1.6 },
      { coat: 0xeae2d2, accent: 0xd5c8b4, startLeadT: 0.02, durationSec: 35.0, lat: 1.4 },
      { coat: 0xf7f5f0, accent: 0xded9ce, startLeadT: 0.028, durationSec: 32.0, lat: -0.6 },
      { coat: 0xe3d8c5, accent: 0xc9bca6, startLeadT: 0.008, durationSec: 42.0, lat: 2.0 },
    ];

    for (let i = 0; i < herdSpecs.length; i++) {
      const sp = herdSpecs[i];
      const rig = new GoatRig({
        coatColor: sp.coat,
        accentColor: sp.accent,
      });
      rig.setFirstPersonMode(false);
      scene.add(rig.root);

      this.herd.push({
        rig,
        t: sp.startLeadT,
        baseSpeedT: (0.935 - sp.startLeadT) / sp.durationSec,
        lateralOffset: sp.lat,
        lateralPhase: i * 1.7,
        gaitPhase: i * 0.35,
        particleTimer: 0,
        startLeadT: sp.startLeadT,
        smoothedPos: new THREE.Vector3(),
        smoothedQuat: new THREE.Quaternion(),
        initialized: false,
      });
    }

    this.pbRig = new GoatRig({
      coatColor: 0x5df2ff,
      accentColor: 0x3ad4ff,
      opacity: 0.45,
      isGhost: true,
    });
    this.pbRig.root.visible = false;
    scene.add(this.pbRig.root);
  }

  public reset(): void {
    for (const mate of this.herd) {
      mate.t = mate.startLeadT;
      mate.particleTimer = 0;
      mate.initialized = false;
    }
  }

  public update(
    dt: number,
    runTime: number,
    runStarted: boolean,
    pb: GhostRecording | null,
    particles: PebbleParticles,
  ): void {
    // 1. Update live alpine goat herd with continuous spline interpolation & smooth damping
    for (const mate of this.herd) {
      if (runStarted && mate.t < 0.935) {
        const chuteMul = mate.t > 0.44 && mate.t < 0.68 ? 1.35 : mate.t > 0.88 ? 0.48 : 1.0;
        mate.t = Math.min(0.938, mate.t + mate.baseSpeedT * chuteMul * dt);
      }

      const info = this.course.getInterpolatedSampleAt(
        mate.t,
        this._samplePos,
        this._sampleTan,
        this._sampleRight,
        this._sampleUp,
      );

      const latWave =
        mate.lateralOffset * Math.min(1, info.width / 10) +
        Math.sin(mate.t * 28 + mate.lateralPhase) * (info.width * 0.14);

      this._pos.copy(this._samplePos).addScaledVector(this._sampleRight, latWave);

      let airborne = false;
      if (info.hasGap) {
        airborne = true;
        const gapFrac = THREE.MathUtils.clamp((mate.t - 0.688) / (0.712 - 0.688), 0, 1);
        this._pos.y += Math.sin(gapFrac * Math.PI) * 6.5;
        this._up.set(0, 1, 0);
      } else {
        this._rayOrigin.set(this._pos.x, this._pos.y + 4.5, this._pos.z);
        this._ray.set(this._rayOrigin, this._down);
        const hit = this.course.bvh.raycastFirst(this._ray, THREE.FrontSide);
        if (hit && hit.face && hit.face.normal.y > 0.35) {
          this._pos.y = hit.point.y;
          this._up.copy(hit.face.normal).normalize();
        } else {
          this._up.copy(this._sampleUp);
        }
      }

      this._fwd.copy(this._sampleTan).projectOnPlane(this._up).normalize();
      this._right.crossVectors(this._fwd, this._up).normalize();
      const orthoUp = new THREE.Vector3().crossVectors(this._right, this._fwd).normalize();

      this._rotMat.makeBasis(this._right, orthoUp, this._fwd.clone().negate());
      this._targetQuat.setFromRotationMatrix(this._rotMat);

      if (!mate.initialized) {
        mate.smoothedPos.copy(this._pos);
        mate.smoothedQuat.copy(this._targetQuat);
        mate.initialized = true;
      } else {
        // Horizontal tracks spline tightly; Y & orientation smooth out flat-shaded rock facets!
        const posLerp = Math.min(1, dt * 18);
        const yLerp = Math.min(1, dt * 12);
        const rotLerp = Math.min(1, dt * 9);
        mate.smoothedPos.x += (this._pos.x - mate.smoothedPos.x) * posLerp;
        mate.smoothedPos.z += (this._pos.z - mate.smoothedPos.z) * posLerp;
        mate.smoothedPos.y += (this._pos.y - mate.smoothedPos.y) * yLerp;
        mate.smoothedQuat.slerp(this._targetQuat, rotLerp);
      }

      mate.rig.root.position.copy(mate.smoothedPos);
      mate.rig.root.quaternion.copy(mate.smoothedQuat);

      const gallopSpeed = runStarted && mate.t < 0.935 ? 4.4 : 0.35;
      mate.gaitPhase += gallopSpeed * dt;
      this.animateSimpleQuadruped(mate.rig, mate.gaitPhase, airborne);

      if (runStarted && !airborne && mate.t < 0.92) {
        mate.particleTimer += dt;
        const interval = info.surface === SurfaceType.Scree ? 0.08 : 0.19;
        if (mate.particleTimer >= interval) {
          mate.particleTimer = 0;
          particles.emitBurst(
            mate.smoothedPos,
            this._fwd.clone().multiplyScalar(-6),
            info.surface,
            info.surface === SurfaceType.Scree ? 4 : 2,
          );
        }
      }
    }

    // 2. Update Personal Best translucent ghost
    if (!pb || !runStarted || pb.samples.length < 2) {
      this.pbRig.root.visible = false;
      return;
    }

    this.pbRig.root.visible = true;
    const samples = pb.samples;
    if (runTime >= samples[samples.length - 1].t) {
      this.pbRig.root.visible = false;
      return;
    }

    let lo = 0;
    let hi = samples.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].t <= runTime) lo = mid;
      else hi = mid;
    }
    const a = samples[lo];
    const b = samples[hi];
    const span = Math.max(0.0001, b.t - a.t);
    const f = THREE.MathUtils.clamp((runTime - a.t) / span, 0, 1);

    this._pos.set(
      THREE.MathUtils.lerp(a.px, b.px, f),
      THREE.MathUtils.lerp(a.py, b.py, f) - 0.84,
      THREE.MathUtils.lerp(a.pz, b.pz, f),
    );
    this._fwd
      .set(
        THREE.MathUtils.lerp(a.fx, b.fx, f),
        THREE.MathUtils.lerp(a.fy, b.fy, f),
        THREE.MathUtils.lerp(a.fz, b.fz, f),
      )
      .normalize();
    this._up
      .set(
        THREE.MathUtils.lerp(a.ux, b.ux, f),
        THREE.MathUtils.lerp(a.uy, b.uy, f),
        THREE.MathUtils.lerp(a.uz, b.uz, f),
      )
      .normalize();

    this._right.crossVectors(this._fwd, this._up).normalize();
    const pbUp = new THREE.Vector3().crossVectors(this._right, this._fwd).normalize();

    this.pbRig.root.position.copy(this._pos);
    this._rotMat.makeBasis(this._right, pbUp, this._fwd.clone().negate());
    this.pbRig.root.quaternion.setFromRotationMatrix(this._rotMat);

    const gait = THREE.MathUtils.lerp(a.gait, b.gait, f);
    this.animateSimpleQuadruped(this.pbRig, gait, !a.grounded);
  }

  private animateSimpleQuadruped(rig: GoatRig, phase: number, airborne: boolean): void {
    const bounce = airborne ? 0 : Math.sin(phase * Math.PI * 2) * 0.08;
    rig.bodyPivot.position.y = 0.88 + bounce;
    rig.bodyPivot.rotation.x = airborne ? -0.22 : Math.cos(phase * Math.PI * 2) * 0.12;

    const offsets = [0, 0.22, 0.52, 0.74];
    for (let i = 0; i < rig.legs.length; i++) {
      const leg = rig.legs[i];
      if (airborne) {
        leg.upper.rotation.x = leg.isFront ? -0.75 : 0.75;
        leg.lower.rotation.x = leg.isFront ? 0.95 : -0.65;
      } else {
        const s = Math.sin((phase + offsets[i]) * Math.PI * 2);
        leg.upper.rotation.x = s * 0.65;
        leg.lower.rotation.x = Math.max(0, -s * 0.75) * (leg.isFront ? 1 : -1);
      }
    }
  }
}
