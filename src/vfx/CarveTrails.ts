import * as THREE from 'three';
import { GoatPhysicsSnapshot, SurfaceType } from '../types';
import { AlpineCourse } from '../world/AlpineCourse';

const MAX_SEGMENTS_PER_RIBBON = 260;
const RIBBON_COUNT = 2;
const TOTAL_QUADS = MAX_SEGMENTS_PER_RIBBON * RIBBON_COUNT;
const VERTS_PER_QUAD = 4;
const TOTAL_VERTS = TOTAL_QUADS * VERTS_PER_QUAD;
const TRAIL_LIFETIME_SEC = 14.0;
const TRAIL_FADE_START_SEC = 9.5;
const MIN_STEP_DIST_SQ = 0.55 * 0.55;
const MAX_STEP_DIST_SQ = 4.2 * 4.2;
const HOOF_TRACK_OFFSET = 0.23;

interface TrackPrevPoint {
  leftX: number;
  leftY: number;
  leftZ: number;
  rightX: number;
  rightY: number;
  rightZ: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

function createEmptyPrev(): TrackPrevPoint {
  return {
    leftX: 0,
    leftY: 0,
    leftZ: 0,
    rightX: 0,
    rightY: 0,
    rightZ: 0,
    r: 1,
    g: 1,
    b: 1,
    a: 0,
  };
}

/**
 * Single-draw-call, zero-GC persistent carve & skid trail renderer.
 * Leaves twin fading hoof-track ribbons across Snow (ice-blue recessed grooves),
 * Scree (dark churned shale ruts), and hard-carving Turf (earthy scuffs),
 * cleanly breaking whenever the goat leaps airborne or changes cliffs.
 */
export class CarveTrails {
  private readonly course: AlpineCourse;
  private readonly mesh: THREE.Mesh;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;

  private readonly slotAge = new Float32Array(TOTAL_QUADS);
  private readonly slotBaseAlpha = new Float32Array(TOTAL_QUADS);
  private readonly slotPrevAlpha = new Float32Array(TOTAL_QUADS);

  private cursor = 0;
  private activeCount = 0;
  private hasPrev = false;
  private readonly prevCenter = new THREE.Vector3();
  private readonly prevTracks: [TrackPrevPoint, TrackPrevPoint] = [
    createEmptyPrev(),
    createEmptyPrev(),
  ];

  // Zero-GC scratch vectors
  private readonly _right = new THREE.Vector3();
  private readonly _ray = new THREE.Ray();
  private readonly _rayOrigin = new THREE.Vector3();
  private readonly _rayDir = new THREE.Vector3();
  private readonly _trackCenter = new THREE.Vector3();
  private readonly _trackNormal = new THREE.Vector3();
  private readonly _surfaceColor = new THREE.Color();

  constructor(scene: THREE.Scene, course: AlpineCourse) {
    this.course = course;
    this.slotAge.fill(-1);

    this.positions = new Float32Array(TOTAL_VERTS * 3);
    this.colors = new Float32Array(TOTAL_VERTS * 4);

    const indices = new Uint16Array(TOTAL_QUADS * 6);
    for (let q = 0; q < TOTAL_QUADS; q++) {
      const v = q * 4;
      const i = q * 6;
      indices[i] = v;
      indices[i + 1] = v + 1;
      indices[i + 2] = v + 2;
      indices[i + 3] = v + 1;
      indices[i + 4] = v + 3;
      indices[i + 5] = v + 2;
    }

    const geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.colors, 4);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute('position', this.posAttr);
    geometry.setAttribute('color', this.colAttr);
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
  }

  public breakRibbon(): void {
    this.hasPrev = false;
  }

  public reset(): void {
    this.hasPrev = false;
    this.cursor = 0;
    this.activeCount = 0;
    this.slotAge.fill(-1);
    this.positions.fill(0);
    this.colors.fill(0);
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }

