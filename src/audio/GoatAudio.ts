import { GoatPhysicsSnapshot, SurfaceType } from '../types';

/**
 * Zero-asset procedural Web Audio synthesizer:
 * - Crisp material-aware hoof-clack impulse grains fired by actual IK foot plants
 * - Dynamic high-altitude wind roar scaling with speed + cliff-edge exposure
 * - Loose scree / snow sliding hiss bed
 * - Slope-pump boost whoosh, checkpoint chime, and cheeky goat bleat!
 */
export class GoatAudio {
  private ctx: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private slideGain: GainNode | null = null;
  private slideFilter: BiquadFilterNode | null = null;
  private masterGain: GainNode | null = null;
  private initialized = false;
  private windDuckUntil = 0;

  constructor() {
    // Ensure any mouse click or keypress unlocks Web Audio even if the user dropped in via gamepad
    const resumeOnGesture = () => {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
    };
    window.addEventListener('pointerdown', resumeOnGesture);
    window.addEventListener('keydown', resumeOnGesture);
  }

  public unlock(): void {
    if (this.initialized) {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return;
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    this.ctx = new AudioCtx();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.62;
    this.masterGain.connect(this.ctx.destination);

    // Pre-generate 2 seconds of white noise for wind, scree, and clacks
    const sr = this.ctx.sampleRate;
    this.noiseBuffer = this.ctx.createBuffer(1, sr * 2, sr);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    // Continuous alpine wind rush layer
    const windSrc = this.ctx.createBufferSource();
    windSrc.buffer = this.noiseBuffer;
    windSrc.loop = true;

    this.windFilter = this.ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 320;
    this.windFilter.Q.value = 0.9;

    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0.0;

    windSrc.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.masterGain);
    windSrc.start();

    // Continuous scree gravel / snow surf grain bed
    const slideSrc = this.ctx.createBufferSource();
    slideSrc.buffer = this.noiseBuffer;
    slideSrc.loop = true;

    this.slideFilter = this.ctx.createBiquadFilter();
    this.slideFilter.type = 'bandpass';
    this.slideFilter.frequency.value = 1800;
    this.slideFilter.Q.value = 1.4;

    this.slideGain = this.ctx.createGain();
    this.slideGain.gain.value = 0.0;

    slideSrc.connect(this.slideFilter);
    this.slideFilter.connect(this.slideGain);
    this.slideGain.connect(this.masterGain);
    slideSrc.start();

    this.initialized = true;
  }

