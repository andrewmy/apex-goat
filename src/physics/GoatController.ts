import * as THREE from 'three';
import { GoatPhysicsSnapshot, InputState, SurfaceType } from '../types';
import { AlpineCourse } from '../world/AlpineCourse';
import { getSurfaceConfig } from './SurfaceMaterials';

export interface LandingEvent {
  position: THREE.Vector3;
  impactSpeed: number;
  surface: SurfaceType;
  pumped: boolean;
  pumpGainKmh: number;
  bailed: boolean;
}

export interface JumpEvent {
  position: THREE.Vector3;
  charge: number;
  surface: SurfaceType;
  wallKick: boolean;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Deterministic 120Hz mountain-goat movement & cliff-physics controller.
 *
 * Key feel pillars:
 * - Clean separation between climbable slopes (<= 72°) and vertical wall-run cliffs (> 72°)
 * - Horizon-stabilized steering so climbing or traversing steep rock always feels intuitive
 * - Active Goat Climbing Traction: pressing W on steep rock genuinely claws upward instead of slipping
 * - Juicy Tiny-Wings/Steep Slope-Pumping: hold SHIFT in air to tuck/fast-dive onto steep faces,
 *   and land crouched on any downhill transition for a massive speed surge!
 * - Snappy Out-of-Bounds detection (> 22m below course) so falls never drag out painfully
 */
export class GoatController {
  public position = new THREE.Vector3();
  public prevPosition = new THREE.Vector3();
  public velocity = new THREE.Vector3();
  public forward = new THREE.Vector3(0, 0, -1);
  public prevForward = new THREE.Vector3(0, 0, -1);
  public up = new THREE.Vector3(0, 1, 0);
  public prevUp = new THREE.Vector3(0, 1, 0);

  public grounded = false;
  public groundNormal = new THREE.Vector3(0, 1, 0);
  public surface: SurfaceType = SurfaceType.Turf;
  public slopeDeg = 0;

  public wallRunning = false;
  public wallNormal = new THREE.Vector3();
  public wallSide: -1 | 0 | 1 = 0;

  public crouching = false;
  public crouchAmount = 0;
  public jumpCharge = 0;
  public pumpBoostFlash = 0;
  public lastPumpGainKmh = 0;
  public steerAngle = 0;
  public airTime = 0;
  public gaitPhase = 0;
  public exposureHeight = 0;

  public bailedOut = false;
  public outOfBounds = false;
  public bailTimer = 0;
  public finishedMode = false;
  public activeGroundPump = 0; // 0..1 glow when actively pumping down a steep face!
  public pumpReady = false;

  private coyoteTimer = 0;
  private wallCoyoteTimer = 0;
  private jumpBufferTimer = 0;
  private justJumpedTimer = 0;
  private exposureTick = 0;

  private readonly bodyRadius = 0.56;
  private readonly capsuleHalfHeight = 0.28;

  // Scratch vectors (zero GC allocations per tick)
  private readonly _box = new THREE.Box3();
  private readonly _triClosest = new THREE.Vector3();
  private readonly _delta = new THREE.Vector3();
  private readonly _normal = new THREE.Vector3();
  private readonly _right = new THREE.Vector3();
  private readonly _slopeForward = new THREE.Vector3();
  private readonly _gravSlope = new THREE.Vector3();
  private readonly _ray = new THREE.Ray();
  private readonly _rayOrigin = new THREE.Vector3();
  private readonly _rayDir = new THREE.Vector3();
  private readonly _tmpA = new THREE.Vector3();
  private readonly _tmpB = new THREE.Vector3();
  private readonly _preImpactVel = new THREE.Vector3();
  private readonly _yawAxis = new THREE.Vector3();
  private recentCrouchTimer = 0;

  private readonly course: AlpineCourse;

  constructor(course: AlpineCourse) {
    this.course = course;
    this.resetTo(course.startPosition, course.startForward);
  }

