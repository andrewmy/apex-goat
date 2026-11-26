import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { CheckpointDef, CourseSplineSample, SurfaceType } from '../types';

/** Lightweight deterministic 3D noise for craggy limestone strata */
function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 269.5 + z * 419.2) * 43758.5453;
  return s - Math.floor(s);
}

function smoothNoise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const n000 = hash3(ix, iy, iz);
  const n100 = hash3(ix + 1, iy, iz);
  const n010 = hash3(ix, iy + 1, iz);
  const n110 = hash3(ix + 1, iy + 1, iz);
  const n001 = hash3(ix, iy, iz + 1);
  const n101 = hash3(ix + 1, iy, iz + 1);
  const n011 = hash3(ix, iy + 1, iz + 1);
  const n111 = hash3(ix + 1, iy + 1, iz + 1);

  const nx00 = n000 + (n100 - n000) * ux;
  const nx10 = n010 + (n110 - n010) * ux;
  const nx01 = n001 + (n101 - n001) * ux;
  const nx11 = n011 + (n111 - n011) * ux;

  const nxy0 = nx00 + (nx10 - nx00) * uy;
  const nxy1 = nx01 + (nx11 - nx01) * uy;

  return nxy0 + (nxy1 - nxy0) * uz;
}

interface SectionPoint {
  pos: THREE.Vector3;
  width: number;
  bankDeg: number;
  surface: SurfaceType;
  wallSide: -1 | 1;
}

/**
 * Builds "The Goat Spire" — a continuous ~1,200m alpine cliff descent with:
 *   - Generous, carveable cliff ledges (9m–21m wide) + subtle natural outer safety lip
 *   - Dramatic elevation rollers, step-downs, and concave bowls engineered for
 *     satisfying Tiny-Wings/Steep-style Slope-Pumping!
 *   - Towering inner limestone walls with clean 62° banked wall-run skirts
 *   - Sheer 600m valley drop-off beside the ledge for intense alpine vertigo
 */
export class AlpineCourse {
  public readonly collisionMesh: THREE.Mesh;
  public readonly bvh: MeshBVH;
  public readonly faceSurfaces: Uint8Array;
  public readonly samples: CourseSplineSample[] = [];
  public readonly checkpoints: CheckpointDef[] = [];
  public readonly startPosition = new THREE.Vector3();
  public readonly startForward = new THREE.Vector3();
  public readonly startUp = new THREE.Vector3(0, 1, 0);
  public readonly decorGroup = new THREE.Group();