  public setPaused(paused: boolean): void {
    if (!this.initialized || !this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    this.masterGain.gain.setTargetAtTime(paused ? 0.0 : 0.62, now, 0.03);
  }

  public updateContinuous(snap: GoatPhysicsSnapshot): void {
    if (
      !this.initialized ||
      !this.ctx ||
      !this.windGain ||
      !this.windFilter ||
      !this.slideGain ||
      !this.slideFilter
    ) {
      return;
    }
    const now = this.ctx.currentTime;
    const speedNorm = Math.min(1, snap.speed / 36);
    const exposureNorm = Math.min(1, snap.exposureHeight / 120);
    // Alpine wind swells with speed, sheer cliff drop exposure, and big airs
    // (kept balanced + ducked briefly during bleats so vocals & hoof clacks cut through!)
    const duckMul = now < this.windDuckUntil ? 0.42 : 1.0;
    const airBonus = snap.grounded ? 0 : 0.08;
    const targetWindVol =
      (0.02 + speedNorm * speedNorm * 0.19 + exposureNorm * 0.04 + airBonus) * duckMul;
    const targetWindFreq = 240 + speedNorm * 1050 + (snap.grounded ? 0 : 240);
    this.windGain.gain.setTargetAtTime(targetWindVol, now, 0.05);
    this.windFilter.frequency.setTargetAtTime(targetWindFreq, now, 0.06);

    // Scree gravel surf / snow slide hiss
    let slideVol = 0;
    let slideFreq = 1800;
    if (snap.grounded && snap.speed > 5) {
      if (snap.surface === SurfaceType.Scree) {
        slideVol = Math.min(0.28, (snap.speed / 30) * 0.24);
        slideFreq = 1600 + speedNorm * 1400;
      } else if (snap.surface === SurfaceType.Snow) {
        slideVol = Math.min(0.2, (snap.speed / 30) * 0.18);
        slideFreq = 2600 + speedNorm * 1500;
      } else if (Math.abs(snap.steerAngle) > 0.45 && snap.speed > 14) {
        slideVol = 0.08 * speedNorm;
        slideFreq = 2200;
      }
    }
    this.slideGain.gain.setTargetAtTime(slideVol, now, 0.05);
    this.slideFilter.frequency.setTargetAtTime(slideFreq, now, 0.05);
  }

  /** Crisp material-aware hoof-clack impulse triggered directly by IK footfalls! */
  public playHoofClack(surface: SurfaceType, intensity: number): void {
    if (!this.initialized || !this.ctx || !this.noiseBuffer || !this.masterGain) return;
    const now = this.ctx.currentTime;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();

    const rand = 0.86 + Math.random() * 0.28;
    let duration = 0.045;

    switch (surface) {
      case SurfaceType.Granite:
        // Sharp limestone clack-clack-clack!
        filter.type = 'bandpass';
        filter.frequency.value = 1750 * rand;
        filter.Q.value = 4.2;
        duration = 0.038;
        break;
      case SurfaceType.Scree:
        // Gritty crunching gravel clatter
        filter.type = 'bandpass';
        filter.frequency.value = 1150 * rand;
        filter.Q.value = 1.6;
        duration = 0.07;
        break;
      case SurfaceType.Snow:
        // Crisp muffled snow crunch
        filter.type = 'lowpass';
        filter.frequency.value = 780 * rand;
        duration = 0.065;
        break;
      case SurfaceType.Turf:
        filter.type = 'lowpass';
        filter.frequency.value = 540 * rand;
        duration = 0.055;
        break;
    }

    const vol = Math.min(0.45, intensity * (surface === SurfaceType.Granite ? 0.36 : 0.24));
    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);

    src.start(now, Math.random() * 1.2, duration + 0.01);
  }