  public resetTo(pos: THREE.Vector3, dir: THREE.Vector3): void {
    this.position.copy(pos);
    this.prevPosition.copy(pos);
    this.velocity.set(0, 0, 0);
    this.forward.copy(dir).setY(0).normalize();
    if (this.forward.lengthSq() < 0.001) this.forward.set(0, 0, -1);
    this.prevForward.copy(this.forward);
    this.up.copy(WORLD_UP);
    this.prevUp.copy(WORLD_UP);
    this.groundNormal.copy(WORLD_UP);

    this.grounded = false;
    this.wallRunning = false;
    this.wallSide = 0;
    this.wallNormal.set(0, 0, 0);
    this.crouching = false;
    this.crouchAmount = 0;
    this.jumpCharge = 0;
    this.pumpBoostFlash = 0;
    this.lastPumpGainKmh = 0;
    this.steerAngle = 0;
    this.airTime = 0;
    this.gaitPhase = 0;
    this.coyoteTimer = 0;
    this.wallCoyoteTimer = 0;
    this.jumpBufferTimer = 0;
    this.justJumpedTimer = 0;
    this.bailedOut = false;
    this.outOfBounds = false;
    this.bailTimer = 0;
    this.finishedMode = false;
    this.activeGroundPump = 0;
    this.pumpReady = false;
    this.slopeDeg = 0;
  }

  public enterFinishState(): void {
    this.finishedMode = true;
    this.bailedOut = false;
    this.outOfBounds = false;
  }

  public step(
    dt: number,
    input: InputState,
    callbacks?: {
      onLand?: (e: LandingEvent) => void;
      onJump?: (e: JumpEvent) => void;
      onOutOfBounds?: () => void;
    },
  ): void {
    this.prevPosition.copy(this.position);
    this.prevForward.copy(this.forward);
    this.prevUp.copy(this.up);

    this.pumpBoostFlash = Math.max(0, this.pumpBoostFlash - dt * 1.9);
    this.justJumpedTimer = Math.max(0, this.justJumpedTimer - dt);

    if (this.bailedOut) {
      this.stepBailout(dt);
      return;
    }

    // Proper Finish Celebration Coast: smoothly decelerates goat in the finish meadow,
    // locking out player drive/jump/OOB so it can NEVER run off or loop!
    if (this.finishedMode) {
      this.crouching = false;
      this.crouchAmount *= Math.max(0, 1 - dt * 8);
      this.activeGroundPump = 0;
      if (this.grounded) {
        // Gentle celebratory braking right inside the Valley Finish Meadow
        this.velocity.multiplyScalar(Math.max(0, 1 - dt * 2.8));
        if (this.velocity.lengthSq() < 0.08) this.velocity.set(0, 0, 0);
      } else {
        this.velocity.y -= 28 * dt;
      }
      this.position.addScaledVector(this.velocity, dt);
      this.resolveCollisions(this.grounded);
      this.up.lerp(this.grounded ? this.groundNormal : WORLD_UP, Math.min(1, dt * 10)).normalize();
      this.forward.projectOnPlane(this.up);
      if (this.forward.lengthSq() > 0.001) this.forward.normalize();
      if (this.grounded) {
        this.gaitPhase += this.velocity.length() * 0.52 * dt;
      }
      return;
    }

    if (input.jumpJustPressed) {
      this.jumpBufferTimer = 0.14;
    } else {
      this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - dt);
    }

    this.crouching = input.crouchHeld;
    if (this.crouching) {
      this.recentCrouchTimer = 0.12;
    } else {
      this.recentCrouchTimer = Math.max(0, this.recentCrouchTimer - dt);
    }
    const targetCrouch = this.crouching ? 1 : 0;
    this.crouchAmount += (targetCrouch - this.crouchAmount) * Math.min(1, dt * 16);

    if (this.crouching && this.grounded) {
      this.jumpCharge = Math.min(1, this.jumpCharge + dt * 2.4);
    } else {
      this.jumpCharge = Math.max(0, this.jumpCharge - dt * 2.8);
    }

    const surfCfg = getSurfaceConfig(this.surface);
    const speed = this.velocity.length();
    const speedFactor = THREE.MathUtils.clamp(speed / 36, 0, 1);

    // Horizon-stabilized steering axis (80% WORLD_UP + 20% groundNormal)
    // -> Prevents disorienting sideways yaw flips when climbing/traversing steep rock!
    const turnRate =
      THREE.MathUtils.lerp(3.1, 1.55, speedFactor) *
      (this.grounded ? THREE.MathUtils.lerp(0.76, 1.15, surfCfg.lateralGrip) : 0.72);

    this.steerAngle += (input.steer - this.steerAngle) * Math.min(1, dt * 14);

    if (Math.abs(input.steer) > 0.01) {
      this._yawAxis
        .copy(WORLD_UP)
        .multiplyScalar(0.8)
        .addScaledVector(this.grounded ? this.groundNormal : WORLD_UP, 0.2)
        .normalize();
      this.forward.applyAxisAngle(this._yawAxis, -input.steer * turnRate * dt).normalize();
    }

