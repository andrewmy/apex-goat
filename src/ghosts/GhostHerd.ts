import * as THREE from 'three';
import { GoatRig } from '../goat/GoatRig';
import { GhostRecording, SurfaceType } from '../types';
import { AlpineCourse } from '../world/AlpineCourse';
import { PebbleParticles } from '../vfx/PebbleParticles';

export interface HerdCollisionEvent {
  type: 'ram' | 'bump';
  position: THREE.Vector3;
  pushDir: THREE.Vector3;
  surface: SurfaceType;
}

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
  // Physical knockback / ragdoll tumble state when rammed!
  knocked: boolean;
  knockTimer: number;
  knockVel: THREE.Vector3;
  knockAngVel: THREE.Vector3;
  bumpCooldown: number;
  currentSurface: SurfaceType;
}

/**
 * Populates the mountain with:
 * 1. A lively 10-goat physical alpine herd staggered across the entire descent—solid hitboxes
 *    you can shoulder-bump or BLAST flying off the cliff with a Headbutt Ram!
 * 2. Your translucent cyan Personal Best Trackmania ghost (always intangible).
 */
export class GhostHerd {
  private readonly course: AlpineCourse;
  private readonly herd: HerdMate[] = [];
  private readonly pbRig: GoatRig;
  private readonly _ray = new THREE.Ray();
  private readonly _down = new THREE.Vector3(0, -1, 0);
  private readonly _rotMat = new THREE.Matrix4();
  private readonly _targetQuat = new THREE.Quaternion();
  private readonly _spinQuat = new THREE.Quaternion();
  private readonly _spinEuler = new THREE.Euler();
  private readonly _samplePos = new THREE.Vector3();
  private readonly _sampleTan = new THREE.Vector3();
  private readonly _sampleRight = new THREE.Vector3();
  private readonly _sampleUp = new THREE.Vector3();
  private readonly _right = new THREE.Vector3();
  private readonly _up = new THREE.Vector3();
  private readonly _fwd = new THREE.Vector3();
  private readonly _pos = new THREE.Vector3();
  private readonly _rayOrigin = new THREE.Vector3();
  private readonly _hitCenter = new THREE.Vector3();
  private readonly _diff = new THREE.Vector3();