  public playJump(charge: number): void {
    if (!this.initialized || !this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(140 + charge * 60, now);
    osc.frequency.exponentialRampToValueAtTime(340 + charge * 140, now + 0.12);
    gain.gain.setValueAtTime(0.16, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.15);
  }

  public playLanding(impactSpeed: number, pumped: boolean): void {
    if (!this.initialized || !this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    const strength = Math.min(1, impactSpeed / 22);
    osc.frequency.setValueAtTime(115, now);
    osc.frequency.exponentialRampToValueAtTime(38, now + 0.14);
    gain.gain.setValueAtTime(0.18 + strength * 0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.17);

    // Satisfying shimmering pitch-up rush when hitting a clean Slope-Pump boost!
    if (pumped) {
      const boostOsc = this.ctx.createOscillator();
      const boostGain = this.ctx.createGain();
      boostOsc.type = 'sawtooth';
      const filt = this.ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 1200;
      boostOsc.frequency.setValueAtTime(220, now);
      boostOsc.frequency.exponentialRampToValueAtTime(520, now + 0.22);
      boostGain.gain.setValueAtTime(0.11, now);
      boostGain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
      boostOsc.connect(filt);
      filt.connect(boostGain);
      boostGain.connect(this.masterGain);
      boostOsc.start(now);
      boostOsc.stop(now + 0.25);
    }
  }

  /** Crisp celebratory arpeggio + punch when stomping a mid-air flip or 360 spin! */
  public playTrickStomp(tier: number): void {
    if (!this.initialized || !this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const notes = tier >= 2 ? [523.25, 659.25, 783.99, 1046.5] : [440, 587.33, 880];
    notes.forEach((freq, idx) => {
      if (!this.ctx || !this.masterGain) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      const t0 = now + idx * 0.045;
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.16, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.2);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t0);
      osc.stop(t0 + 0.22);
    });
  }

  public playCheckpoint(isFinish: boolean, ahead: boolean): void {
    if (!this.initialized || !this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const notes = isFinish
      ? [523.25, 659.25, 783.99, 1046.5]
      : ahead
        ? [587.33, 880]
        : [493.88, 659.25];

    notes.forEach((freq, idx) => {
      if (!this.ctx || !this.masterGain) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      const t0 = now + idx * 0.065;
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.14, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t0);
      osc.stop(t0 + 0.24);
    });
  }

  /** Cheeky, unmistakable dual-formant goat bleat ("MAAA-AAA-AH!") that cuts cleanly over wind */
  public playBleat(pitchMul = 1.0, volumeMul = 1.0): void {
    if (!this.initialized || !this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    this.windDuckUntil = Math.max(this.windDuckUntil, now + 0.55);

    const osc = this.ctx.createOscillator();
    const subOsc = this.ctx.createOscillator();
    const vibrato = this.ctx.createOscillator();
    const vibGain = this.ctx.createGain();
    const f1 = this.ctx.createBiquadFilter();
    const f2 = this.ctx.createBiquadFilter();
    const env = this.ctx.createGain();

    // Dual-oscillator vocal cord source (sawtooth + nasal square harmonic)
    const basePitch = (295 + Math.random() * 50) * pitchMul;
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(basePitch, now);
    osc.frequency.linearRampToValueAtTime(basePitch * 1.14, now + 0.13);
    osc.frequency.exponentialRampToValueAtTime(basePitch * 0.78, now + 0.44);

    subOsc.type = 'triangle';
    subOsc.frequency.setValueAtTime(basePitch * 0.5, now);
    subOsc.frequency.linearRampToValueAtTime(basePitch * 0.56, now + 0.13);
    subOsc.frequency.exponentialRampToValueAtTime(basePitch * 0.4, now + 0.44);

    // Classic rapid goat vocal wobble (~22 Hz FM + subtle AM tremolo!)
    vibrato.frequency.value = 21 + Math.random() * 4;
    vibGain.gain.value = 28 * pitchMul;
    vibrato.connect(vibGain);
    vibGain.connect(osc.frequency);

    // Parallel dual vocal-tract formants (preserves full vocal loudness instead of attenuating!)
    f1.type = 'peaking';
    f1.frequency.setValueAtTime(760 * pitchMul, now);
    f1.frequency.linearRampToValueAtTime(1020 * pitchMul, now + 0.15);
    f1.frequency.linearRampToValueAtTime(680 * pitchMul, now + 0.44);
    f1.Q.value = 2.4;
    f1.gain.value = 10;

    f2.type = 'lowpass';
    f2.frequency.setValueAtTime(2400 * pitchMul, now);
    f2.Q.value = 2.2;

    const peak = Math.min(0.95, 0.52 * volumeMul);
    env.gain.setValueAtTime(0.001, now);
    env.gain.linearRampToValueAtTime(peak, now + 0.03);
    env.gain.setValueAtTime(peak * 0.88, now + 0.28);
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.46);

    osc.connect(f1);
    subOsc.connect(f1);
    f1.connect(f2);
    f2.connect(env);
    env.connect(this.masterGain);

    osc.start(now);
    subOsc.start(now);
    vibrato.start(now);
    osc.stop(now + 0.48);
    subOsc.stop(now + 0.48);
    vibrato.stop(now + 0.48);
  }

  /** Heroic, loud echoing mountain-canyon Apex Bleat ("BAAA-AA-AA!") with alpine echoes */
  public playApexBleat(): void {
    if (!this.initialized || !this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    this.windDuckUntil = Math.max(this.windDuckUntil, now + 1.05);

    const osc = this.ctx.createOscillator();
    const subOsc = this.ctx.createOscillator();
    const vibrato = this.ctx.createOscillator();
    const vibGain = this.ctx.createGain();
    const f1 = this.ctx.createBiquadFilter();
    const f2 = this.ctx.createBiquadFilter();
    const dryGain = this.ctx.createGain();

    const base = 340 + Math.random() * 40;
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(base, now);
    osc.frequency.linearRampToValueAtTime(base * 1.24, now + 0.16);
    osc.frequency.exponentialRampToValueAtTime(base * 0.84, now + 0.58);

    subOsc.type = 'triangle';
    subOsc.frequency.setValueAtTime(base * 0.5, now);
    subOsc.frequency.linearRampToValueAtTime(base * 0.62, now + 0.16);
    subOsc.frequency.exponentialRampToValueAtTime(base * 0.42, now + 0.58);

    vibrato.frequency.value = 24;
    vibGain.gain.value = 34;
    vibrato.connect(vibGain);
    vibGain.connect(osc.frequency);

    f1.type = 'peaking';
    f1.frequency.setValueAtTime(920, now);
    f1.frequency.linearRampToValueAtTime(1420, now + 0.18);
    f1.frequency.linearRampToValueAtTime(840, now + 0.58);
    f1.Q.value = 2.6;
    f1.gain.value = 12;

    f2.type = 'lowpass';
    f2.frequency.setValueAtTime(2800, now);
    f2.Q.value = 2.0;

    dryGain.gain.setValueAtTime(0.001, now);
    dryGain.gain.linearRampToValueAtTime(0.68, now + 0.03);
    dryGain.gain.setValueAtTime(0.6, now + 0.36);
    dryGain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

    osc.connect(f1);
    subOsc.connect(f1);
    f1.connect(f2);
    f2.connect(dryGain);
    dryGain.connect(this.masterGain);

    // 3-tap alpine canyon slapback echoes!
    const echoTimes = [0.24, 0.52, 0.82];
    const echoGains = [0.46, 0.25, 0.12];
    for (let i = 0; i < echoTimes.length; i++) {
      const delay = this.ctx.createDelay(1.2);
      delay.delayTime.value = echoTimes[i];
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1800 - i * 420;
      const eGain = this.ctx.createGain();
      eGain.gain.value = echoGains[i];
      dryGain.connect(delay);
      delay.connect(lp);
      lp.connect(eGain);
      eGain.connect(this.masterGain);
    }

    osc.start(now);
    subOsc.start(now);
    vibrato.start(now);
    osc.stop(now + 0.62);
    subOsc.stop(now + 0.62);
    vibrato.stop(now + 0.62);
  }

  /** Snappy horn-lunge whoosh when initiating a Headbutt Ram */
  public playHeadbuttSwing(): void {
    if (!this.initialized || !this.ctx || !this.noiseBuffer || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(340, now);
    filt.frequency.exponentialRampToValueAtTime(1100, now + 0.12);
    filt.Q.value = 2.0;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    src.connect(filt);
    filt.connect(gain);
    gain.connect(this.masterGain);
    src.start(now, Math.random(), 0.18);
  }

  /** Meaty horn-crack + sub-bass punch + startled victim bleat when ramming a rival goat! */
  public playHeadbuttHit(): void {
    if (!this.initialized || !this.ctx || !this.noiseBuffer || !this.masterGain) return;
    const now = this.ctx.currentTime;

    // 1. Deep punchy sub-bass thump
    const sub = this.ctx.createOscillator();
    const subGain = this.ctx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(175, now);
    sub.frequency.exponentialRampToValueAtTime(42, now + 0.16);
    subGain.gain.setValueAtTime(0.42, now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    sub.connect(subGain);
    subGain.connect(this.masterGain);
    sub.start(now);
    sub.stop(now + 0.19);

    // 2. Crisp horn-clack crack
    const crack = this.ctx.createBufferSource();
    crack.buffer = this.noiseBuffer;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = 2100;
    filt.Q.value = 2.8;
    const cGain = this.ctx.createGain();
    cGain.gain.setValueAtTime(0.38, now);
    cGain.gain.exponentialRampToValueAtTime(0.001, now + 0.075);
    crack.connect(filt);
    filt.connect(cGain);
    cGain.connect(this.masterGain);
    crack.start(now, Math.random(), 0.09);

    // 3. Outraged higher-pitched victim goat bleat!
    window.setTimeout(() => {
      this.playBleat(1.28 + Math.random() * 0.18);
    }, 35);
  }
}