    // Gentle drift heading alignment on slippery scree/snow
    if (this.grounded && speed > 5.0) {
      this._tmpA.copy(this.velocity).projectOnPlane(this.groundNormal);
      if (this._tmpA.lengthSq() > 1.0) {
        this._tmpA.normalize();
        const alignRate = surfCfg.lateralGrip < 0.6 ? 1.7 : 3.6;
        if (this._tmpA.dot(this.forward) > 0.3) {
          this.forward.lerp(this._tmpA, Math.min(1, dt * alignRate * 0.4)).normalize();
        }
      }
    }

    if (this.grounded) {
      this._slopeForward.copy(this.forward).projectOnPlane(this.groundNormal);
      if (this._slopeForward.lengthSq() > 0.0001) {
        this._slopeForward.normalize();
      } else {
        this._slopeForward.copy(this.forward);
      }
      this._right.crossVectors(this._slopeForward, this.groundNormal).normalize();

      // Determine if the goat is climbing UPHILL vs plunging DOWNHILL
      const forwardPitch = this._slopeForward.y; // > 0 uphill, < 0 downhill
      const isSteep = this.slopeDeg > 24;

      // Gravity along slope
      const gravity = 30.0;
      this._gravSlope.set(0, -gravity, 0).projectOnPlane(this.groundNormal);

      // ACTIVE GROUND SLOPE-PUMPING vs GOAT CLIMBING TRACTION:
      // Holding SHIFT while plunging down any steep face (>= 15°) compresses into the slope,
      // multiplying gravity pull (Tiny Wings / Steep half-pipe feel!) for an unmistakable surge!
      const isDownhillPumpFace = forwardPitch < -0.14 && this.slopeDeg >= 15;
      this.pumpReady = isDownhillPumpFace && !this.crouching;

      let gravScale = surfCfg.downhillSlideBoost;
      if (isDownhillPumpFace && this.crouching) {
        gravScale *= 1.98;
        this.activeGroundPump = Math.min(1, this.activeGroundPump + dt * 5.0);
        // Subtle extra downhill slingshot thrust while tucked on steep faces!
        this.velocity.addScaledVector(this._slopeForward, 7.5 * dt);
      } else {
        this.activeGroundPump = Math.max(0, this.activeGroundPump - dt * 4.5);
        if (
          (this.surface === SurfaceType.Granite || this.surface === SurfaceType.Turf) &&
          isSteep
        ) {
          const climbingEffort = Math.max(0, input.throttle) * 0.65 + (this.crouching ? 0.45 : 0);
          if (forwardPitch >= -0.08) {
            gravScale *= Math.max(0.18, 1.0 - climbingEffort * 0.82);
          }
        }
      }

      this.velocity.addScaledVector(this._gravSlope, gravScale * dt);

      // Active hoof propulsion (sprint / climb / brake)
      const maxSprintSpeed = this.crouching ? 31.0 : 27.5;
      const forwardSpeed = this.velocity.dot(this._slopeForward);

      if (input.throttle > 0.01) {
        const sprintHeadroom = Math.max(0.22, 1 - Math.max(0, forwardSpeed) / maxSprintSpeed);
        // Extra climbing torque when scrambling up steep rock faces!
        const climbBonus = forwardPitch > 0.15 ? 1.38 : 1.0;
        const accel = 30.0 * surfCfg.accelMul * climbBonus * (0.35 + 0.65 * sprintHeadroom);
        this.velocity.addScaledVector(this._slopeForward, input.throttle * accel * dt);
      } else if (input.throttle < -0.01) {
        const brake = 34.0 * (0.6 + 0.4 * surfCfg.lateralGrip);
        this.velocity.addScaledVector(this._slopeForward, input.throttle * brake * dt);
        if (forwardSpeed > 0 && this.velocity.dot(this._slopeForward) < 0) {
          this.velocity.addScaledVector(this._slopeForward, -this.velocity.dot(this._slopeForward));
        }
      }

      // Lateral split-hoof grip (boosted on steep rock so traversing walls feels planted!)
      const lateralSpeed = this.velocity.dot(this._right);
      const steepSideGripBonus = isSteep && this.surface === SurfaceType.Granite ? 1.45 : 1.0;
      const gripStrength = (this.crouching ? 13.0 : 8.8) * surfCfg.lateralGrip * steepSideGripBonus;
      const lateralDamp = Math.min(1, gripStrength * dt);
      this.velocity.addScaledVector(this._right, -lateralSpeed * lateralDamp);

      // Aero + rolling hoof drag
      const dragCoeff = surfCfg.drag * (this.crouching ? 0.55 : 1.0);
      const aeroDrag = 0.0038 * speed * (this.crouching ? 0.58 : 1.0);
      this.velocity.multiplyScalar(Math.max(0, 1 - (dragCoeff + aeroDrag) * dt));

      // Gentle normal adhesion while crouching on steep slopes
      const stickForce = this.crouching ? 18.0 : 9.0;
      this.velocity.addScaledVector(this.groundNormal, -stickForce * dt);
    } else if (this.wallRunning) {
      // DEDICATED WALL-RUN STATE (> 72° sheer limestone wall while moving fast!)
      // Reduced gravity + clean forward glide along the wall tangent + ready for Wall-Kick!
      this.velocity.y -= 13.5 * dt; // half gravity while hooves claw along the sheer wall!
      if (this.velocity.y < -6.5) this.velocity.y = -6.5;

      // Project forward along the wall
      this._tmpA.copy(this.forward).projectOnPlane(this.wallNormal).normalize();
      if (input.throttle > 0.01) {
        this.velocity.addScaledVector(this._tmpA, 14.0 * dt);
      }
      // Gently hug wall so you glide cleanly along it
      this.velocity.addScaledVector(this.wallNormal, -6.0 * dt);
      this.airTime = Math.min(this.airTime, 0.25);
    } else {
      // AIRBORNE: crisp alpine gravity (hold SHIFT to Aerial Tuck / Fast-Dive!)
      this.activeGroundPump = Math.max(0, this.activeGroundPump - dt * 5.0);
      this.pumpReady = this.airTime > 0.16 && this.velocity.y < 1.5 && !this.crouching;
      const airGravity = this.crouching ? 52.0 : 31.5;
      this.velocity.y -= airGravity * dt;
      this.airTime += dt;

      // Crisp air steering & pitch control
      this._tmpA.copy(this.forward).setY(0);
      if (this._tmpA.lengthSq() > 0.001) {
        this._tmpA.normalize();
        this.velocity.addScaledVector(this._tmpA, input.throttle * 6.5 * dt);
      }
      this.velocity.multiplyScalar(Math.max(0, 1 - 0.04 * dt));
    }