  // Gap range along spline [tStart, tEnd] for the dramatic Chasm Leap
  private readonly gapStartT = 0.688;
  private readonly gapEndT = 0.712;
  public readonly finishT = 0.885;
  public readonly finishStopPos = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    // Control points with GENUINELY STEEP alpine inclines (y = 650m -> -115m: 765m vertical plunge!)
    // plus sharp, punchy ~70m asymmetric pump rollers & a massive 260m Scree Chute!
    const control: SectionPoint[] = [
      // 0: High Summit Start -> Immediate steep alpine drop-in!
      {
        pos: new THREE.Vector3(0, 650, 0),
        width: 11.5,
        bankDeg: 2,
        surface: SurfaceType.Turf,
        wallSide: -1,
      },
      {
        pos: new THREE.Vector3(2, 622, -42),
        width: 10.5,
        bankDeg: 6,
        surface: SurfaceType.Granite,
        wallSide: -1,
      },
      // 1: Razor Limestone Ledge (steep drop-ins + punchy crests!)
      {
        pos: new THREE.Vector3(-9, 558, -108),
        width: 10.2,
        bankDeg: 11,
        surface: SurfaceType.Granite,
        wallSide: -1,
      },
      {
        pos: new THREE.Vector3(-24, 522, -172),
        width: 9.8,
        bankDeg: 14,
        surface: SurfaceType.Granite,
        wallSide: -1,
      },
      {
        pos: new THREE.Vector3(-12, 438, -240),
        width: 11.0,
        bankDeg: 10,
        surface: SurfaceType.Granite,
        wallSide: -1,
      },
      // 2: Stepped Granite Rollers & Banked Switchback (big steep pump faces!)
      {
        pos: new THREE.Vector3(16, 404, -306),
        width: 12.6,
        bankDeg: -10,
        surface: SurfaceType.Granite,
        wallSide: -1,
      },
      {
        pos: new THREE.Vector3(34, 326, -376),
        width: 12.2,
        bankDeg: -12,
        surface: SurfaceType.Granite,
        wallSide: -1,
      },
      {
        pos: new THREE.Vector3(14, 294, -444),
        width: 13.5,
        bankDeg: -6,
        surface: SurfaceType.Granite,
        wallSide: -1,
      },
      // 3: THE SCREE CHUTE (huge 45°+ plunging dark-shale face — 265m vertical drop!)
      {
        pos: new THREE.Vector3(-24, 206, -518),
        width: 18.5,
        bankDeg: 15,
        surface: SurfaceType.Scree,
        wallSide: -1,
      },
      {
        pos: new THREE.Vector3(-52, 146, -594),
        width: 21.5,
        bankDeg: 18,
        surface: SurfaceType.Scree,
        wallSide: -1,
      },
      {
        pos: new THREE.Vector3(-32, 42, -678),
        width: 21.0,
        bankDeg: 13,
        surface: SurfaceType.Scree,
        wallSide: -1,
      },
      {
        pos: new THREE.Vector3(8, -16, -756),
        width: 17.0,
        bankDeg: -8,
        surface: SurfaceType.Scree,
        wallSide: -1,
      },
      // 4: Launch Crest -> Chasm Leap -> Steep Snow Landing Bowl!
      {
        pos: new THREE.Vector3(22, -20, -818),
        width: 13.0,
        bankDeg: 0,
        surface: SurfaceType.Granite,
        wallSide: -1,
      },
      {
        pos: new THREE.Vector3(26, -68, -884),
        width: 19.5,
        bankDeg: 6,
        surface: SurfaceType.Snow,
        wallSide: -1,
      },
      {
        pos: new THREE.Vector3(14, -124, -954),
        width: 18.5,
        bankDeg: 10,
        surface: SurfaceType.Snow,
        wallSide: -1,
      },
      // 5: Final Alpine Ridge Rollers into Finish Gate (t ~ 0.885)
      {
        pos: new THREE.Vector3(-8, -132, -1022),
        width: 13.5,
        bankDeg: 6,
        surface: SurfaceType.Granite,
        wallSide: -1,
      },
      {
        pos: new THREE.Vector3(-14, -148, -1096),
        width: 17.5,
        bankDeg: 0,
        surface: SurfaceType.Turf,
        wallSide: -1,
      },
      // 6: Spacious Valley Finish Meadow (wide grassy stopping bowl!)
      {
        pos: new THREE.Vector3(-12, -150, -1165),
        width: 26.0,
        bankDeg: 0,
        surface: SurfaceType.Turf,
        wallSide: -1,
      },
      {
        pos: new THREE.Vector3(-10, -140, -1238),
        width: 30.0,
        bankDeg: 0,
        surface: SurfaceType.Turf,
        wallSide: -1,
      },
      {
        pos: new THREE.Vector3(-8, -112, -1305),
        width: 34.0,
        bankDeg: 0,
        surface: SurfaceType.Turf,
        wallSide: -1,
      },
    ];

    const curve = new THREE.CatmullRomCurve3(
      control.map((c) => c.pos),
      false,
      'centripetal',
      0.42,
    );

    const numStations = 440;
    const worldUp = new THREE.Vector3(0, 1, 0);

    // First pass: sculpt sharp, shorter-wavelength asymmetric pump rollers!
    // Wavelength ~78m with steep ~48-56° landing backsides so Slope-Pumping feels electric!
    const rawPositions: THREE.Vector3[] = [];
    for (let i = 0; i <= numStations; i++) {
      const t = i / numStations;
      const position = curve.getPointAt(t);

      const startEnv = THREE.MathUtils.smoothstep(t, 0.025, 0.08);
      const endEnv = 1 - THREE.MathUtils.smoothstep(t, 0.81, 0.865);
      const gapDist = Math.min(Math.abs(t - this.gapStartT), Math.abs(t - this.gapEndT));
      const gapEnv = THREE.MathUtils.smoothstep(gapDist, 0.015, 0.048);
      const rollerEnv = startEnv * endEnv * gapEnv;

      // Asymmetric wave (fundamental + 2nd harmonic): crisp crest launch -> steeper plunging landing chute!
      const phase = t * Math.PI * 28;
      const asymWave = (Math.sin(phase) + 0.34 * Math.sin(phase * 2 - 0.55)) * 7.2 * rollerEnv;
      position.y += asymWave;

      // Crisp upward ski-jump kicker just before the Chasm Leap!
      if (t > this.gapStartT - 0.026 && t <= this.gapStartT) {
        const kick = (t - (this.gapStartT - 0.026)) / 0.026;
        position.y += kick * kick * 8.2;
      }

      rawPositions.push(position);
    }

