import * as THREE from 'three';

export interface LegJoints {
  hip: THREE.Group; // mounted on torso
  upper: THREE.Group;
  lower: THREE.Group;
  hoof: THREE.Mesh;
  upperLen: number;
  lowerLen: number;
  hipLocalOffset: THREE.Vector3;
  isFront: boolean;
  isLeft: boolean;
}

/**
 * Stylized, anatomically evocative Mountain Goat rig with:
 * - Shaggy alpine coat & muscular front shoulder hump
 * - Curved black horns & expressive wind-reactive ears (the foreground stars of GoPro POV!)
 * - Miniature black GoPro Hero camera + harness strap on the withers
 * - Four articulated 2-bone legs with split cloven hooves ready for real-time BVH IK
 */
export class GoatRig {
  public readonly root = new THREE.Group();
  public readonly bodyPivot = new THREE.Group();
  public readonly neckPivot = new THREE.Group();
  public readonly headPivot = new THREE.Group();
  public readonly leftEar = new THREE.Group();
  public readonly rightEar = new THREE.Group();
  public readonly tailPivot = new THREE.Group();
  public readonly goproMount = new THREE.Group();
  public readonly legs: LegJoints[] = [];

  private readonly coatMat: THREE.MeshStandardMaterial;
  private readonly darkMat: THREE.MeshStandardMaterial;