    // Coyote windows for ledges & wall-kicks
    if (this.grounded) {
      this.coyoteTimer = 0.13;
    } else {
      this.coyoteTimer = Math.max(0, this.coyoteTimer - dt);
    }
    if (this.wallRunning) {
      this.wallCoyoteTimer = 0.16;
    } else {
      this.wallCoyoteTimer = Math.max(0, this.wallCoyoteTimer - dt);
    }

    // Execute Athletic Goat Jump OR Repeatable Steep-Cliff Wall-Kick!
    if (this.jumpBufferTimer > 0 && (this.coyoteTimer > 0 || this.wallCoyoteTimer > 0)) {
      const steepWallKick =
        this.grounded && this.slopeDeg >= 40 && this.velocity.length() >= 6.0;
      const isWallKick = (!this.grounded && this.wallCoyoteTimer > 0) || steepWallKick;
      const chargeBonus = 1.0 + this.jumpCharge * 0.22;

      if (isWallKick) {
        // Wall-Kick: agile push UP + AWAY from the steep rock wall + forward speed boost!
        const kickNormal = steepWallKick ? this.groundNormal : this.wallNormal;
        this._tmpA
          .copy(WORLD_UP)
          .multiplyScalar(0.68)
          .addScaledVector(kickNormal, 0.38)
          .normalize();
        const vn = this.velocity.dot(this._tmpA);
        if (vn < 0) {
          this.velocity.addScaledVector(this._tmpA, -vn);
        }
        if (this.velocity.y > 4.5) {
          this.velocity.y = 4.5;
        }
        this.velocity.addScaledVector(this._tmpA, 10.6 * chargeBonus);
        this.velocity.addScaledVector(this.forward, 3.8);
        this.wallRunning = false;
        this.wallCoyoteTimer = 0;
        this.coyoteTimer = 0;
      } else {
        // Grounded athletic mountain-goat leap (~1.55m regular, ~2.3m crouched charge)
        const jumpPower = 9.8 * surfCfg.jumpMul * chargeBonus;
        this._tmpA
          .copy(WORLD_UP)
          .multiplyScalar(0.78)
          .addScaledVector(this.groundNormal, 0.22)
          .normalize();

        const vn = this.velocity.dot(this._tmpA);
        if (vn < 0) {
          this.velocity.addScaledVector(this._tmpA, -vn);
        }
        // Cap pre-existing upward hill momentum so jumping uphill doesn't double-launch to the moon!
        if (this.velocity.y > 4.5) {
          this.velocity.y = 4.5;
        }
        this.velocity.addScaledVector(this._tmpA, jumpPower);
        this.velocity.addScaledVector(this.forward, 1.8 * chargeBonus);
        this.coyoteTimer = 0;
      }

      const usedCharge = this.jumpCharge;
      this.grounded = false;
      this.jumpBufferTimer = 0;
      this.justJumpedTimer = 0.15;
      this.jumpCharge = 0;

      callbacks?.onJump?.({
        position: this.position.clone(),
        charge: usedCharge,
        surface: this.surface,
        wallKick: isWallKick,
      });
    }