    // Second pass: compute true tangents from the sculpted roller positions
    for (let i = 0; i <= numStations; i++) {
      const t = i / numStations;
      const position = rawPositions[i];
      const prevP = rawPositions[Math.max(0, i - 1)];
      const nextP = rawPositions[Math.min(numStations, i + 1)];
      const tangent = new THREE.Vector3().subVectors(nextP, prevP).normalize();

      const right = new THREE.Vector3().crossVectors(tangent, worldUp).normalize();
      const up = new THREE.Vector3().crossVectors(right, tangent).normalize();

      const fIdx = t * (control.length - 1);
      const i0 = Math.min(control.length - 1, Math.floor(fIdx));
      const i1 = Math.min(control.length - 1, i0 + 1);
      const frac = fIdx - i0;
      const sFrac = frac * frac * (3 - 2 * frac);

      const width = THREE.MathUtils.lerp(control[i0].width, control[i1].width, sFrac);
      const bankDeg = THREE.MathUtils.lerp(control[i0].bankDeg, control[i1].bankDeg, sFrac);
      const surface = frac < 0.5 ? control[i0].surface : control[i1].surface;
      const wallSide = frac < 0.5 ? control[i0].wallSide : control[i1].wallSide;
      const hasGap = t > this.gapStartT && t < this.gapEndT;

      this.samples.push({
        t,
        position,
        tangent,
        right,
        up,
        width,
        bankRad: THREE.MathUtils.degToRad(bankDeg),
        surface,
        wallSide,
        hasGap,
      });
    }

    const s0 = this.samples[3];
    this.startPosition.copy(s0.position).add(new THREE.Vector3(0, 1.35, 0));
    this.startForward.copy(s0.tangent).setY(0).normalize();
    const sFin = this.getSampleAt(0.925);
    this.finishStopPos.copy(sFin.position).add(new THREE.Vector3(0, 1.5, 0));

    const { geometry, faceSurfaces } = this.buildCliffGeometry();
    this.faceSurfaces = faceSurfaces;

