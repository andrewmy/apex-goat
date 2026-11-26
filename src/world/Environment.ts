import * as THREE from 'three';

/** Deterministic hash noise for alpine peaks & valley details */
function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function valueNoise2(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

function fbm2(x: number, z: number): number {
  let v = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < 4; i++) {
    v += amp * valueNoise2(x * freq, z * freq);
    freq *= 2.07;
    amp *= 0.5;
  }
  return v;
}

export class AlpineEnvironment {
  public sunLight: THREE.DirectionalLight;

  constructor(scene: THREE.Scene, options?: { isMobile?: boolean }) {
    const isMobile = options?.isMobile ?? false;
    // Crisp high-altitude cobalt alpine sky + atmospheric depth fog
    scene.background = new THREE.Color(0x5da4e8);
    scene.fog = new THREE.FogExp2(0x8bc0ec, 0.00048);

    // Sky dome with alpine zenith-to-horizon gradient + sun halo
    const skyGeo = new THREE.SphereGeometry(2800, 32, 20);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x114494) },
        midColor: { value: new THREE.Color(0x5aa4e6) },
        horizonColor: { value: new THREE.Color(0xcde5fa) },
        sunDir: { value: new THREE.Vector3(0.55, 0.48, -0.68).normalize() },
      },
      vertexShader: `
        varying vec3 vWorldDir;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldDir = normalize(position);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 midColor;
        uniform vec3 horizonColor;
        uniform vec3 sunDir;
        varying vec3 vWorldDir;
        void main() {
          vec3 d = normalize(vWorldDir);
          float h = clamp(d.y, 0.0, 1.0);
          vec3 col = mix(horizonColor, midColor, smoothstep(0.0, 0.28, h));
          col = mix(col, topColor, smoothstep(0.25, 0.85, h));
          float sunAmt = max(dot(d, sunDir), 0.0);
          col += vec3(1.0, 0.94, 0.78) * pow(sunAmt, 64.0) * 0.9;
          col += vec3(1.0, 0.96, 0.88) * pow(sunAmt, 7.0) * 0.16;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    scene.add(new THREE.Mesh(skyGeo, skyMat));

    // Dramatic alpine sunlight (high cross-light from right-rear so BOTH the inner left cliff
    // AND the opposite Chasm Leap rock face catch golden alpine sun, never solid black!)
    const hemi = new THREE.HemisphereLight(0xc8e4ff, 0x8493a6, 1.2);
    scene.add(hemi);

    this.sunLight = new THREE.DirectionalLight(0xfff2da, 2.2);
    this.sunLight.position.set(220, 290, 140);
    this.sunLight.castShadow = true;
    const shadowSize = isMobile ? 1024 : 2048;
    this.sunLight.shadow.mapSize.set(shadowSize, shadowSize);
    this.sunLight.shadow.camera.near = 20;
    this.sunLight.shadow.camera.far = 1100;
    const d = 140;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0006;
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);

    this.buildValleyAndPeaks(scene);
    this.buildPineForest(scene, isMobile ? 320 : 700);
  }

  public updateSunAnchor(playerPos: THREE.Vector3): void {
    this.sunLight.position.set(playerPos.x + 210, playerPos.y + 270, playerPos.z + 135);
    this.sunLight.target.position.copy(playerPos);
    this.sunLight.target.updateMatrixWorld();
  }

  private buildValleyAndPeaks(scene: THREE.Scene): void {
    // Huge alpine valley floor ~260m below the finish + towering surrounding mountain range
    const size = 3400;
    const segs = 128;
    const geo = new THREE.PlaneGeometry(size, size, segs, segs);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const col = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i) - 520; // center around the descent
      pos.setZ(i, z);

      // Deep glacial valley carved along x ~ +260 (right of the cliff drop!)
      const valleyCenterX = 280 + Math.sin(z * 0.0022) * 140;
      const distFromValley = Math.abs(x - valleyCenterX);

      // Keep the valley dramatically deep below our cliff track (y around -240m)
      const baseValleyY = -245;
      const ridgeNoise = fbm2(x * 0.0026 + 3.1, z * 0.0026 - 1.7);
      const sharpPeak = Math.pow(Math.abs(fbm2(x * 0.0018 - 4.2, z * 0.0018 + 2.4) * 2 - 1), 1.2);

      let y = baseValleyY;
      // Rise into epic jagged alpine peaks across the valley & far background
      if (distFromValley > 220) {
        const rise = Math.min(1, (distFromValley - 220) / 720);
        // Suppress mountains right behind/inside the playable cliff corridor (x in [-220, 180], z in [80, -1100])
        const inPlayableBox = x > -190 && x < 180 && z < 160 && z > -1150;
        const corridorMask = inPlayableBox ? 0.08 : 1.0;
        y +=
          corridorMask * (rise * rise * 780 * (0.45 + ridgeNoise * 0.75) + rise * sharpPeak * 340);
      } else {
        // Gentle valley undulations + river trough
        y += ridgeNoise * 26;
      }

      // Dramatic Matterhorn-like jagged spires in the far horizon (-Z)
      if (z < -1250) {
        const farFactor = Math.min(1, (-1250 - z) / 550);
        y += farFactor * (460 + ridgeNoise * 520 + sharpPeak * 380);
      }

      pos.setY(i, y);

      // Alpine altitude coloring: valley meadow -> dark pine -> rocky grey -> snow peaks
      if (y < -218) {
        // Glacial turquoise river bed in valley floor
        col.setHex(0x3a7d8c);
      } else if (y < -140) {
        col.setHex(0x385432).lerp(new THREE.Color(0x4c683d), ridgeNoise);
      } else if (y < 90) {
        col.setHex(0x63676e).lerp(new THREE.Color(0x8a867e), ridgeNoise);
      } else if (y < 230) {
        col.setHex(0x8f8c86).lerp(new THREE.Color(0xeef5fc), (y - 90) / 140);
      } else {
        col.setHex(0xf2f7fc);
      }

      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.02,
      flatShading: true,
    });
    const terrain = new THREE.Mesh(geo, mat);
    terrain.receiveShadow = false;
    scene.add(terrain);

    // Winding glacial river strip way down in the valley for extreme height parallax
    const riverGeo = new THREE.PlaneGeometry(58, 2800, 4, 80);
    riverGeo.rotateX(-Math.PI / 2);
    const rPos = riverGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < rPos.count; i++) {
      const rz = rPos.getZ(i) - 520;
      const rx = rPos.getX(i) + 280 + Math.sin(rz * 0.0022) * 140;
      rPos.setX(i, rx);
      rPos.setZ(i, rz);
      rPos.setY(i, -230);
    }
    const riverMat = new THREE.MeshStandardMaterial({
      color: 0x3da4be,
      roughness: 0.25,
      metalness: 0.15,
    });
    scene.add(new THREE.Mesh(riverGeo, riverMat));
  }

  private buildPineForest(scene: THREE.Scene, treeCount = 700): void {
    // Hundreds of tiny instanced pine trees down in the valley floor to sell the 600m vertigo drop
    const coneGeo = new THREE.ConeGeometry(4.2, 16, 5);
    coneGeo.translate(0, 8, 0);
    const coneMat = new THREE.MeshStandardMaterial({
      color: 0x24422a,
      roughness: 0.95,
      flatShading: true,
    });
    const inst = new THREE.InstancedMesh(coneGeo, coneMat, treeCount);
    const dummy = new THREE.Object3D();

    let placed = 0;
    for (let i = 0; i < treeCount * 2 && placed < treeCount; i++) {
      const z = -1250 + hash2(i, 1.3) * 1450;
      const valleyCenter = 280 + Math.sin(z * 0.0022) * 140;
      const side = hash2(i, 7.9) > 0.5 ? 1 : -1;
      const offset = 46 + hash2(i, 4.1) * 185;
      const x = valleyCenter + side * offset;
      const s = 0.7 + hash2(i, 9.7) * 0.95;
      dummy.position.set(x, -232 + hash2(i, 2.5) * 14, z);
      dummy.scale.set(s, s * (0.9 + hash2(i, 5.2) * 0.5), s);
      dummy.rotation.y = hash2(i, 8.1) * Math.PI * 2;
      dummy.updateMatrix();
      inst.setMatrixAt(placed, dummy.matrix);
      placed++;
    }
    inst.instanceMatrix.needsUpdate = true;
    scene.add(inst);
  }
}