  constructor(options?: {
    coatColor?: number;
    accentColor?: number;
    opacity?: number;
    isGhost?: boolean;
  }) {
    const coatHex = options?.coatColor ?? 0xf0ece2;
    const accentHex = options?.accentColor ?? 0xded5c5;
    const opacity = options?.opacity ?? 1.0;
    const transparent = opacity < 0.99;

    this.coatMat = new THREE.MeshStandardMaterial({
      color: coatHex,
      roughness: 0.9,
      metalness: 0.02,
      flatShading: true,
      transparent,
      opacity,
    });

    const woolAccentMat = new THREE.MeshStandardMaterial({
      color: accentHex,
      roughness: 0.94,
      flatShading: true,
      transparent,
      opacity,
    });

    this.darkMat = new THREE.MeshStandardMaterial({
      color: 0x1d2026,
      roughness: 0.45,
      metalness: 0.15,
      flatShading: true,
      transparent,
      opacity,
    });

    const strapMat = new THREE.MeshStandardMaterial({
      color: 0x15181e,
      roughness: 0.75,
      transparent,
      opacity,
    });

    const eyeMat = new THREE.MeshStandardMaterial({
      color: 0x111111,
      roughness: 0.1,
      transparent,
      opacity,
    });

    // Root -> bodyPivot (lifted to standing torso height ~0.88m above hooves)
    this.bodyPivot.position.set(0, 0.88, 0);
    this.root.add(this.bodyPivot);

    // Note: Local forward is -Z (Three.js convention)
    // Torso barrel
    const torsoGeo = new THREE.BoxGeometry(0.46, 0.46, 1.02);
    const torso = new THREE.Mesh(torsoGeo, this.coatMat);
    torso.castShadow = !options?.isGhost;
    torso.receiveShadow = true;
    this.bodyPivot.add(torso);

    // Iconic mountain goat shaggy shoulder hump & chest fluff
    const hump = new THREE.Mesh(new THREE.DodecahedronGeometry(0.32, 0), this.coatMat);
    hump.scale.set(0.88, 0.95, 1.05);
    hump.position.set(0, 0.14, -0.32);
    hump.castShadow = !options?.isGhost;
    this.bodyPivot.add(hump);

    // Shaggy hindquarters wool
    const rump = new THREE.Mesh(new THREE.DodecahedronGeometry(0.29, 0), woolAccentMat);
    rump.scale.set(0.85, 0.9, 1.05);
    rump.position.set(0, 0.04, 0.36);
    rump.castShadow = !options?.isGhost;
    this.bodyPivot.add(rump);

    // Stubby mountain goat tail
    this.tailPivot.position.set(0, 0.16, 0.56);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.24, 5), this.coatMat);
    tail.rotation.x = 0.7;
    tail.position.set(0, 0.04, 0.08);
    this.tailPivot.add(tail);
    this.bodyPivot.add(this.tailPivot);

    // GoPro Harness Strap + Camera Box mounted on the upper back!
    const harnessBand = new THREE.Mesh(new THREE.BoxGeometry(0.51, 0.51, 0.08), strapMat);
    harnessBand.position.set(0, 0.05, -0.22);
    this.bodyPivot.add(harnessBand);

    this.goproMount.position.set(0, 0.39, -0.22);
    this.bodyPivot.add(this.goproMount);

    const goproBody = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.08, 0.07), this.darkMat);
    goproBody.position.set(0, 0.03, 0);
    this.goproMount.add(goproBody);

    const goproLens = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.03, 8), eyeMat);
    goproLens.rotation.x = Math.PI / 2;
    goproLens.position.set(-0.025, 0.03, -0.04);
    this.goproMount.add(goproLens);

    // Neck (extends forward-up from shoulders)
    this.neckPivot.position.set(0, 0.16, -0.45);
    this.bodyPivot.add(this.neckPivot);

    const neckMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.22, 0.48, 6), this.coatMat);
    neckMesh.rotation.x = -0.58;
    neckMesh.position.set(0, 0.15, -0.14);
    neckMesh.castShadow = !options?.isGhost;
    this.neckPivot.add(neckMesh);

    // Shaggy throat ruff
    const ruff = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.34, 5), woolAccentMat);
    ruff.rotation.x = Math.PI - 0.3;
    ruff.position.set(0, -0.02, -0.14);
    this.neckPivot.add(ruff);

    // Head Pivot (stabilized independently by QuadrupedIK!)
    this.headPivot.position.set(0, 0.34, -0.28);
    this.neckPivot.add(this.headPivot);

    // Cranium + tapered mountain goat muzzle
    const skull = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.21, 0.26), this.coatMat);
    skull.castShadow = !options?.isGhost;
    this.headPivot.add(skull);

    const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.24), woolAccentMat);
    muzzle.position.set(0, -0.05, -0.2);
    muzzle.rotation.x = 0.22;
    this.headPivot.add(muzzle);

    // Black nose tip
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.07, 0.06), this.darkMat);
    nose.position.set(0, -0.05, -0.32);
    this.headPivot.add(nose);

    // Classic goat beard!
    const beard = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.22, 5), this.coatMat);
    beard.rotation.x = Math.PI + 0.15;
    beard.position.set(0, -0.18, -0.2);
    this.headPivot.add(beard);

    // Eyes
    const eyeGeo = new THREE.SphereGeometry(0.026, 6, 6);
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(side * 0.11, 0.02, -0.06);
      this.headPivot.add(eye);
    }

    // Iconic Swept-Back Curved Black Horns (signature silhouette in GoPro POV!)
    for (const side of [-1, 1]) {
      const hornGroup = new THREE.Group();
      hornGroup.position.set(side * 0.065, 0.1, 0.02);
      hornGroup.rotation.z = -side * 0.22;
      hornGroup.rotation.x = -0.35;

      const seg1 = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.036, 0.18, 6), this.darkMat);
      seg1.position.set(0, 0.09, 0);
      hornGroup.add(seg1);

      const seg2 = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.024, 0.17, 6), this.darkMat);
      seg2.position.set(side * 0.03, 0.23, 0.06);
      seg2.rotation.x = -0.45;
      seg2.rotation.z = -side * 0.18;
      hornGroup.add(seg2);

      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.12, 5), this.darkMat);
      tip.position.set(side * 0.06, 0.34, 0.14);
      tip.rotation.x = -0.72;
      tip.rotation.z = -side * 0.24;
      hornGroup.add(tip);

      this.headPivot.add(hornGroup);
    }

    // Expressive pointed ears (visible in GoPro POV, pin back with wind speed!)
    const earGeo = new THREE.ConeGeometry(0.045, 0.18, 4);
    earGeo.rotateZ(-Math.PI / 2);

    this.leftEar.position.set(-0.11, 0.06, 0.04);
    const lEarMesh = new THREE.Mesh(earGeo, this.coatMat);
    lEarMesh.scale.set(-1, 0.65, 0.65);
    lEarMesh.position.set(-0.08, 0, 0);
    this.leftEar.add(lEarMesh);
    this.headPivot.add(this.leftEar);

    this.rightEar.position.set(0.11, 0.06, 0.04);
    const rEarMesh = new THREE.Mesh(earGeo, this.coatMat);
    rEarMesh.scale.set(1, 0.65, 0.65);
    rEarMesh.position.set(0.08, 0, 0);
    this.rightEar.add(rEarMesh);
    this.headPivot.add(this.rightEar);

    // 4 Articulated 2-Bone Legs (FL, FR, BL, BR)
    const legSpecs: Array<{
      x: number;
      y: number;
      z: number;
      isFront: boolean;
      isLeft: boolean;
    }> = [
      { x: -0.2, y: -0.14, z: -0.34, isFront: true, isLeft: true },
      { x: 0.2, y: -0.14, z: -0.34, isFront: true, isLeft: false },
      { x: -0.2, y: -0.12, z: 0.36, isFront: false, isLeft: true },
      { x: 0.2, y: -0.12, z: 0.36, isFront: false, isLeft: false },
    ];

    const upperLen = 0.42;
    const lowerLen = 0.42;

    for (const spec of legSpecs) {
      const hip = new THREE.Group();
      hip.position.set(spec.x, spec.y, spec.z);
      this.bodyPivot.add(hip);

      const upper = new THREE.Group();
      hip.add(upper);

      // Shaggy upper leg "pantaloon" (mountain goats have fuzzy upper legs!)
      const upperMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.072, 0.095, upperLen, 6),
        this.coatMat,
      );
      upperMesh.position.set(0, -upperLen * 0.5, 0);
      upperMesh.castShadow = !options?.isGhost;
      upper.add(upperMesh);

      const lower = new THREE.Group();
      lower.position.set(0, -upperLen, 0);
      upper.add(lower);

      const lowerMesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.048, 0.058, lowerLen, 6),
        woolAccentMat,
      );
      lowerMesh.position.set(0, -lowerLen * 0.5, 0);
      lowerMesh.castShadow = !options?.isGhost;
      lower.add(lowerMesh);

      // Split cloven black hoof
      const hoof = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.08, 0.12), this.darkMat);
      hoof.position.set(0, -lowerLen, -0.02);
      lower.add(hoof);

      this.legs.push({
        hip,
        upper,
        lower,
        hoof,
        upperLen,
        lowerLen,
        hipLocalOffset: new THREE.Vector3(spec.x, spec.y, spec.z),
        isFront: spec.isFront,
        isLeft: spec.isLeft,
      });
    }
  }

  /** Hide rear body / GoPro mesh slightly if needed during GoPro POV to avoid clipping */
  public setFirstPersonMode(isFirstPerson: boolean): void {
    this.goproMount.visible = !isFirstPerson;
  }
}
