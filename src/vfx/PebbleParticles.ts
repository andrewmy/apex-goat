import * as THREE from 'three';
import { SurfaceType } from '../types';
import { getSurfaceConfig } from '../physics/SurfaceMaterials';

interface Particle {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  rotVel: THREE.Vector3;
  scale: number;
  age: number;
  life: number;
  color: THREE.Color;
}

/**
 * Instanced scree/rock-chip & snow spray particles kicked up by the player's hooves
 * and by the wild mountain goat herd racing right ahead of the GoPro!
 */
export class PebbleParticles {
  private readonly maxParticles = 320;
  private readonly particles: Particle[] = [];
  private readonly mesh: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();
  private cursor = 0;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.DodecahedronGeometry(0.11, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      flatShading: true,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.maxParticles);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;

    const zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);
    const defaultCol = new THREE.Color(0x9a958c);

    for (let i = 0; i < this.maxParticles; i++) {
      this.particles.push({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        rot: new THREE.Euler(),
        rotVel: new THREE.Vector3(),
        scale: 1,
        age: 0,
        life: 1,
        color: defaultCol.clone(),
      });
      this.mesh.setMatrixAt(i, zeroMat);
      this.mesh.setColorAt(i, defaultCol);
    }

    scene.add(this.mesh);
  }

  public emitBurst(
    origin: THREE.Vector3,
    velocityBias: THREE.Vector3,
    surface: SurfaceType,
    count: number,
  ): void {
    const cfg = getSurfaceConfig(surface);
    const baseColor = new THREE.Color(cfg.particleColor);

    for (let i = 0; i < count; i++) {
      const p = this.particles[this.cursor];
      this.cursor = (this.cursor + 1) % this.maxParticles;

      p.active = true;
      p.age = 0;
      p.life = 0.45 + Math.random() * 0.55;
      p.scale = 0.5 + Math.random() * 1.15;
      p.pos.set(
        origin.x + (Math.random() - 0.5) * 0.35,
        origin.y + Math.random() * 0.2,
        origin.z + (Math.random() - 0.5) * 0.35,
      );
      p.vel.set(
        velocityBias.x * 0.35 + (Math.random() - 0.5) * 5.2,
        1.8 + Math.random() * 4.4,
        velocityBias.z * 0.35 + (Math.random() - 0.5) * 5.2,
      );
      p.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      p.rotVel.set(
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14,
      );
      p.color.copy(baseColor).offsetHSL(0, 0, (Math.random() - 0.5) * 0.14);
      this.mesh.setColorAt(this.cursor === 0 ? this.maxParticles - 1 : this.cursor - 1, p.color);
    }
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
    }
  }

  public update(dt: number): void {
    let anyChanged = false;
    for (let i = 0; i < this.maxParticles; i++) {
      const p = this.particles[i];
      if (!p.active) continue;

      anyChanged = true;
      p.age += dt;
      if (p.age >= p.life) {
        p.active = false;
        this.dummy.scale.set(0, 0, 0);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
        continue;
      }

      p.vel.y -= 22.0 * dt;
      p.pos.addScaledVector(p.vel, dt);
      p.rot.x += p.rotVel.x * dt;
      p.rot.y += p.rotVel.y * dt;
      p.rot.z += p.rotVel.z * dt;

      const fade = 1 - p.age / p.life;
      const s = p.scale * (0.25 + 0.75 * fade);
      this.dummy.position.copy(p.pos);
      this.dummy.rotation.copy(p.rot);
      this.dummy.scale.set(s, s, s);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }

    if (anyChanged) {
      this.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