  public update(dt: number, snap: GoatPhysicsSnapshot): void {
    let posDirty = false;
    let colDirty = false;

    // 1. Age and smoothly fade active trail quads
    if (this.activeCount > 0) {
      let alive = 0;
      for (let q = 0; q < TOTAL_QUADS; q++) {
        const age = this.slotAge[q];
        if (age < 0) continue;

        const nextAge = age + dt;
        if (nextAge >= TRAIL_LIFETIME_SEC) {
          this.slotAge[q] = -1;
          this.collapseQuad(q);
          posDirty = true;
          colDirty = true;
          continue;
        }

        this.slotAge[q] = nextAge;
        alive++;

        if (nextAge > TRAIL_FADE_START_SEC) {
          const fade =
            1 - (nextAge - TRAIL_FADE_START_SEC) / (TRAIL_LIFETIME_SEC - TRAIL_FADE_START_SEC);
          const vBase = q * 4;
          const prevA = this.slotPrevAlpha[q] * fade;
          const currA = this.slotBaseAlpha[q] * fade;
          this.colors[(vBase + 0) * 4 + 3] = prevA;
          this.colors[(vBase + 1) * 4 + 3] = prevA;
          this.colors[(vBase + 2) * 4 + 3] = currA;
          this.colors[(vBase + 3) * 4 + 3] = currA;
          colDirty = true;
        }
      }
      this.activeCount = alive;
    }

    // 2. Check emission eligibility (grounded, moving, carve-capable surface)
    const canTrackSurface = this.resolveSurfaceStyle(snap);
    if (!snap.grounded || snap.bailedOut || snap.speed < 4.5 || !canTrackSurface) {
      this.hasPrev = false;
      if (posDirty) this.posAttr.needsUpdate = true;
      if (colDirty) this.colAttr.needsUpdate = true;
      return;
    }

    // Compute goat lateral right vector projected onto the slope plane
    this._right.crossVectors(snap.forward, snap.groundNormal);
    if (this._right.lengthSq() < 0.0001) {
      this._right.set(1, 0, 0);
    } else {
      this._right.normalize();
    }

    // Distance gate to keep ribbons smooth without over-emitting or stretching across teleports
    if (this.hasPrev) {
      const distSq = snap.position.distanceToSquared(this.prevCenter);
      if (distSq > MAX_STEP_DIST_SQ) {
        this.hasPrev = false;
      } else if (distSq < MIN_STEP_DIST_SQ) {
        if (posDirty) this.posAttr.needsUpdate = true;
        if (colDirty) this.colAttr.needsUpdate = true;
        return;
      }
    }

    const carveBoost = Math.min(1, Math.abs(snap.steerAngle) * 1.15 + (snap.pumpingNow ? 0.65 : 0));
    const halfWidth = this.getTrackHalfWidth(snap.surface, carveBoost);
    const alpha = this.getTrackAlpha(snap.surface, carveBoost);
    const r = this._surfaceColor.r;
    const g = this._surfaceColor.g;
    const b = this._surfaceColor.b;

    // Sample left (-1) and right (+1) hoof track points snapped onto the BVH cliff mesh
    for (let sideIdx = 0; sideIdx < 2; sideIdx++) {
      const sideSign = sideIdx === 0 ? -1 : 1;
      this.sampleSurfaceTrackPoint(snap, sideSign * HOOF_TRACK_OFFSET);

      const lx = this._trackCenter.x - this._right.x * halfWidth;
      const ly = this._trackCenter.y - this._right.y * halfWidth;
      const lz = this._trackCenter.z - this._right.z * halfWidth;

      const rx = this._trackCenter.x + this._right.x * halfWidth;
      const ry = this._trackCenter.y + this._right.y * halfWidth;
      const rz = this._trackCenter.z + this._right.z * halfWidth;

      const prev = this.prevTracks[sideIdx];
      if (this.hasPrev) {
        this.emitQuad(prev, lx, ly, lz, rx, ry, rz, r, g, b, alpha);
        posDirty = true;
        colDirty = true;
      }

      prev.leftX = lx;
      prev.leftY = ly;
      prev.leftZ = lz;
      prev.rightX = rx;
      prev.rightY = ry;
      prev.rightZ = rz;
      prev.r = r;
      prev.g = g;
      prev.b = b;
      prev.a = this.hasPrev ? alpha : alpha * 0.25; // Soft fade-in on ribbon start
    }

    this.prevCenter.copy(snap.position);
    this.hasPrev = true;

    if (posDirty) this.posAttr.needsUpdate = true;
    if (colDirty) this.colAttr.needsUpdate = true;
  }

  private resolveSurfaceStyle(snap: GoatPhysicsSnapshot): boolean {
    if (snap.surface === SurfaceType.Snow) {
      this._surfaceColor.setHex(0x88b4da);
      return true;
    }
    if (snap.surface === SurfaceType.Scree) {
      this._surfaceColor.setHex(0x282d36);
      return true;
    }
    if (snap.surface === SurfaceType.Turf) {
      if (Math.abs(snap.steerAngle) > 0.25 || snap.pumpingNow || snap.speed > 14) {
        this._surfaceColor.setHex(0x4c402f);
        return true;
      }
      return false;
    }
    // Granite: faint chalky hoof skid only during hard high-speed carving
    if (Math.abs(snap.steerAngle) > 0.55 && snap.speed > 19) {
      this._surfaceColor.setHex(0x63676e);
      return true;
    }
    return false;
  }