    // Cap terminal velocity at 52 m/s (187 km/h!)
    const curSpd = this.velocity.length();
    if (curSpd > 52) {
      this.velocity.multiplyScalar(52 / curSpd);
    }

    this.position.addScaledVector(this.velocity, dt);

    const wasGrounded = this.grounded;
    const prevAirTime = this.airTime;
    // Dedicated vector (never aliased with _tmpA used inside resolveCollisions!)
    this._preImpactVel.copy(this.velocity);

    this.resolveCollisions(wasGrounded);

    // LANDING & JUICY SLOPE-PUMPING SURGE!
    if (!wasGrounded && this.grounded && prevAirTime > 0.1) {
      const impactNormalSpeed = Math.max(0, -this._preImpactVel.dot(this.groundNormal));
      const verticalFallSpeed = Math.max(0, -this._preImpactVel.y);
      const landSurf = getSurfaceConfig(this.surface);
      const pumpInputActive = this.crouching || this.recentCrouchTimer > 0;

      // Only bail out on extreme vertical splats onto flat ground without tucking
      if (impactNormalSpeed > 36 && !pumpInputActive && this.slopeDeg < 16) {
        this.triggerBailout(false);
        callbacks?.onLand?.({
          position: this.position.clone(),
          impactSpeed: impactNormalSpeed,
          surface: this.surface,
          pumped: false,
          pumpGainKmh: 0,
          bailed: true,
        });
      } else {
        const downhillDir = this._tmpB.set(0, -1, 0).projectOnPlane(this.groundNormal);
        this._slopeForward.copy(this.forward).projectOnPlane(this.groundNormal);
        if (this._slopeForward.lengthSq() > 0.001) {
          this._slopeForward.normalize();
        } else {
          this._slopeForward.copy(this.forward);
        }

        let pumped = false;
        let pumpGainKmh = 0;

        if (downhillDir.lengthSq() > 0.015) {
          downhillDir.normalize();
          // Trigger cleanly whenever landing onto a forward downhill slope (even on banked turns!)
          const goingDownhill = this._slopeForward.y < -0.1 || downhillDir.dot(this._slopeForward) > 0.15;
          if (goingDownhill && this.slopeDeg >= 8) {
            const slopeFactor = THREE.MathUtils.clamp(this.slopeDeg / 28, 0.55, 1.55);
            const energy = Math.max(verticalFallSpeed, impactNormalSpeed);
            const pumpEfficiency = pumpInputActive ? 0.92 : 0.34;
            const boost = Math.min(
              18.0,
              energy * pumpEfficiency * slopeFactor * landSurf.landingRetention,
            );
            // Aim boost 75% along player's slopeForward + 25% downhill so banked turns stay on-line!
            this._tmpA
              .copy(this._slopeForward)
              .multiplyScalar(0.75)
              .addScaledVector(downhillDir, 0.25)
              .normalize();
            this.velocity.addScaledVector(this._tmpA, boost);
            if (pumpInputActive && boost > 2.2) {
              pumped = true;
              pumpGainKmh = Math.round(boost * 3.6);
              this.lastPumpGainKmh = pumpGainKmh;
              this.pumpBoostFlash = 1.0;
            }
          }
        }

        callbacks?.onLand?.({
          position: this.position.clone(),
          impactSpeed: Math.max(impactNormalSpeed, verticalFallSpeed * 0.6),
          surface: this.surface,
          pumped,
          pumpGainKmh,
          bailed: false,
        });
      }
      this.airTime = 0;
    }

    // Visual UP vector: cleanly follows slope normal (clamped slightly for pleasant camera/rig feel)
    let targetUp = WORLD_UP;
    if (this.grounded) {
      targetUp = this.groundNormal;
    } else if (this.wallRunning) {
      targetUp = this._tmpA
        .copy(WORLD_UP)
        .multiplyScalar(0.55)
        .addScaledVector(this.wallNormal, 0.45)
        .normalize();
    }
    this.up.lerp(targetUp, Math.min(1, dt * (this.grounded ? 14 : 7))).normalize();

