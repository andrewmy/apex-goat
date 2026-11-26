import * as THREE from 'three';
import { InputManager } from './input/InputManager';
import { AlpineEnvironment } from './world/Environment';
import { AlpineCourse } from './world/AlpineCourse';
import { CheckpointManager } from './world/Checkpoints';
import { GoatController } from './physics/GoatController';
import { GoatRig } from './goat/GoatRig';
import { QuadrupedIK } from './goat/QuadrupedIK';
import { GoatCamera } from './camera/GoatCamera';
import { GoatAudio } from './audio/GoatAudio';
import { PebbleParticles } from './vfx/PebbleParticles';
import { GhostRecorder } from './ghosts/GhostRecorder';
import { GhostHerd } from './ghosts/GhostHerd';
import { Hud, formatTime } from './ui/Hud';
import { BuildBadge } from './ui/BuildBadge';
import { GoatPhysicsSnapshot, SurfaceType } from './types';

function createEmptySnapshot(): GoatPhysicsSnapshot {
  return {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 0, -1),
    up: new THREE.Vector3(0, 1, 0),
    speed: 0,
    grounded: false,
    crouching: false,
    crouchAmount: 0,
    jumpCharge: 0,
    pumpBoostFlash: 0,
    pumpingNow: false,
    pumpReady: false,
    lastPumpGainKmh: 0,
    slopeDeg: 0,
    surface: SurfaceType.Turf,
    groundNormal: new THREE.Vector3(0, 1, 0),
    wallRunning: false,
    wallNormal: new THREE.Vector3(),
    wallSide: 0,
    steerAngle: 0,
    bailedOut: false,
    bailTimer: 0,
    outOfBounds: false,
    airTime: 0,
    gaitPhase: 0,
    headbuttAnim: 0,
    exposureHeight: 0,
  };
}

class ApexGoatGame {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly input: InputManager;
  private readonly env: AlpineEnvironment;
  private readonly course: AlpineCourse;
  private readonly checkpoints: CheckpointManager;
  private readonly controller: GoatController;
  private readonly rig: GoatRig;
  private readonly ik: QuadrupedIK;
  private readonly goatCam: GoatCamera;
  private readonly audio: GoatAudio;
  private readonly particles: PebbleParticles;
  private readonly recorder: GhostRecorder;
  private readonly herd: GhostHerd;
  private readonly hud: Hud;
  public readonly buildBadge: BuildBadge;

  private readonly snapshot = createEmptySnapshot();
  private started = false;
  private paused = false;
  private startOverlayEl!: HTMLElement;
  private pauseOverlayEl!: HTMLElement;
  private finishOverlayEl!: HTMLElement;
  private togglePauseTab!: () => void;
  private maxRunSpeedKmh = 0;
  private accumulator = 0;
  private lastFrameTime = performance.now();
  private fpsFrameCount = 0;
  private fpsSampleStart = performance.now();
  private currentFps = 0;
  private readonly fixedDt = 1 / 120; // Deterministic 120 Hz physics!

