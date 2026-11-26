import * as THREE from 'three';
import { SurfaceType } from '../types';
import { AlpineCourse } from './AlpineCourse';
import { GhostHerd } from '../ghosts/GhostHerd';
import { PebbleParticles } from '../vfx/PebbleParticles';

export type HazardFlavor = 'rockslide' | 'avalanche';

export interface HazardUpdateResult {
  active: boolean;
  flavor: HazardFlavor;
  speedKmh: number;
  proximity: number; // 0..1 for haptics & camera shake
  hitPlayer: boolean;
  impactDir: THREE.Vector3;
  slideDodged: boolean;
  herdKnockedCount: number;
}

interface BoulderState {
  active: boolean;
  delay: number;
  radius: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  rotVel: THREE.Vector3;
  scale: THREE.Vector3;
  puffTimer: number;
  bounceCooldown: number;
}

interface CloudPuffState {
  active: boolean;
  age: number;
  life: number;
  startScale: number;
  endScale: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
}

const HAZARD_DURATION_SEC = 7.4;
const HAZARD_COOLDOWN_SEC = 8.0;

/**
 * Triggerable Alpine Hazard (`G` — Rockslide / Snow-Slab Avalanche).
 * Never spawns automatically so PB time-trials stay pure; when manually triggered,
 * fractures boulders or snow slabs off the inner cliff face ahead of the player,
 * cascading downslope & across the corridor with real BVH bounces, billowing dust/snow
 * clouds, player wipeout physics, herd goat ragdoll scatter, and a Slide Dodge bonus!
 */
export class AlpineHazard {
  private readonly course: AlpineCourse;
  private readonly boulderMesh: THREE.InstancedMesh;
  private readonly cloudMesh: THREE.InstancedMesh;
  private readonly cloudMat: THREE.MeshStandardMaterial;
  private readonly boulders: BoulderState[] = [];
  private readonly puffs: CloudPuffState[] = [];
  private readonly boulderCount: number;
  private readonly puffCount: number;

  private active = false;
  private flavor: HazardFlavor = 'rockslide';
  private elapsed = 0;
  private cooldown = 0;
  private playerHitThisHazard = false;
  private playerNearMissed = false;
  private dodgeAwarded = false;
  private puffCursor = 0;
  private herdCheckTimer = 0;

  // Zero-GC scratch objects
  private readonly _dummy = new THREE.Object3D();
  private readonly _zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly _ray = new THREE.Ray();
  private readonly _down = new THREE.Vector3(0, -1, 0);
  private readonly _rayOrigin = new THREE.Vector3();
  private readonly _samplePos = new THREE.Vector3();
  private readonly _sampleTan = new THREE.Vector3();
  private readonly _sampleRight = new THREE.Vector3();
  private readonly _sampleUp = new THREE.Vector3();
  private readonly _impulseDir = new THREE.Vector3();
  private readonly _impactDir = new THREE.Vector3();
  private readonly _color = new THREE.Color();
  private readonly _result: HazardUpdateResult = {
    active: false,
    flavor: 'rockslide',
    speedKmh: 0,
    proximity: 0,
    hitPlayer: false,
    impactDir: new THREE.Vector3(),
    slideDodged: false,
    herdKnockedCount: 0,
  };