    // Keep forward orthogonal to up
    this.forward.projectOnPlane(this.up);
    if (this.forward.lengthSq() > 0.0001) {
      this.forward.normalize();
    } else {
      this.forward.set(0, 0, -1);
    }

    // Advance quadruped gait cycle
    if (this.grounded || this.wallRunning) {
      this.gaitPhase += (this.velocity.length() * 0.52 + 0.4) * dt;
    } else {
      this.gaitPhase += 1.5 * dt;
    }

    // Periodic checks: cliff exposure audio + FAST OUT-OF-BOUNDS FALL CHECK!
    this.exposureTick++;
    if (this.exposureTick % 6 === 0) {
      this.updateCliffExposure();
      const { sample, horizDistSq } = this.course.findNearestSample(this.position);
      const dropBelowTrack = sample.position.y - this.position.y;
      const farOffTrack = horizDistSq > (sample.width * 2.2 + 28) ** 2;
      // Trigger snappy out-of-bounds respawn as soon as you plummet > 22m below the cliff line!
      if (dropBelowTrack > 22 || (dropBelowTrack > 14 && farOffTrack)) {
        this.triggerBailout(true);
        callbacks?.onOutOfBounds?.();
      }
    }
  }

  private resolveCollisions(wasGrounded: boolean): void {
    const bvh = this.course.bvh;
    const r = this.bodyRadius;
    const halfH = this.capsuleHalfHeight;
    const sphereOffsetsY = [-halfH, halfH];

    // Separate climbable floor contacts (<= 72°, ny >= 0.30) from vertical wall contacts (ny < 0.30)
    // so touching a sheer cliff wall NEVER corrupts your floor normal!
    let foundGround = false;
    let bestGroundDot = -1;
    let bestSurface: SurfaceType = this.surface;
    const floorNormalSum = new THREE.Vector3();

    let foundWall = false;
    const wallNormalSum = new THREE.Vector3();
    let firstContactNormal: THREE.Vector3 | null = null;
    let pinchedInCrevice = false;

    for (let iter = 0; iter < 2; iter++) {
      for (const oy of sphereOffsetsY) {
        const cx = this.position.x;
        const cy = this.position.y + oy;
        const cz = this.position.z;

        this._box.min.set(cx - r, cy - r, cz - r);
        this._box.max.set(cx + r, cy + r, cz + r);

        bvh.shapecast({
          intersectsBounds: (box) => box.intersectsBox(this._box),
          intersectsTriangle: (tri, faceIndex) => {
            tri.closestPointToPoint(this._tmpA.set(cx, cy, cz), this._triClosest);
            this._delta.set(cx, cy, cz).sub(this._triClosest);
            const distSq = this._delta.lengthSq();

            if (distSq < r * r && distSq > 1e-10) {
              const dist = Math.sqrt(distSq);
              const pen = r - dist;
              this._normal.copy(this._delta).divideScalar(dist);

              tri.getNormal(this._tmpB);
              if (this._normal.dot(this._tmpB) < 0) {
                this._normal.copy(this._tmpB);
              }

              // Detect opposing rock walls (tight V-crack pinch) so the goat can never get wedged!
              if (!firstContactNormal) {
                firstContactNormal = this._normal.clone();
              } else if (firstContactNormal.dot(this._normal) < -0.3) {
                pinchedInCrevice = true;
              }

              this.position.addScaledVector(this._normal, pen);

              if (this._normal.y < 0.3) {
                // Steep wall or slight jagged rock overhang:
                // Project velocity ONLY against the horizontal wall plane (ny = 0) so climbing
                // upward into an overhang facet NEVER punches you sideways off the cliff!
                const hLen = Math.hypot(this._normal.x, this._normal.z);
                if (hLen > 0.01) {
                  const nx = this._normal.x / hLen;
                  const nz = this._normal.z / hLen;
                  const vnH = this.velocity.x * nx + this.velocity.z * nz;
                  if (vnH < 0) {
                    this.velocity.x -= nx * vnH;
                    this.velocity.z -= nz * vnH;
                  }
                }
                if (this._normal.y < -0.15 && this.velocity.y > 0) {
                  this.velocity.y *= 0.65;
                }
              } else if (this._normal.y < 0.78) {
                // Diagonal transition ramp between road & cliff (38°–72°):
                // Absorb sideways slam cleanly along the ramp instead of catapulting the goat UP & OUT!
                const vn = this.velocity.dot(this._normal);
                if (vn < 0) {
                  this.velocity.addScaledVector(this._normal, -vn);
                  // Cap sudden upward/outward wedge kick from hitting the diagonal bank at speed
                  if (this.justJumpedTimer <= 0 && -vn > 3.5 && this.velocity.y > 3.0) {
                    this.velocity.y = Math.min(this.velocity.y, 3.0);
                  }
                }
              } else {
                const vn = this.velocity.dot(this._normal);
                if (vn < 0) {
                  this.velocity.addScaledVector(this._normal, -vn);
                }
              }

              if (this._normal.y >= 0.3 && this.justJumpedTimer <= 0) {
                foundGround = true;
                floorNormalSum.add(this._normal);
                if (this._normal.y > bestGroundDot) {
                  bestGroundDot = this._normal.y;
                  bestSurface = this.course.getSurfaceForFace(faceIndex);
                }
              } else if (this._normal.y > -0.15 && this._normal.y < 0.3) {
                foundWall = true;
                wallNormalSum.add(this._normal);
              }
            }
            return false;
          },
        });
      }
    }

    // Crevice Escape Valve: if wedged between opposing rock faces, pop cleanly out toward track center!
    if (pinchedInCrevice) {
      const { sample } = this.course.findNearestSample(this.position);
      this._tmpA.subVectors(sample.position, this.position);
      this._tmpA.y = 0;
      if (this._tmpA.lengthSq() > 0.01) {
        this._tmpA.normalize();
        this.position.addScaledVector(this._tmpA, 0.25);
        this.position.y += 0.14;
      }
    }

    // Evaluate wall-running state (only when airborne against a sheer cliff with forward speed!)
    if (foundWall && wallNormalSum.lengthSq() > 0.001) {
      this.wallNormal.copy(wallNormalSum).normalize();
      const horizSpeed = Math.hypot(this.velocity.x, this.velocity.z);
      if (!foundGround && horizSpeed > 8.5 && this.justJumpedTimer <= 0) {
        this.wallRunning = true;
        this._right.crossVectors(this.forward, WORLD_UP).normalize();
        this.wallSide = this.wallNormal.dot(this._right) > 0 ? -1 : 1;
      } else {
        this.wallRunning = false;
        this.wallSide = 0;
      }
    } else {
      this.wallRunning = false;
      this.wallSide = 0;
    }

    if (foundGround && floorNormalSum.lengthSq() > 0.0001) {
      this.grounded = true;
      this.groundNormal.copy(floorNormalSum).normalize();
      this.surface = bestSurface;
      this.slopeDeg = THREE.MathUtils.radToDeg(
        Math.acos(THREE.MathUtils.clamp(this.groundNormal.y, -1, 1)),
      );
      // Keep grounded velocity smoothly tangent to slopes (no catapulting off diagonal ramps!)
      if (wasGrounded && this.justJumpedTimer <= 0) {
        const vn = this.velocity.dot(this.groundNormal);
        if (this.groundNormal.y >= 0.64 && vn > 0 && vn < 15.0) {
          const speedBefore = this.velocity.length();
          this.velocity.addScaledVector(this.groundNormal, -vn);
          const newLen = this.velocity.length();
          if (newLen > 0.2) {
            this.velocity.multiplyScalar(speedBefore / newLen);
          }
        } else if (this.groundNormal.y < 0.64 && vn > 0 && vn < 10.0) {
          // On steep diagonal banks (38°-72°): cleanly cancel outward kick without twisting sideways!
          this.velocity.addScaledVector(this.groundNormal, -vn * 0.85);
        }
      }
      return;
    }

    // Slope-Aligned Contour Adhesion Probe:
    // Keeps hooves firmly glued over hills & roller crests while preserving full speed!
    // You only detach when you deliberately press Space, hit a true sheer drop (Chasm Leap),
    // or blast off an extreme sharp lip (> 16 m/s normal lift) while upright.
    if (wasGrounded && this.justJumpedTimer <= 0) {
      const probeDir = this._rayDir
        .copy(this.groundNormal)
        .multiplyScalar(-0.55)
        .addScaledVector(WORLD_UP, -0.45)
        .normalize();

      const feetOffset = halfH + r;
      this._rayOrigin.copy(this.position).addScaledVector(probeDir, feetOffset - 0.35);
      this._ray.set(this._rayOrigin, probeDir);

      const hit = bvh.raycastFirst(this._ray, THREE.FrontSide);
      const snapReach = this.crouching ? 1.85 : 1.55;
      if (hit && hit.distance <= 0.35 + snapReach && hit.face) {
        const n = hit.face.normal;
        const liftOut = this.velocity.dot(n);
        const maxCrestHold = this.crouching ? 24.0 : 16.5;

        if (n.y >= 0.3 && n.dot(this.groundNormal) > 0.48 && liftOut < maxCrestHold) {
          this.position.copy(hit.point).addScaledVector(probeDir, -(feetOffset - 0.02));
          // Bend velocity smoothly onto the new slope plane while preserving momentum!
          const speedBefore = this.velocity.length();
          this.velocity.addScaledVector(n, -liftOut);
          const newLen = this.velocity.length();
          if (newLen > 0.2) {
            this.velocity.multiplyScalar(speedBefore / newLen);
          }
          this.grounded = true;
          this.groundNormal.copy(n).normalize();
          this.surface = this.course.getSurfaceForFace(hit.faceIndex ?? -1);
          this.slopeDeg = THREE.MathUtils.radToDeg(
            Math.acos(THREE.MathUtils.clamp(this.groundNormal.y, -1, 1)),
          );
          return;
        }
      }
    }

    this.grounded = false;
  }