  constructor(scene: THREE.Scene, course: AlpineCourse) {
    this.course = course;

    // 28 varied alpine mountain goats forming a lively stampede from Start Ridge to Snow Bowl!
    const coatPalette: Array<[number, number]> = [
      [0xf7f5f0, 0xded9ce],
      [0xeae2d2, 0xd5c8b4],
      [0xf5f2ea, 0xe3dcd0],
      [0xe3d8c5, 0xc9bca6],
      [0xf0ece2, 0xd7cfc0],
      [0xdfd7c8, 0xc4b9a6],
    ];

    const herdSpecs: Array<{
      coat: number;
      accent: number;
      startLeadT: number;
      durationSec: number;
      lat: number;
    }> = [
      // Immediate start-ridge pack (Gold / Silver pacers right in front of you!)
      { coat: 0xf7f5f0, accent: 0xded9ce, startLeadT: 0.014, durationSec: 32.0, lat: -1.4 },
      { coat: 0xeae2d2, accent: 0xd5c8b4, startLeadT: 0.02, durationSec: 34.5, lat: 1.4 },
      { coat: 0xf5f2ea, accent: 0xe3dcd0, startLeadT: 0.009, durationSec: 37.0, lat: -0.2 },
      { coat: 0xe3d8c5, accent: 0xc9bca6, startLeadT: 0.006, durationSec: 40.5, lat: 2.2 },
    ];

    // Add 24 more staggered alpine herd clusters down Razor Ledge, Granite Rollers, Scree Chute & Snow Bowl
    for (let i = 0; i < 24; i++) {
      const frac = (i + 1) / 25;
      // Cluster goats slightly in lively 2-3 goat mini-packs so you can bowl through groups!
      const clusterJitter = ((i % 3) - 1) * 0.006;
      const startLeadT = THREE.MathUtils.clamp(0.032 + frac * 0.68 + clusterJitter, 0.025, 0.74);
      const pal = coatPalette[i % coatPalette.length];
      const lanePattern = [-2.6, -1.1, 0.4, 1.9, -1.8, 2.5];
      const lat = lanePattern[i % lanePattern.length] + ((i % 5) - 2) * 0.25;
      const durationSec = 35 + (i % 7) * 2.8 + frac * 8;
      herdSpecs.push({
        coat: pal[0],
        accent: pal[1],
        startLeadT,
        durationSec,
        lat,
      });
    }

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
        lateralPhase: i * 1.45,
        gaitPhase: i * 0.27,
        particleTimer: 0,
        startLeadT: sp.startLeadT,
        smoothedPos: new THREE.Vector3(),
        smoothedQuat: new THREE.Quaternion(),
        initialized: false,
        knocked: false,
        knockTimer: 0,
        knockVel: new THREE.Vector3(),
        knockAngVel: new THREE.Vector3(),
        bumpCooldown: 0,
        currentSurface: SurfaceType.Granite,
      });
    }

    // Translucent cyan Personal Best ghost (always intangible)
    this.pbRig = new GoatRig({
      coatColor: 0x5df2ff,
      accentColor: 0x3ad4ff,
      opacity: 0.42,
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
      mate.knocked = false;
      mate.knockTimer = 0;
      mate.knockVel.set(0, 0, 0);
      mate.bumpCooldown = 0;
    }
  }

  /**
   * Checks real sphere hitboxes against the entire 28-goat physical herd.
   * Returns ALL collisions this tick so a single Headbutt Ram can bowl through a tight cluster of goats!
   */
  public resolvePlayerCollision(
    playerPos: THREE.Vector3,
    playerVel: THREE.Vector3,
    playerFwd: THREE.Vector3,
    isHeadbutting: boolean,
  ): HerdCollisionEvent[] {
    const hits: HerdCollisionEvent[] = [];
    this._hitCenter.copy(playerPos);
    if (isHeadbutting) {
      this._hitCenter.addScaledVector(playerFwd, 0.9);
    }
    const ramRadius = 1.8;
    const bodyRadius = 1.12;
    const checkRadius = isHeadbutting ? ramRadius : bodyRadius;
    const checkRadiusSq = checkRadius * checkRadius;

    for (const mate of this.herd) {
      if (!mate.initialized || mate.knocked || mate.bumpCooldown > 0) continue;

      const mx = mate.smoothedPos.x;
      const my = mate.smoothedPos.y + 0.85;
      const mz = mate.smoothedPos.z;

      this._diff.set(this._hitCenter.x - mx, this._hitCenter.y - my, this._hitCenter.z - mz);
      const distSq = this._diff.lengthSq();
      if (distSq >= checkRadiusSq) continue;

      const dist = Math.max(0.01, Math.sqrt(distSq));
      const pushDir = this._diff.divideScalar(dist).clone();
      pushDir.y = 0;
      if (pushDir.lengthSq() < 0.001) {
        pushDir.set(1, 0, 0);
      } else {
        pushDir.normalize();
      }

      if (isHeadbutting) {
        mate.knocked = true;
        mate.knockTimer = 0;
        const playerSpd = playerVel.length();
        const launchFwd = Math.max(14, playerSpd * 0.9 + 10);
        const sideDirX = -pushDir.x;
        const sideDirZ = -pushDir.z;
        mate.knockVel.set(
          playerFwd.x * launchFwd + sideDirX * 11.5,
          10.5 + Math.min(6, playerSpd * 0.16),
          playerFwd.z * launchFwd + sideDirZ * 11.5,
        );
        mate.knockAngVel.set(
          (Math.random() - 0.5) * 14,
          (Math.random() - 0.5) * 14,
          (Math.random() > 0.5 ? 1 : -1) * (9 + Math.random() * 6),
        );

        hits.push({
          type: 'ram',
          position: new THREE.Vector3(mx, my, mz),
          pushDir,
          surface: mate.currentSurface,
        });
      } else {
        mate.bumpCooldown = 0.28;
        mate.lateralOffset += (pushDir.x > 0 ? -1 : 1) * 1.1;
        hits.push({
          type: 'bump',
          position: new THREE.Vector3(mx, my, mz),
          pushDir,
          surface: mate.currentSurface,
        });
      }
    }

    return hits;
  }

  public update(
    dt: number,
    runTime: number,
    runStarted: boolean,
    pb: GhostRecording | null,
    particles: PebbleParticles,
  ): void {
    // 1. Update live 10-goat physical herd
    for (const mate of this.herd) {
      mate.bumpCooldown = Math.max(0, mate.bumpCooldown - dt);

      if (mate.knocked) {
        // Simulate knocked-out goat flying & bouncing wildly off cliffs!
        mate.knockTimer += dt;
        mate.knockVel.y -= 28.0 * dt;
        mate.smoothedPos.addScaledVector(mate.knockVel, dt);

        // Simple bounce off cliff surface if it hits rock during tumble
        this._rayOrigin.set(mate.smoothedPos.x, mate.smoothedPos.y + 1.4, mate.smoothedPos.z);
        this._ray.set(this._rayOrigin, this._down);
        const hit = this.course.bvh.raycastFirst(this._ray, THREE.FrontSide);
        if (hit && hit.distance < 1.5 && hit.face && mate.knockVel.y < 0) {
          mate.smoothedPos.y = hit.point.y + 0.15;
          const vn = mate.knockVel.dot(hit.face.normal);
          if (vn < 0) {
            mate.knockVel.addScaledVector(hit.face.normal, -1.45 * vn);
            mate.knockVel.multiplyScalar(0.75);
            particles.emitBurst(
              hit.point,
              mate.knockVel.clone().multiplyScalar(0.25),
              mate.currentSurface,
              6,
            );
          }
        }

        // Wild 3-axis ragdoll spin!
        this._spinEuler.set(
          mate.knockAngVel.x * dt,
          mate.knockAngVel.y * dt,
          mate.knockAngVel.z * dt,
        );
        this._spinQuat.setFromEuler(this._spinEuler);
        mate.smoothedQuat.multiply(this._spinQuat).normalize();

        mate.rig.root.position.copy(mate.smoothedPos);
        mate.rig.root.quaternion.copy(mate.smoothedQuat);
        this.animateSimpleQuadruped(mate.rig, mate.gaitPhase + mate.knockTimer * 8, true);

        // Keep trailing pebbles/dust while tumbling
        mate.particleTimer += dt;
        if (mate.particleTimer > 0.1 && mate.knockTimer < 2.2) {
          mate.particleTimer = 0;
          particles.emitBurst(mate.smoothedPos, new THREE.Vector3(0, 1, 0), mate.currentSurface, 2);
        }
        continue;
      }

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
      mate.currentSurface = info.surface;

      const latWave =
        mate.lateralOffset * Math.min(1, info.width / 10) +
        Math.sin(mate.t * 28 + mate.lateralPhase) * (info.width * 0.13);

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
        const interval = info.surface === SurfaceType.Scree ? 0.1 : 0.24;
        if (mate.particleTimer >= interval) {
          mate.particleTimer = 0;
          particles.emitBurst(
            mate.smoothedPos,
            this._fwd.clone().multiplyScalar(-6),
            info.surface,
            info.surface === SurfaceType.Scree ? 3 : 2,
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