  constructor() {
    const container = document.getElementById('app')!;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.input = new InputManager();
    this.env = new AlpineEnvironment(this.scene);
    this.course = new AlpineCourse(this.scene);
    this.checkpoints = new CheckpointManager(this.course.checkpoints);
    this.controller = new GoatController(this.course);

    this.rig = new GoatRig({
      coatColor: 0xf4f0e6,
      accentColor: 0xe2d9c8,
    });
    this.scene.add(this.rig.root);
    this.ik = new QuadrupedIK(this.rig, this.course);

    this.goatCam = new GoatCamera(window.innerWidth / window.innerHeight);
    this.audio = new GoatAudio();
    this.particles = new PebbleParticles(this.scene);
    this.recorder = new GhostRecorder();
    this.herd = new GhostHerd(this.scene, this.course);
    this.hud = new Hud();
    this.buildBadge = new BuildBadge();

    this.hud.setPersonalBest(this.recorder.personalBest?.totalTime ?? null);
    this.hud.setCameraMode(this.goatCam.mode);

    this.bindUiEvents();
    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.goatCam.resize(window.innerWidth, window.innerHeight);
    });

    // Render initial dramatic view perched atop The Goat Spire right away
    this.resetRun();
    this.loop(performance.now());
  }

  private beginGame(): void {
    if (this.started) return;
    this.started = true;
    this.startOverlayEl.classList.add('hidden');
    this.audio.unlock();
    this.audio.playBleat();
    this.resetRun();
    this.checkpoints.startRun();
    this.hud.showBanner('DROP IN!', 'THREAD THE RAZOR LEDGE', 1300);
  }

  private bindUiEvents(): void {
    this.startOverlayEl = document.getElementById('start-overlay')!;
    const startBtn = document.getElementById('start-btn')!;
    this.pauseOverlayEl = document.getElementById('pause-overlay')!;
    this.finishOverlayEl = document.getElementById('finish-overlay')!;
    const resumeBtn = document.getElementById('resume-btn')!;
    const pauseRestartBtn = document.getElementById('pause-restart-btn')!;
    const pauseCamBtn = document.getElementById('pause-cam-btn')!;
    const finishRetryBtn = document.getElementById('finish-retry-btn')!;

    startBtn.addEventListener('click', () => this.beginGame());
    resumeBtn.addEventListener('click', () => this.setPaused(false));
    pauseRestartBtn.addEventListener('click', () => {
      this.setPaused(false);
      this.resetRun();
      this.hud.showBanner('RESTART', 'GO!', 650);
    });
    pauseCamBtn.addEventListener('click', () => {
      const mode = this.goatCam.toggleMode(this.rig);
      this.hud.setCameraMode(mode);
    });
    finishRetryBtn.addEventListener('click', () => {
      this.resetRun();
      this.hud.showBanner('RACE YOUR GHOST!', 'GO!', 850);
    });

    // Segmented Pause Tabs (Tricks | Controls) — clickable OR toggleable with LB on controller!
    const tabBtns = document.querySelectorAll<HTMLButtonElement>('.pause-tab');
    const tricksPanel = document.getElementById('pause-panel-tricks')!;
    const controlsPanel = document.getElementById('pause-panel-controls')!;
    let currentTab: 'tricks' | 'controls' = 'tricks';
    const setTab = (next: 'tricks' | 'controls') => {
      currentTab = next;
      tabBtns.forEach((b) => b.classList.toggle('active', b.dataset.tab === next));
      tricksPanel.classList.toggle('hidden', next !== 'tricks');
      controlsPanel.classList.toggle('hidden', next !== 'controls');
    };
    this.togglePauseTab = () => setTab(currentTab === 'tricks' ? 'controls' : 'tricks');
    tabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        setTab(btn.dataset.tab === 'controls' ? 'controls' : 'tricks');
      });
    });

    window.addEventListener('keydown', (e) => {
      if (!this.started && (e.code === 'Space' || e.code === 'Enter')) {
        e.preventDefault();
        this.beginGame();
      }
    });

    // Auto-pause when switching tabs so timer doesn't run away
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.started && !this.paused && !this.checkpoints.runFinished) {
        this.setPaused(true);
      }
    });
  }

  private setPaused(nextPaused: boolean): void {
    if (!this.started || this.checkpoints.runFinished || this.paused === nextPaused) return;
    this.paused = nextPaused;
    this.pauseOverlayEl.classList.toggle('hidden', !nextPaused);
    this.audio.setPaused(nextPaused);
    if (!nextPaused) {
      this.lastFrameTime = performance.now();
      this.accumulator = 0;
    }
  }

  private showFinishCard(
    totalTime: number,
    medal: string,
    isNewPb: boolean,
    deltaVsPb: number | null,
  ): void {
    const timeEl = document.getElementById('fin-time-title')!;
    const medalLabelEl = document.getElementById('fin-medal-label')!;
    const medalEl = document.getElementById('fin-medal-val')!;
    const kickerEl = document.getElementById('fin-medal-kicker')!;
    const noteEl = document.getElementById('fin-pb-note')!;
    const speedEl = document.getElementById('fin-speed-val')!;

    timeEl.textContent = formatTime(totalTime);
    speedEl.textContent = `${this.maxRunSpeedKmh} KM/H`;

    if (medal === 'NONE') {
      const slowRanks =
        totalTime >= 60
          ? ['PETTING ZOO', 'LOST SHEEP', 'ALPINE HIKER']
          : ['SCENIC GRAZER', 'TOURIST GOAT', 'HAY ENJOYER'];
      const roasts =
        totalTime >= 60
          ? [
              'The herd already finished dinner and went to bed.',
              'Did you stop halfway down to nibble some moss?',
              'Even the valley pine trees lapped you.',
              'That was less of a cliff descent and more of a nature documentary.',
            ]
          : [
              'Brave of you to take the scenic route down a sheer cliff.',
              'The herd is politely pretending they waited for you.',
              'Tip: SHIFT / RB is the slope-pump button, not the sightseeing brake.',
              'A mountain lamb in slippers could shave 10 seconds off that.',
            ];
      const rank = slowRanks[Math.floor(Math.random() * slowRanks.length)];
      const roast = roasts[Math.floor(Math.random() * roasts.length)];

      kickerEl.textContent = 'CERTIFIED SLOWPOKE · RUN COMPLETE';
      medalLabelEl.textContent = 'TITLE';
      medalEl.textContent = rank;
      medalEl.style.color = '#ff8b7b';
      noteEl.textContent = roast;
      noteEl.style.color = '#ffd29d';
      this.audio.playBleat();
    } else {
      medalLabelEl.textContent = 'MEDAL';
      medalEl.textContent = medal;
      medalEl.style.color =
        medal === 'GOLD' ? '#ffd447' : medal === 'SILVER' ? '#d8e3f0' : '#f0a675';
      kickerEl.textContent = `${medal} MEDAL · RUN COMPLETE`;

      if (isNewPb) {
        noteEl.textContent = 'NEW PERSONAL BEST! YOUR GHOST HAS BEEN SAVED.';
        noteEl.style.color = '#47ff9c';
      } else if (deltaVsPb !== null) {
        const sign = deltaVsPb <= 0 ? '-' : '+';
        noteEl.textContent = `${sign}${Math.abs(deltaVsPb).toFixed(2)}s VS PERSONAL BEST`;
        noteEl.style.color = deltaVsPb <= 0 ? '#47ff9c' : '#ff8686';
      } else {
        noteEl.textContent = 'GHOST RECORDED — RACE AGAIN TO BEAT IT!';
        noteEl.style.color = '#7ac7ff';
      }
    }

    this.finishOverlayEl.classList.remove('hidden');
  }

  private resetRun(): void {
    this.setPaused(false);
    this.finishOverlayEl.classList.add('hidden');
    this.maxRunSpeedKmh = 0;
    this.controller.resetTo(this.course.startPosition, this.course.startForward);
    this.checkpoints.reset();
    if (this.started) {
      this.checkpoints.startRun();
    }
    this.recorder.reset();
    this.herd.reset();
    this.goatCam.reset();
    this.hud.clearSplitDelta();
  }

  private resetToCheckpoint(): void {
    // After finishing the run, never respawn into the finish gate in a fall loop —
    // place the goat safely in the flat Valley Finish Meadow!
    if (this.checkpoints.runFinished) {
      const sFin = this.course.getSampleAt(0.925);
      this.controller.resetTo(this.course.finishStopPos, sFin.tangent);
      this.goatCam.reset();
      this.hud.showBanner('FINISH MEADOW', 'PRESS R FOR A NEW RUN', 1200);
      return;
    }

    const cp = this.checkpoints.getLastCheckpoint();
    if (!cp) {
      this.resetRun();
      return;
    }
    const spawnPos = cp.position.clone().add(new THREE.Vector3(0, 1.45, 0));
    this.controller.resetTo(spawnPos, cp.forward);
    this.goatCam.reset();
    this.hud.showBanner('RESPAWNED', cp.name, 950);
  }

  private loop = (now: number): void => {
    requestAnimationFrame(this.loop);

    const frameDt = Math.min(0.05, Math.max(0.0001, (now - this.lastFrameTime) / 1000));
    this.lastFrameTime = now;

    // Measure actual render FPS every 400ms
    this.fpsFrameCount++;
    const fpsElapsed = now - this.fpsSampleStart;
    if (fpsElapsed >= 400) {
      this.currentFps = Math.round((this.fpsFrameCount * 1000) / fpsElapsed);
      this.fpsFrameCount = 0;
      this.fpsSampleStart = now;
    }

    const input = this.input.poll();
    this.hud.setInputDevice(input.device, input.gamepadConnected);

    // Allow Gamepad A/Cross or Start to drop straight in from the Start overlay!
    if (!this.started && (input.jumpJustPressed || input.pauseJustPressed)) {
      this.beginGame();
    }

    if (this.started) {
      if (input.pauseJustPressed) {
        this.setPaused(!this.paused);
      } else if (this.paused && input.backJustPressed) {
        this.setPaused(false);
      }
      if (input.cameraToggleJustPressed) {
        const mode = this.goatCam.toggleMode(this.rig);
        this.hud.setCameraMode(mode);
      }
      if (input.restartJustPressed) {
        this.resetRun();
        this.hud.showBanner('RESTART', 'GO!', 650);
      }

      // On the finish screen, Space or Enter also triggers an instant Trackmania restart!
      if (this.checkpoints.runFinished && input.jumpJustPressed) {
        this.resetRun();
        this.hud.showBanner('RACE YOUR GHOST!', 'GO!', 800);
      }

      if (this.paused) {
        if (input.checkpointJustPressed) {
          this.togglePauseTab();
        }
        this.renderer.render(this.scene, this.goatCam.camera);
        return;
      }

      if (input.bleatJustPressed) {
        this.audio.unlock();
        this.audio.playBleat();
      }
      if (input.checkpointJustPressed) {
        this.resetToCheckpoint();
      }

      // Fixed 120 Hz physics accumulator (zero tunneling, 100% deterministic!)
      this.accumulator += frameDt;
      let steps = 0;
      const maxSteps = 8;

      while (this.accumulator >= this.fixedDt && steps < maxSteps) {
        // Consume edge-triggered jump & headbutt only on the first substep
        const subInput =
          steps === 0
            ? input
            : {
                ...input,
                jumpJustPressed: false,
                jumpJustReleased: false,
                headbuttJustPressed: false,
              };

        this.controller.step(this.fixedDt, subInput, {
          onHeadbuttStart: () => {
            this.audio.playHeadbuttSwing();
            this.goatCam.addShake(0.18);
            this.input.rumble(0.18, 0.35, 65);
          },
          onJump: (ev) => {
            this.audio.playJump(ev.wallKick ? 0.9 : ev.charge);
            this.particles.emitBurst(
              ev.position.clone().add(new THREE.Vector3(0, -0.7, 0)),
              this.controller.velocity.clone().multiplyScalar(-0.4),
              ev.surface,
              ev.wallKick ? 12 : 6,
            );
            if (ev.wallKick) {
              this.goatCam.addShake(0.35);
              this.input.rumble(0.5, 0.72, 100);
              this.hud.showBanner('WALL KICK!', '+BOOST', 650);
            }
          },
          onLand: (ev) => {
            this.audio.playLanding(ev.impactSpeed, ev.pumped);
            this.goatCam.addShake(Math.min(0.9, ev.impactSpeed / 24 + (ev.pumped ? 0.35 : 0)));
            this.particles.emitBurst(
              ev.position.clone().add(new THREE.Vector3(0, -0.7, 0)),
              this.controller.velocity.clone().multiplyScalar(0.3),
              ev.surface,
              ev.pumped ? 18 : 8,
            );
            if (ev.pumped) {
              this.input.rumble(0.75, 0.6, 145);
              this.hud.showBanner(`SLOPE PUMP +${ev.pumpGainKmh} KM/H`, 'CLEAN TRANSITION!', 850);
            } else if (ev.bailed) {
              this.input.rumble(0.95, 0.8, 240);
              this.audio.playBleat();
              this.hud.showBanner('WIPEOUT!', 'RESPAWNING...', 900);
            } else if (ev.impactSpeed > 6) {
              const str = Math.min(0.62, ev.impactSpeed / 26);
              this.input.rumble(str, str * 0.65, 85);
            }
          },
          onOutOfBounds: () => {
            this.input.rumble(0.85, 0.6, 200);
            this.audio.playBleat();
            this.hud.showBanner('OFF CLIFF', 'SNAPPING BACK TO TRACK', 650);
          },
        });

        // Solid physical 28-goat herd hitboxes + multi-goat Headbutt Ram knockouts!
        if (!this.controller.bailedOut && !this.checkpoints.runFinished) {
          const herdHits = this.herd.resolvePlayerCollision(
            this.controller.position,
            this.controller.velocity,
            this.controller.forward,
            this.controller.isHeadbutting(),
          );
          let ramCountThisTick = 0;
          for (const herdHit of herdHits) {
            this.controller.applyHerdBump(herdHit.pushDir, herdHit.type === 'ram');
            if (herdHit.type === 'ram') {
              ramCountThisTick++;
              this.audio.playHeadbuttHit();
              this.goatCam.addShake(0.6);
              this.input.rumble(0.98, 0.88, 170);
              this.particles.emitBurst(
                herdHit.position,
                this.controller.velocity.clone().multiplyScalar(0.5),
                herdHit.surface,
                16,
              );
            } else {
              this.audio.playHoofClack(herdHit.surface, 0.7);
              this.goatCam.addShake(0.22);
              this.input.rumble(0.38, 0.48, 75);
              this.particles.emitBurst(
                herdHit.position,
                herdHit.pushDir.clone().multiplyScalar(3),
                herdHit.surface,
                5,
              );
            }
          }
          if (ramCountThisTick > 1) {
            this.hud.showBanner(`MULTI-RAM ×${ramCountThisTick}!`, '+MASSIVE BOOST', 950);
          } else if (ramCountThisTick === 1) {
            this.hud.showBanner('HEADBUTT RAM!', '+18 KM/H BOOST', 850);
          }
        }

        // Update checkpoints & splits inside the fixed step for exact millisecond timing
        const split = this.checkpoints.update(
          this.fixedDt,
          this.controller.position,
          this.recorder.personalBest?.splits ?? null,
        );
        if (split) {
          let isNewPb = false;
          if (split.isFinish) {
            isNewPb = this.recorder.finishRun(split.splitTime, this.checkpoints.currentSplits);
            if (isNewPb) {
              this.hud.setPersonalBest(split.splitTime);
            }
            // Proper Finish State: smooth goat deceleration + scenic Victory Orbit + Results Card!
            this.controller.enterFinishState();
            this.goatCam.victoryOrbit = true;
            this.showFinishCard(split.splitTime, split.medal ?? 'NONE', isNewPb, split.deltaVsPb);
          }
          const ahead = split.deltaVsPb === null || split.deltaVsPb <= 0;
          this.audio.playCheckpoint(split.isFinish, ahead);
          if (!split.isFinish) {
            this.hud.onSplit(split, isNewPb);
          }
        }

        this.accumulator -= this.fixedDt;
        steps++;
      }

      // Snappy recovery: 0.55s on cliff fall, 0.85s on landing bailout (Space/R skips instantly!)
      if (this.controller.bailedOut) {
        const limit = this.controller.outOfBounds ? 0.55 : 0.85;
        if (this.controller.bailTimer > limit || input.jumpJustPressed) {
          this.resetToCheckpoint();
        }
      }
    }

    // Interpolate physics state for buttery smooth rendering at 60/120Hz
    const alpha = this.started ? this.accumulator / this.fixedDt : 1.0;
    this.controller.getInterpolatedSnapshot(alpha, this.snapshot);

    // Track peak run speed for the Finish Results Card
    if (this.started && !this.checkpoints.runFinished) {
      const kmh = Math.round(this.snapshot.speed * 3.6);
      if (kmh > this.maxRunSpeedKmh) this.maxRunSpeedKmh = kmh;
      this.recorder.record(this.checkpoints.runTime, this.snapshot);
    }

    // Update 4-leg procedural IK (and trigger material-aware hoof clacks & rock sprays!)
    this.ik.update(frameDt, this.snapshot, (step) => {
      if (!this.started) return;
      this.audio.playHoofClack(step.surface, step.intensity);
      const count = step.surface === SurfaceType.Scree ? 5 : 2;
      this.particles.emitBurst(
        step.position,
        this.snapshot.velocity.clone().multiplyScalar(-0.35),
        step.surface,
        count,
      );
    });

    // Update ghost herd, particles, dynamic sun shadow anchor, camera, audio & HUD
    this.herd.update(
      frameDt,
      this.checkpoints.runTime,
      this.started && this.checkpoints.runStarted,
      this.recorder.personalBest,
      this.particles,
    );
    this.particles.update(frameDt);
    this.env.updateSunAnchor(this.snapshot.position);
    this.goatCam.update(frameDt, this.snapshot, this.rig, this.course);
    if (this.started) {
      this.audio.updateContinuous(this.snapshot);
      // Subtle gravel/snow haptic texture on DualSense while carving fast on loose scree!
      if (
        this.snapshot.grounded &&
        this.snapshot.surface === SurfaceType.Scree &&
        this.snapshot.speed > 12 &&
        !this.checkpoints.runFinished
      ) {
        const spdNorm = Math.min(1, this.snapshot.speed / 42);
        this.input.rumble(0.05 * spdNorm, 0.18 * spdNorm, 85, true);
      }
    }
    this.hud.update(
      this.checkpoints.runTime,
      this.checkpoints.nextIndex,
      this.checkpoints.checkpoints.length,
      this.snapshot,
      this.currentFps,
    );

    this.renderer.render(this.scene, this.goatCam.camera);
  };
}

export const game = new ApexGoatGame();