  constructor(scene: THREE.Scene, course: AlpineCourse, options?: { isMobile?: boolean }) {
    this.course = course;
    const isMobile = options?.isMobile ?? false;
    this.boulderCount = isMobile ? 12 : 24;
    this.puffCount = isMobile ? 16 : 32;

    // 1. Instanced craggy boulders / ice slabs
    const boulderGeo = new THREE.DodecahedronGeometry(1.0, 0);
    const boulderMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.88,
      metalness: 0.04,
      flatShading: true,
    });
    this.boulderMesh = new THREE.InstancedMesh(boulderGeo, boulderMat, this.boulderCount);
    this.boulderMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.boulderMesh.frustumCulled = false;
    this.boulderMesh.castShadow = !isMobile;
    this.boulderMesh.receiveShadow = true;

    for (let i = 0; i < this.boulderCount; i++) {
      this.boulders.push({
        active: false,
        delay: 0,
        radius: 1.0,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        rot: new THREE.Euler(),
        rotVel: new THREE.Vector3(),
        scale: new THREE.Vector3(1, 1, 1),
        puffTimer: 0,
        bounceCooldown: 0,
      });
      this.boulderMesh.setMatrixAt(i, this._zeroMat);
      this.boulderMesh.setColorAt(i, this._color.setHex(0x8a867e));
    }
    this.boulderMesh.visible = false;
    scene.add(this.boulderMesh);

    // 2. Instanced billowing dust / snow cloud puffs
    const cloudGeo = new THREE.IcosahedronGeometry(1.0, 1);
    this.cloudMat = new THREE.MeshStandardMaterial({
      color: 0xd4ccbe,
      roughness: 1.0,
      metalness: 0.0,
      flatShading: true,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    this.cloudMesh = new THREE.InstancedMesh(cloudGeo, this.cloudMat, this.puffCount);
    this.cloudMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cloudMesh.frustumCulled = false;
    this.cloudMesh.renderOrder = 3;

    for (let i = 0; i < this.puffCount; i++) {
      this.puffs.push({
        active: false,
        age: 0,
        life: 1.6,
        startScale: 1.0,
        endScale: 3.4,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        rot: new THREE.Euler(),
      });
      this.cloudMesh.setMatrixAt(i, this._zeroMat);
    }
    this.cloudMesh.visible = false;
    scene.add(this.cloudMesh);
  }

  public isActive(): boolean {
    return this.active;
  }

  public getFlavor(): HazardFlavor {
    return this.flavor;
  }

  public getCooldownRemaining(): number {
    return this.cooldown;
  }

  public canTrigger(): boolean {
    return !this.active && this.cooldown <= 0;
  }

  public getFlavorForLocation(playerT: number, surface: SurfaceType): HazardFlavor {
    if (surface === SurfaceType.Snow || (playerT >= 0.705 && playerT <= 0.855)) {
      return 'avalanche';
    }
    return 'rockslide';
  }

  public reset(): void {
    this.active = false;
    this.elapsed = 0;
    this.cooldown = 0;
    this.playerHitThisHazard = false;
    this.playerNearMissed = false;
    this.dodgeAwarded = false;
    this.herdCheckTimer = 0;

    for (let i = 0; i < this.boulderCount; i++) {
      this.boulders[i].active = false;
      this.boulderMesh.setMatrixAt(i, this._zeroMat);
    }
    this.boulderMesh.instanceMatrix.needsUpdate = true;
    this.boulderMesh.visible = false;

    for (let i = 0; i < this.puffCount; i++) {
      this.puffs[i].active = false;
      this.cloudMesh.setMatrixAt(i, this._zeroMat);
    }
    this.cloudMesh.instanceMatrix.needsUpdate = true;
    this.cloudMesh.visible = false;
  }

  /** Manually triggers a Rockslide or Snow-Slab Avalanche ahead of the player */
  public trigger(playerT: number, surface: SurfaceType): HazardFlavor | null {
    if (!this.canTrigger()) return null;

    this.flavor = this.getFlavorForLocation(playerT, surface);
    this.active = true;
    this.elapsed = 0;
    this.playerHitThisHazard = false;
    this.playerNearMissed = false;
    this.dodgeAwarded = false;
    this.herdCheckTimer = 0;

    const isAvalanche = this.flavor === 'avalanche';
    this.cloudMat.color.setHex(isAvalanche ? 0xeaf6ff : 0xc6baa8);
    this.cloudMat.opacity = isAvalanche ? 0.5 : 0.4;

    // Spawn 35-55m ahead of the player along the inner cliff wall!
    const baseSpawnT = THREE.MathUtils.clamp(playerT + 0.036, 0.025, this.course.finishT - 0.025);

    for (let i = 0; i < this.boulderCount; i++) {
      const b = this.boulders[i];
      const frac = i / Math.max(1, this.boulderCount - 1);
      const tOffset = (frac - 0.35) * 0.026 + (Math.random() - 0.5) * 0.006;
      const spawnT = THREE.MathUtils.clamp(baseSpawnT + tOffset, 0.015, this.course.finishT - 0.01);

      const info = this.course.getInterpolatedSampleAt(
        spawnT,
        this._samplePos,
        this._sampleTan,
        this._sampleRight,
        this._sampleUp,
      );
      const sample = this.course.getSampleAt(spawnT);
      const wallSide = sample.wallSide; // -1 = cliff wall on left, +1 = cliff wall on right

      // Perch boulders up the inner cliff face so they visibly fracture & tumble across the track
      const lateralWallDist = info.width * 0.52 + 2.5 + Math.random() * 5.5;
      const cliffHeight = 7.0 + Math.random() * 14.0;
      b.pos
        .copy(this._samplePos)
        .addScaledVector(this._sampleRight, wallSide * lateralWallDist)
        .addScaledVector(THREE.Object3D.DEFAULT_UP, cliffHeight);

      // Cascade downslope + across corridor toward outer drop-off (~26-36 m/s)
      const acrossSpeed = 12.5 + Math.random() * 9.5;
      const downSpeed = 19.0 + Math.random() * 11.5;
      b.vel
        .copy(this._sampleTan)
        .multiplyScalar(downSpeed)
        .addScaledVector(this._sampleRight, -wallSide * acrossSpeed);
      b.vel.y -= 4.0 + Math.random() * 5.0;

      b.radius = isAvalanche ? 0.95 + Math.random() * 1.15 : 0.78 + Math.random() * 1.05;
      b.scale.set(
        b.radius * (0.85 + Math.random() * 0.4),
        b.radius * (isAvalanche ? 0.58 + Math.random() * 0.32 : 0.75 + Math.random() * 0.42),
        b.radius * (0.85 + Math.random() * 0.4),
      );
      b.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      b.rotVel.set((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9);
      b.delay = frac * 0.95 + Math.random() * 0.2;
      b.puffTimer = Math.random() * 0.14;
      b.bounceCooldown = 0;
      b.active = true;

      if (isAvalanche) {
        this._color
          .setHex(i % 3 === 0 ? 0xc8e7ff : 0xf2f8ff)
          .offsetHSL(0, 0, (Math.random() - 0.5) * 0.06);
      } else {
        this._color
          .setHex(i % 2 === 0 ? 0x8d867a : 0x5c6068)
          .offsetHSL(0, 0, (Math.random() - 0.5) * 0.1);
      }
      this.boulderMesh.setColorAt(i, this._color);
      this.boulderMesh.setMatrixAt(i, this._zeroMat);
    }

    if (this.boulderMesh.instanceColor) {
      this.boulderMesh.instanceColor.needsUpdate = true;
    }
    this.boulderMesh.instanceMatrix.needsUpdate = true;
    this.boulderMesh.visible = true;
    this.cloudMesh.visible = true;

    return this.flavor;
  }

  public update(
    dt: number,
    playerPos: THREE.Vector3,
    playerBailed: boolean,
    herd: GhostHerd,
    particles: PebbleParticles,
  ): HazardUpdateResult {
    const res = this._result;
    res.hitPlayer = false;
    res.slideDodged = false;
    res.herdKnockedCount = 0;
    res.proximity = 0;
    res.speedKmh = 0;
    res.flavor = this.flavor;

    if (!this.active) {
      if (this.cooldown > 0) {
        this.cooldown = Math.max(0, this.cooldown - dt);
      }
      res.active = false;
      return res;
    }

    this.elapsed += dt;
    this.herdCheckTimer += dt;
    const checkHerdThisFrame = this.herdCheckTimer >= 0.05;
    if (checkHerdThisFrame) this.herdCheckTimer = 0;

    const isAvalanche = this.flavor === 'avalanche';
    const particleSurf = isAvalanche ? SurfaceType.Snow : SurfaceType.Scree;

    let anyBoulderAlive = false;
    let closestDistSq = Infinity;
    let maxSpeedSq = 0;

    for (let i = 0; i < this.boulderCount; i++) {
      const b = this.boulders[i];
      if (!b.active) {
        this.boulderMesh.setMatrixAt(i, this._zeroMat);
        continue;
      }

      if (b.delay > 0) {
        b.delay -= dt;
        anyBoulderAlive = true;
        this.boulderMesh.setMatrixAt(i, this._zeroMat);
        continue;
      }

      b.bounceCooldown = Math.max(0, b.bounceCooldown - dt);
      b.vel.y -= 26.0 * dt;
      b.pos.addScaledVector(b.vel, dt);

      // BVH terrain collision + lively boulder bounce
      this._rayOrigin.set(b.pos.x, b.pos.y + b.radius + 1.8, b.pos.z);
      this._ray.set(this._rayOrigin, this._down);
      const hit = this.course.bvh.raycastFirst(this._ray, THREE.FrontSide);
      if (hit && hit.face && hit.distance <= b.radius * 2.0 + 1.8) {
        const minY = hit.point.y + b.radius * 0.72;
        if (b.pos.y < minY) {
          b.pos.y = minY;
          const vn = b.vel.dot(hit.face.normal);
          if (vn < 0) {
            const restitution = isAvalanche ? 0.28 : 0.44;
            b.vel.addScaledVector(hit.face.normal, -(1 + restitution) * vn);
            // Keep cascading strongly downhill along slope
            b.vel.multiplyScalar(0.95);
            if (b.bounceCooldown <= 0 && Math.abs(vn) > 3.5) {
              b.bounceCooldown = 0.22;
              particles.emitBurst(b.pos, b.vel, particleSurf, isAvalanche ? 4 : 5);
              this.spawnCloudPuff(b.pos, b.vel, isAvalanche);
            }
          }
        }
      }

      // Billowing dust/snow trail behind tumbling boulders
      b.puffTimer -= dt;
      if (b.puffTimer <= 0 && this.elapsed < HAZARD_DURATION_SEC - 1.2) {
        b.puffTimer = isAvalanche ? 0.12 : 0.17;
        this.spawnCloudPuff(b.pos, b.vel, isAvalanche);
      }

      // Cull boulders that plunged deep into the valley below the course
      if (b.pos.y < -260 || this.elapsed >= HAZARD_DURATION_SEC) {
        b.active = false;
        this.boulderMesh.setMatrixAt(i, this._zeroMat);
        continue;
      }

      anyBoulderAlive = true;
      b.rot.x += b.rotVel.x * dt;
      b.rot.y += b.rotVel.y * dt;
      b.rot.z += b.rotVel.z * dt;

      // Shrink gracefully in the final 0.8s so boulders vanish cleanly instead of popping
      const fadeScale =
        this.elapsed > HAZARD_DURATION_SEC - 0.8
          ? Math.max(0, (HAZARD_DURATION_SEC - this.elapsed) / 0.8)
          : 1;
      this._dummy.position.copy(b.pos);
      this._dummy.rotation.copy(b.rot);
      this._dummy.scale.copy(b.scale).multiplyScalar(fadeScale);
      this._dummy.updateMatrix();
      this.boulderMesh.setMatrixAt(i, this._dummy.matrix);

      const spdSq = b.vel.lengthSq();
      if (spdSq > maxSpeedSq) maxSpeedSq = spdSq;

      // Player sphere collision & close-dodge detection
      const dx = playerPos.x - b.pos.x;
      const dy = playerPos.y - b.pos.y;
      const dz = playerPos.z - b.pos.z;
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq < closestDistSq) closestDistSq = dSq;

      if (!playerBailed && !this.playerHitThisHazard) {
        // Fair, leapable hitbox: slightly tighter vertically so leaping over a low boulder works!
        const horizSq = dx * dx + dz * dz;
        const hitR = b.radius * 0.78 + 0.45;
        if (horizSq <= hitR * hitR && Math.abs(dy) <= b.radius * 0.85 + 0.55) {
          this.playerHitThisHazard = true;
          res.hitPlayer = true;
          this._impactDir.copy(b.vel);
          if (this._impactDir.lengthSq() < 0.01) {
            this._impactDir.set(dx, 0.3, dz);
          }
          res.impactDir.copy(this._impactDir.normalize());
          particles.emitBurst(playerPos, b.vel, particleSurf, 16);
        } else if (dSq <= 12.5 * 12.5) {
          this.playerNearMissed = true;
        }
      }

      // Scatter any rival herd goats caught in the slide!
      if (checkHerdThisFrame && i % 2 === 0) {
        this._impulseDir.copy(b.vel).normalize();
        res.herdKnockedCount += herd.applyHazardWave(b.pos, b.radius + 2.8, this._impulseDir);
      }
    }

    this.boulderMesh.instanceMatrix.needsUpdate = true;

    // Update billowing volumetric cloud puffs
    let anyPuffAlive = false;
    for (let i = 0; i < this.puffCount; i++) {
      const p = this.puffs[i];
      if (!p.active) {
        this.cloudMesh.setMatrixAt(i, this._zeroMat);
        continue;
      }

      p.age += dt;
      if (p.age >= p.life) {
        p.active = false;
        this.cloudMesh.setMatrixAt(i, this._zeroMat);
        continue;
      }

      anyPuffAlive = true;
      p.pos.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(Math.max(0, 1 - dt * 1.4));
      p.pos.y += dt * 1.3;

      const t = p.age / p.life;
      // Smooth swell then shrink out at tail
      const envelope = t < 0.25 ? t / 0.25 : 1 - (t - 0.25) / 0.75;
      const sc = THREE.MathUtils.lerp(p.startScale, p.endScale, t) * Math.max(0.01, envelope);

      this._dummy.position.copy(p.pos);
      this._dummy.rotation.copy(p.rot);
      this._dummy.scale.set(sc * 1.15, sc * 0.78, sc * 1.15);
      this._dummy.updateMatrix();
      this.cloudMesh.setMatrixAt(i, this._dummy.matrix);
    }
    this.cloudMesh.instanceMatrix.needsUpdate = true;

    const closestDist = Math.sqrt(closestDistSq);
    res.proximity = closestDist < 48 ? THREE.MathUtils.clamp(1 - closestDist / 48, 0, 1) : 0;
    res.speedKmh = Math.round(Math.sqrt(maxSpeedSq) * 3.6);

    // Award SLIDE DODGE once the player survives a close brush and the slide moves past!
    if (
      this.playerNearMissed &&
      !this.playerHitThisHazard &&
      !this.dodgeAwarded &&
      !playerBailed &&
      (closestDist > 20 || this.elapsed >= HAZARD_DURATION_SEC - 0.6)
    ) {
      this.dodgeAwarded = true;
      res.slideDodged = true;
    }

    if (!anyBoulderAlive && !anyPuffAlive) {
      this.active = false;
      this.cooldown = HAZARD_COOLDOWN_SEC;
      this.boulderMesh.visible = false;
      this.cloudMesh.visible = false;
    }

    res.active = this.active;
    return res;
  }

  private spawnCloudPuff(origin: THREE.Vector3, vel: THREE.Vector3, isAvalanche: boolean): void {
    const p = this.puffs[this.puffCursor];
    this.puffCursor = (this.puffCursor + 1) % this.puffCount;
    p.active = true;
    p.age = 0;
    p.life = isAvalanche ? 1.5 + Math.random() * 0.7 : 1.3 + Math.random() * 0.65;
    p.startScale = isAvalanche ? 1.2 : 0.95;
    p.endScale = isAvalanche ? 4.4 + Math.random() * 1.4 : 3.4 + Math.random() * 1.1;
    p.pos.set(
      origin.x + (Math.random() - 0.5) * 1.6,
      origin.y + Math.random() * 0.8,
      origin.z + (Math.random() - 0.5) * 1.6,
    );
    p.vel.set(
      vel.x * 0.25 + (Math.random() - 0.5) * 2.4,
      0.8 + Math.random() * 1.6,
      vel.z * 0.25 + (Math.random() - 0.5) * 2.4,
    );
    p.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
  }
}