  private updateCliffExposure(): void {
    this._right.crossVectors(this.forward, WORLD_UP).normalize();
    let maxDrop = 0;

    for (const side of [-1, 1]) {
      this._rayOrigin.copy(this.position).addScaledVector(this._right, side * 5.2);
      this._rayOrigin.y += 1.0;
      this._rayDir.set(0, -1, 0);
      this._ray.set(this._rayOrigin, this._rayDir);
      const hit = this.course.bvh.raycastFirst(this._ray, THREE.FrontSide);
      const drop = hit ? hit.distance : 180;
      if (drop > maxDrop) maxDrop = drop;
    }

    this.exposureHeight = THREE.MathUtils.clamp(maxDrop, 0, 180);
  }

  private triggerBailout(isOutOfBounds: boolean): void {
    this.bailedOut = true;
    this.outOfBounds = isOutOfBounds;
    this.bailTimer = 0;
    this.grounded = false;
    this.wallRunning = false;
    if (!isOutOfBounds) {
      this.velocity.y = Math.max(this.velocity.y, 4.0);
    }
  }

  private stepBailout(dt: number): void {
    this.bailTimer += dt;
    if (this.outOfBounds) {
      // Gentle slow-mo drift during brief 0.55s reset flash (no ugly tumbling down 400m!)
      this.velocity.multiplyScalar(Math.max(0, 1 - 3.5 * dt));
      this.position.addScaledVector(this.velocity, dt * 0.35);
      return;
    }
    this.velocity.y -= 26 * dt;
    this.velocity.multiplyScalar(Math.max(0, 1 - 1.2 * dt));
    this.position.addScaledVector(this.velocity, dt);
    this.resolveCollisions(false);
    this.up.applyAxisAngle(this.forward, dt * 5.5).normalize();
  }