    this.bvh = new MeshBVH(geometry, { maxLeafTris: 8 });
    (geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH }).boundsTree = this.bvh;

    const rockTexture = this.createProceduralRockTexture();
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: rockTexture,
      roughness: 0.88,
      metalness: 0.04,
      flatShading: true,
      side: THREE.DoubleSide,
    });

    this.collisionMesh = new THREE.Mesh(geometry, material);
    this.collisionMesh.castShadow = true;
    this.collisionMesh.receiveShadow = true;
    scene.add(this.collisionMesh);

    this.buildCheckpoints();
    this.buildVisualLandmarks();
    scene.add(this.decorGroup);
  }

  /**
   * 16-vertex alpine cross-section per station:
   * - Towering near-vertical limestone wall on inner side (+68m high)
   * - Smooth, wide climbable/wall-runnable 55°-68° banked inner ramp!
   * - Wide, carveable playable racing corridor with subtle concave dish (keeps high-speed lines natural)
   * - Natural low outer rocky curb lip (+0.38m) that subtly warns/catches slides before the sheer drop
   * - Secondary catch shelf / buttress + 190m plunging cliff face into the alpine valley
   */
  private buildCliffGeometry(): {
    geometry: THREE.BufferGeometry;
    faceSurfaces: Uint8Array;
  } {
    // 17-column SOLID grounded mountain cross-section (zero floating ribbons, zero inverted folds!):
    // Col 0 = Back-mountain slope anchored straight down into the valley floor (y = -280m)
    // Cols 1..5 = Towering inner alpine cliff massif & climbable/wall-run rock faces
    // Cols 6..11 = Wide carveable racing ledge & natural outer rocky lip
    // Cols 12..16 = Sheer plunging mountain buttress anchored straight into the valley floor (y = -280m)
    const cols = 17;
    const rows = this.samples.length;
    const VALLEY_ANCHOR_Y = -280;

    const positions: number[] = [];
    const colors: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const faceSurfaceList: number[] = [];

    const col = new THREE.Color();
    const tmpP = new THREE.Vector3();
    const bankedRight = new THREE.Vector3();
    const bankedUp = new THREE.Vector3();

    for (let r = 0; r < rows; r++) {
      const s = this.samples[r];
      const hw = s.width * 0.5;
      const wallDir = s.wallSide;

      bankedRight.copy(s.right).applyAxisAngle(s.tangent, s.bankRad);
      bankedUp.copy(s.up).applyAxisAngle(s.tangent, s.bankRad);

      for (let c = 0; c < cols; c++) {
        const profileIdx = wallDir === -1 ? c : cols - 1 - c;
        const sideSign = wallDir;

        let lat: number;
        let elev: number;
        let noiseScale: number;
        let anchorToValley = false;

        switch (profileIdx) {
          case 0: // Solid back-of-mountain anchor straight down into valley floor!
            lat = hw + 115;
            elev = 0;
            noiseScale = 8.0;
            anchorToValley = true;
            break;
          case 1: // High upper mountain crest
            lat = hw + 42;
            elev = 78;
            noiseScale = 4.6;
            break;
          case 2: // High vertical cliff face
            lat = hw + 18;
            elev = 46;
            noiseScale = 3.2;
            break;
          case 3: // Mid cliff wall (smooth strata — zero crevices or folding pockets!)
            lat = hw + 8.0;
            elev = 20;
            noiseScale = 0.25;
            break;
          case 4: // Steep wall-run zone (~72° rock face)
            lat = hw + 3.8;
            elev = 8.2;
            noiseScale = 0.14;
            break;
          case 5: // Climbable banked granite transition (~52° ramp!)
            lat = hw + 1.8;
            elev = 2.4;
            noiseScale = 0.08;
            break;
          case 6: // Inner playable edge
            lat = hw * 0.94;
            elev = 0.42;
            noiseScale = 0.1;
            break;
          case 7: // Inner-mid track
            lat = hw * 0.46;
            elev = 0.04;
            noiseScale = 0.07;
            break;
          case 8: // Center racing groove
            lat = 0;
            elev = -0.14;
            noiseScale = 0.05;
            break;
          case 9: // Outer-mid track
            lat = -hw * 0.48;
            elev = 0.02;
            noiseScale = 0.07;
            break;
          case 10: // Outer playable edge
            lat = -hw * 0.92;
            elev = 0.26;
            noiseScale = 0.12;
            break;
          case 11: // Subtle natural rocky edge berm (raised meadow bank past finish!)
            lat = -(hw + 0.65);
            elev = s.t > 0.88 ? 2.2 : 0.36;
            noiseScale = 0.22;
            break;
          case 12: // Razor cliff lip
            lat = -(hw + 1.65);
            elev = s.t > 0.88 ? 5.2 : -0.85;
            noiseScale = 0.45;
            break;
          case 13: // Upper plunging drop
            lat = -(hw + 4.8);
            elev = -16;
            noiseScale = 1.6;
            break;
          case 14: // Sheer cliff face drop
            lat = -(hw + 14);
            elev = -72;
            noiseScale = 3.2;
            break;
          case 15: // Deep lower mountain buttress
            lat = -(hw + 38);
            elev = -190;
            noiseScale = 5.5;
            break;
          default: // Solid valley-floor skirt anchor (ALWAYS reaches below y = -245m valley!)
            lat = -(hw + 105);
            elev = 0;
            noiseScale = 8.0;
            anchorToValley = true;
            break;
        }

        const signedLat = lat * sideSign;
        tmpP
          .copy(s.position)
          .addScaledVector(bankedRight, signedLat)
          .addScaledVector(bankedUp, elev);

        if (anchorToValley) {
          tmpP.y = VALLEY_ANCHOR_Y;
        }

        const n1 = smoothNoise3(tmpP.x * 0.065, tmpP.y * 0.08, tmpP.z * 0.065) - 0.5;
        const n2 = smoothNoise3(tmpP.x * 0.19, tmpP.y * 0.24, tmpP.z * 0.19) - 0.5;
        const strata = Math.sin(tmpP.y * 0.45 + n1 * 3.0) * 0.35;

        tmpP.x += (n1 * 1.4 + n2 * 0.6) * noiseScale;
        if (!anchorToValley) {
          tmpP.y += (n1 * 0.9 + strata) * noiseScale;
        }
        tmpP.z += n2 * 1.1 * noiseScale;

        positions.push(tmpP.x, tmpP.y, tmpP.z);
        uvs.push(c * 0.6, r * 0.45);

        const rockGrain = smoothNoise3(tmpP.x * 0.14 + 5, tmpP.y * 0.22, tmpP.z * 0.14);
        const strataTint = 0.92 + 0.14 * Math.sin(tmpP.y * 0.55 + rockGrain * 2.5);

        if (profileIdx <= 3 || profileIdx >= 13) {
          col.setHex(profileIdx <= 2 ? 0xa9a296 : 0x7e7a74);
          col.lerp(new THREE.Color(0x52565f), rockGrain * 0.48);
          if (profileIdx === 1 && tmpP.y > 160) {
            col.lerp(new THREE.Color(0xeaf2fa), 0.55);
          }
          col.multiplyScalar(strataTint);
        } else if (profileIdx === 4 || profileIdx === 5) {
          col.setHex(0xb8b0a1).lerp(new THREE.Color(0x88837b), rockGrain * 0.4);
          col.multiplyScalar(strataTint);
        } else {
          switch (s.surface) {
            case SurfaceType.Granite:
              col.setHex(0xcbc3b4).lerp(new THREE.Color(0x9b9488), rockGrain * 0.45);
              if (profileIdx === 8) col.lerp(new THREE.Color(0xeee8db), 0.38);
              break;
            case SurfaceType.Scree:
              col.setHex(0x50545d).lerp(new THREE.Color(0x6e6c6a), rockGrain * 0.55);
              if (profileIdx === 8) col.lerp(new THREE.Color(0x848078), 0.3);
              break;
            case SurfaceType.Snow:
              col.setHex(0xeaf4fd).lerp(new THREE.Color(0xc5def4), rockGrain * 0.35);
              break;
            case SurfaceType.Turf:
              col.setHex(0x597841).lerp(new THREE.Color(0x768b4a), rockGrain * 0.5);
              if (profileIdx === 8) col.lerp(new THREE.Color(0xa29880), 0.48);
              break;
          }
          if (profileIdx === 11 || profileIdx === 12) {
            col.multiplyScalar(0.8);
          }
        }

        colors.push(col.r, col.g, col.b);
      }
    }

    for (let r = 0; r < rows - 1; r++) {
      const s0 = this.samples[r];
      const s1 = this.samples[r + 1];
      if (s0.hasGap || s1.hasGap) continue;

      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        const b = (r + 1) * cols + c;
        const cIdx = (r + 1) * cols + (c + 1);
        const d = r * cols + (c + 1);

        indices.push(a, cIdx, b);
        indices.push(a, d, cIdx);

        const profileIdx = s0.wallSide === -1 ? c : cols - 2 - c;
        const isPlayable = profileIdx >= 6 && profileIdx <= 11;
        const surf = isPlayable ? s0.surface : SurfaceType.Granite;
        faceSurfaceList.push(surf, surf);
      }
    }

    // SOLID 3D CLIFF END-CAPS anchored ALL THE WAY DOWN to VALLEY_ANCHOR_Y (-280m)!
    const addVerticalCliffCap = (rowIdx: number, faceForward: boolean) => {
      const s = this.samples[rowIdx];
      const tiers = 6;
      const tierFracs = [0, 0.06, 0.18, 0.42, 0.72, 1.0];
      const tierPush = [0, 1.2, 3.6, 8.5, 16.0, 26.0];
      const dirSign = faceForward ? 1 : -1;

      const capStartVert = positions.length / 3;
      const capCol = new THREE.Color();

      for (let ti = 0; ti < tiers; ti++) {
        const frac = tierFracs[ti];
        const pushAlongT = tierPush[ti] * dirSign;

        for (let c = 0; c < cols; c++) {
          const srcIdx = (rowIdx * cols + c) * 3;
          let vx = positions[srcIdx];
          let vy = positions[srcIdx + 1];
          let vz = positions[srcIdx + 2];

          if (ti > 0) {
            const targetY = THREE.MathUtils.lerp(vy, VALLEY_ANCHOR_Y, frac);
            const n = smoothNoise3(vx * 0.08 + ti * 3.1, targetY * 0.06, vz * 0.08) - 0.5;
            vx += s.tangent.x * pushAlongT + n * (1.2 + ti * 1.1);
            vy = ti === tiers - 1 ? VALLEY_ANCHOR_Y : targetY + n * (0.9 + ti * 0.9);
            vz += s.tangent.z * pushAlongT + n * (1.2 + ti * 1.1);
          }

          positions.push(vx, vy, vz);
          uvs.push(c * 0.6, ti * 1.2);

          const grain = smoothNoise3(vx * 0.14, vy * 0.2, vz * 0.14);
          const strataBand = 0.88 + 0.18 * Math.sin(vy * 0.32 + grain * 3.0);
          const depthDark = 1.0 - ti * 0.055;
          // Natural sun-bleached alpine limestone strata + snow dusting on top edge of landing wall!
          if (ti === 0 && !faceForward && s.surface === SurfaceType.Snow) {
            capCol.setHex(0xe5f0fa).lerp(new THREE.Color(0xbdb6aa), grain * 0.45);
          } else {
            capCol
              .setHex(ti <= 1 ? 0xc2bab0 : 0xa59e94)
              .lerp(new THREE.Color(0x7d8089), grain * 0.45)
              .multiplyScalar(strataBand * depthDark);
          }
          colors.push(capCol.r, capCol.g, capCol.b);
        }
      }

      for (let ti = 0; ti < tiers - 1; ti++) {
        for (let c = 0; c < cols - 1; c++) {
          const topL = capStartVert + ti * cols + c;
          const topR = capStartVert + ti * cols + (c + 1);
          const botL = capStartVert + (ti + 1) * cols + c;
          const botR = capStartVert + (ti + 1) * cols + (c + 1);

          if (faceForward) {
            indices.push(topL, topR, botL);
            indices.push(topR, botR, botL);
          } else {
            indices.push(topL, botL, topR);
            indices.push(topR, botL, botR);
          }
          faceSurfaceList.push(SurfaceType.Granite, SurfaceType.Granite);
        }
      }
    };

    // Seal both sides of the Chasm Leap all the way down to the valley floor!
    let takeoffRow = -1;
    let landingRow = -1;
    for (let r = 0; r < rows - 1; r++) {
      if (!this.samples[r].hasGap && this.samples[r + 1].hasGap) {
        takeoffRow = r;
      }
      if (this.samples[r].hasGap && !this.samples[r + 1].hasGap) {
        landingRow = r + 1;
      }
    }
    if (takeoffRow >= 0) addVerticalCliffCap(takeoffRow, true);
    if (landingRow >= 0) addVerticalCliffCap(landingRow, false);

    // Bridge the chasm with a textured rocky gorge floor (~70m below the jump lip)
    // plus keep the high inner mountain backdrop continuous behind the gap!
    if (takeoffRow >= 0 && landingRow >= 0) {
      const gorgeStart = positions.length / 3;
      const gCol = new THREE.Color();
      for (const rowIdx of [takeoffRow, landingRow]) {
        for (let c = 0; c < cols; c++) {
          const srcIdx = (rowIdx * cols + c) * 3;
          const vx = positions[srcIdx];
          const vy = positions[srcIdx + 1];
          const vz = positions[srcIdx + 2];
          // Keep high mountain ridge behind the chasm continuous; carve a deep gorge under the jump!
          const ravineY = c <= 2 ? vy : c <= 4 ? vy - 18 : Math.min(vy - 68, -115);
          positions.push(vx, ravineY, vz);
          uvs.push(c * 0.6, rowIdx * 0.2);
          const gNoise = smoothNoise3(vx * 0.1, ravineY * 0.1, vz * 0.1);
          gCol.setHex(c <= 3 ? 0xa39c91 : 0x7b7e86).lerp(new THREE.Color(0x636873), gNoise * 0.5);
          colors.push(gCol.r, gCol.g, gCol.b);
        }
      }
      for (let c = 0; c < cols - 1; c++) {
        const a = gorgeStart + c;
        const b = gorgeStart + cols + c;
        const cIdx = gorgeStart + cols + (c + 1);
        const d = gorgeStart + (c + 1);
        indices.push(a, cIdx, b);
        indices.push(a, d, cIdx);
        faceSurfaceList.push(SurfaceType.Granite, SurfaceType.Granite);
      }
    }

    // Seal start ridge & finish meadow end-wall straight down to valley floor too!
    addVerticalCliffCap(0, false);
    addVerticalCliffCap(rows - 1, true);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    return {
      geometry,
      faceSurfaces: new Uint8Array(faceSurfaceList),
    };
  }

  private createProceduralRockTexture(): THREE.CanvasTexture {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const n =
          hash3(x * 0.25, y * 0.25, 1.0) * 0.5 +
          hash3(x * 0.7, y * 0.15, 4.2) * 0.35 +
          Math.sin(y * 0.22) * 0.15;
        const v = Math.floor(205 + n * 48);
        const idx = (y * size + x) * 4;
        img.data[idx] = v;
        img.data[idx + 1] = v;
        img.data[idx + 2] = v;
        img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private buildCheckpoints(): void {
    const specs: Array<{ t: number; name: string; isFinish?: boolean }> = [
      { t: 0.145, name: 'RAZOR LEDGE' },
      { t: 0.31, name: 'GRANITE ROLLERS' },
      { t: 0.48, name: 'SCREE CHUTE' },
      { t: 0.655, name: 'CHASM LAUNCH' },
      { t: 0.785, name: 'SNOW BOWL' },
      { t: this.finishT, name: 'VALLEY FINISH', isFinish: true },
    ];

    specs.forEach((spec, index) => {
      const s = this.getSampleAt(spec.t);
      this.checkpoints.push({
        index,
        name: spec.name,
        t: spec.t,
        position: s.position.clone(),
        forward: s.tangent.clone(),
        right: s.right.clone(),
        up: s.up.clone(),
        width: s.width + 6.0,
        isFinish: Boolean(spec.isFinish),
      });
    });
  }

  private buildVisualLandmarks(): void {
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2d3440, roughness: 0.6 });
    const flagMat = new THREE.MeshStandardMaterial({
      color: 0xff5a2c,
      emissive: 0x330d00,
      roughness: 0.7,
      side: THREE.DoubleSide,
    });
    const finishFlagMat = new THREE.MeshStandardMaterial({
      color: 0x3ef79a,
      emissive: 0x0a4428,
      roughness: 0.5,
      side: THREE.DoubleSide,
    });
    const cairnMat = new THREE.MeshStandardMaterial({
      color: 0xaba394,
      roughness: 0.95,
      flatShading: true,
    });

    const poleGeo = new THREE.CylinderGeometry(0.06, 0.08, 2.5, 5);
    const flagGeo = new THREE.PlaneGeometry(0.95, 0.52);
    const stoneGeo = new THREE.DodecahedronGeometry(0.45, 0);

    for (let i = 10; i < this.samples.length - 8; i += 14) {
      const s = this.samples[i];
      if (s.hasGap) continue;

      const dropSide = -s.wallSide;
      const offset = (s.width * 0.5 + 0.55) * dropSide;
      const basePos = s.position.clone().addScaledVector(s.right, offset);

      for (let k = 0; k < 3; k++) {
        const rock = new THREE.Mesh(stoneGeo, cairnMat);
        const scale = 1.0 - k * 0.26;
        rock.scale.set(scale * 1.1, scale * 0.65, scale);
        rock.position.copy(basePos).add(new THREE.Vector3(0, 0.45 + k * 0.34, 0));
        rock.rotation.y = i * 1.3 + k;
        this.decorGroup.add(rock);
      }

      if (i % 28 === 10) {
        const pole = new THREE.Mesh(poleGeo, poleMat);
        pole.position.copy(basePos).add(new THREE.Vector3(0, 1.5, 0));
        this.decorGroup.add(pole);

        const flag = new THREE.Mesh(flagGeo, flagMat);
        flag.position.copy(basePos).add(new THREE.Vector3(0.45, 2.45, 0));
        flag.rotation.y = Math.atan2(s.tangent.x, s.tangent.z) + 0.3;
        this.decorGroup.add(flag);
      }
    }

    const gatePoleGeo = new THREE.CylinderGeometry(0.12, 0.15, 6.2, 6);
    const bannerGeo = new THREE.PlaneGeometry(1.5, 2.5);

    for (const cp of this.checkpoints) {
      const halfSpan = Math.min(cp.width * 0.48, 9.5);
      const mat = cp.isFinish ? finishFlagMat : flagMat;

      for (const side of [-1, 1]) {
        const p = cp.position.clone().addScaledVector(cp.right, side * halfSpan);
        const pole = new THREE.Mesh(gatePoleGeo, poleMat);
        pole.position.copy(p).add(new THREE.Vector3(0, 2.9, 0));
        pole.castShadow = true;
        this.decorGroup.add(pole);

        const banner = new THREE.Mesh(bannerGeo, mat);
        banner.position
          .copy(p)
          .add(new THREE.Vector3(0, 4.4, 0))
          .addScaledVector(cp.right, -side * 0.78);
        banner.lookAt(banner.position.clone().add(cp.forward));
        this.decorGroup.add(banner);
      }

      if (cp.isFinish) {
        const barGeo = new THREE.BoxGeometry(halfSpan * 2 + 0.4, 0.6, 0.38);
        const bar = new THREE.Mesh(barGeo, finishFlagMat);
        bar.position.copy(cp.position).add(new THREE.Vector3(0, 5.8, 0));
        bar.lookAt(bar.position.clone().add(cp.forward));
        this.decorGroup.add(bar);
      }
    }
  }

  public getSampleAt(t: number): CourseSplineSample {
    const clamped = THREE.MathUtils.clamp(t, 0, 1);
    const idx = Math.min(this.samples.length - 1, Math.round(clamped * (this.samples.length - 1)));
    return this.samples[idx];
  }

  /** Continuous smooth spline interpolation (zero station-snapping jitter for herd bots!) */
  public getInterpolatedSampleAt(
    t: number,
    outPos: THREE.Vector3,
    outTangent: THREE.Vector3,
    outRight: THREE.Vector3,
    outUp: THREE.Vector3,
  ): { width: number; surface: SurfaceType; hasGap: boolean } {
    const clamped = THREE.MathUtils.clamp(t, 0, 1);
    const fIdx = clamped * (this.samples.length - 1);
    const i0 = Math.min(this.samples.length - 1, Math.floor(fIdx));
    const i1 = Math.min(this.samples.length - 1, i0 + 1);
    const frac = fIdx - i0;
    const a = this.samples[i0];
    const b = this.samples[i1];

    outPos.lerpVectors(a.position, b.position, frac);
    outTangent.lerpVectors(a.tangent, b.tangent, frac).normalize();
    outRight.lerpVectors(a.right, b.right, frac).normalize();
    outUp.lerpVectors(a.up, b.up, frac).normalize();

    return {
      width: THREE.MathUtils.lerp(a.width, b.width, frac),
      surface: frac < 0.5 ? a.surface : b.surface,
      hasGap: a.hasGap || b.hasGap,
    };
  }

  /** Fast lookup of the nearest course centerline sample (by horizontal distance) */
  public findNearestSample(pos: THREE.Vector3): {
    sample: CourseSplineSample;
    horizDistSq: number;
  } {
    let bestIdx = 0;
    let bestDistSq = Infinity;
    // Stride-4 coarse scan then local refinement -> ~100 checks total (< 0.01ms)
    for (let i = 0; i < this.samples.length; i += 4) {
      const sp = this.samples[i].position;
      const dx = pos.x - sp.x;
      const dz = pos.z - sp.z;
      const dSq = dx * dx + dz * dz;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestIdx = i;
      }
    }
    const lo = Math.max(0, bestIdx - 4);
    const hi = Math.min(this.samples.length - 1, bestIdx + 4);
    for (let i = lo; i <= hi; i++) {
      const sp = this.samples[i].position;
      const dx = pos.x - sp.x;
      const dz = pos.z - sp.z;
      const dSq = dx * dx + dz * dz;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestIdx = i;
      }
    }
    return { sample: this.samples[bestIdx], horizDistSq: bestDistSq };
  }

  public getSurfaceForFace(faceIndex: number): SurfaceType {
    if (faceIndex < 0 || faceIndex >= this.faceSurfaces.length) {
      return SurfaceType.Granite;
    }
    return this.faceSurfaces[faceIndex];
  }
}