  private getTrackHalfWidth(surface: SurfaceType, carveBoost: number): number {
    const base =
      surface === SurfaceType.Snow
        ? 0.085
        : surface === SurfaceType.Scree
          ? 0.095
          : surface === SurfaceType.Turf
            ? 0.075
            : 0.06;
    return base + carveBoost * 0.045;
  }

  private getTrackAlpha(surface: SurfaceType, carveBoost: number): number {
    if (surface === SurfaceType.Snow) return Math.min(0.68, 0.48 + carveBoost * 0.18);
    if (surface === SurfaceType.Scree) return Math.min(0.74, 0.54 + carveBoost * 0.18);
    if (surface === SurfaceType.Turf) return Math.min(0.46, 0.3 + carveBoost * 0.14);
    return 0.22;
  }

  private sampleSurfaceTrackPoint(snap: GoatPhysicsSnapshot, lateralOffset: number): void {
    // Cast a short ray along -groundNormal from slightly above hoof height to hug rock/snow curvature
    this._trackNormal.copy(snap.groundNormal);
    this._rayOrigin
      .copy(snap.position)
      .addScaledVector(this._right, lateralOffset)
      .addScaledVector(this._trackNormal, 0.15);
    this._rayDir.copy(this._trackNormal).negate();
    this._ray.set(this._rayOrigin, this._rayDir);

    const hit = this.course.bvh.raycastFirst(this._ray, THREE.FrontSide);
    if (hit && hit.distance > 0.2 && hit.distance < 1.9) {
      if (hit.face) {
        this._trackNormal.copy(hit.face.normal).normalize();
      }
      this._trackCenter.copy(hit.point).addScaledVector(this._trackNormal, 0.045);
    } else {
      // Fallback to goat foot level (~0.84m below physics center) lifted +0.045m
      this._trackCenter
        .copy(snap.position)
        .addScaledVector(this._right, lateralOffset)
        .addScaledVector(snap.groundNormal, -0.795);
    }
  }

  private emitQuad(
    prev: TrackPrevPoint,
    lx: number,
    ly: number,
    lz: number,
    rx: number,
    ry: number,
    rz: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    const q = this.cursor;
    this.cursor = (this.cursor + 1) % TOTAL_QUADS;

    if (this.slotAge[q] < 0) {
      this.activeCount++;
    }
    this.slotAge[q] = 0;
    this.slotPrevAlpha[q] = prev.a;
    this.slotBaseAlpha[q] = a;

    const vBase = q * 4;
    const p = this.positions;
    const c = this.colors;

    // v0: prev left
    p[(vBase + 0) * 3] = prev.leftX;
    p[(vBase + 0) * 3 + 1] = prev.leftY;
    p[(vBase + 0) * 3 + 2] = prev.leftZ;
    c[(vBase + 0) * 4] = prev.r;
    c[(vBase + 0) * 4 + 1] = prev.g;
    c[(vBase + 0) * 4 + 2] = prev.b;
    c[(vBase + 0) * 4 + 3] = prev.a;

    // v1: prev right
    p[(vBase + 1) * 3] = prev.rightX;
    p[(vBase + 1) * 3 + 1] = prev.rightY;
    p[(vBase + 1) * 3 + 2] = prev.rightZ;
    c[(vBase + 1) * 4] = prev.r;
    c[(vBase + 1) * 4 + 1] = prev.g;
    c[(vBase + 1) * 4 + 2] = prev.b;
    c[(vBase + 1) * 4 + 3] = prev.a;

    // v2: curr left
    p[(vBase + 2) * 3] = lx;
    p[(vBase + 2) * 3 + 1] = ly;
    p[(vBase + 2) * 3 + 2] = lz;
    c[(vBase + 2) * 4] = r;
    c[(vBase + 2) * 4 + 1] = g;
    c[(vBase + 2) * 4 + 2] = b;
    c[(vBase + 2) * 4 + 3] = a;

    // v3: curr right
    p[(vBase + 3) * 3] = rx;
    p[(vBase + 3) * 3 + 1] = ry;
    p[(vBase + 3) * 3 + 2] = rz;
    c[(vBase + 3) * 4] = r;
    c[(vBase + 3) * 4 + 1] = g;
    c[(vBase + 3) * 4 + 2] = b;
    c[(vBase + 3) * 4 + 3] = a;
  }

  private collapseQuad(q: number): void {
    const vBase = q * 4;
    for (let k = 0; k < 4; k++) {
      const pi = (vBase + k) * 3;
      const ci = (vBase + k) * 4;
      this.positions[pi] = 0;
      this.positions[pi + 1] = 0;
      this.positions[pi + 2] = 0;
      this.colors[ci + 3] = 0;
    }
  }
}