  public getInterpolatedSnapshot(alpha: number, out: GoatPhysicsSnapshot): void {
    out.position.lerpVectors(this.prevPosition, this.position, alpha);
    out.velocity.copy(this.velocity);
    out.forward.lerpVectors(this.prevForward, this.forward, alpha).normalize();
    out.up.lerpVectors(this.prevUp, this.up, alpha).normalize();
    out.speed = this.velocity.length();
    out.grounded = this.grounded;
    out.crouching = this.crouching;
    out.crouchAmount = this.crouchAmount;
    out.jumpCharge = this.jumpCharge;
    out.pumpBoostFlash = Math.max(this.pumpBoostFlash, this.activeGroundPump * 0.55);
    out.pumpingNow = this.activeGroundPump > 0.1;
    out.pumpReady = this.pumpReady;
    out.lastPumpGainKmh = this.lastPumpGainKmh;
    out.slopeDeg = this.slopeDeg;
    out.surface = this.surface;
    out.groundNormal.copy(this.groundNormal);
    out.wallRunning = this.wallRunning;
    out.wallNormal.copy(this.wallNormal);
    out.wallSide = this.wallSide;
    out.steerAngle = this.steerAngle;
    out.bailedOut = this.bailedOut;
    out.outOfBounds = this.outOfBounds;
    out.bailTimer = this.bailTimer;
    out.airTime = this.airTime;
    out.gaitPhase = this.gaitPhase;
    out.exposureHeight = this.exposureHeight;
  }
}
