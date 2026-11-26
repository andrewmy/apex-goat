export type ScenePresetId = 'morning' | 'noon' | 'alpenglow' | 'squall';

export interface ScenePreset {
  id: ScenePresetId;
  label: string;
  shortLabel: string;
  clock: string;
  icon: string;
  swatch: string;
  sceneBg: number;
  skyTop: number;
  skyMid: number;
  skyHorizon: number;
  sunHaloColor: number;
  sunHaloStrength: number;
  sunOffset: readonly [number, number, number];
  sunColor: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  fogColor: number;
  fogDensity: number;
  exposure: number;
  snowIntensity: number;
  stormWindIntensity: number;
  beaconGlow: number;
}

export const SCENE_STORAGE_KEY = 'apex-goat-scene-v1';

export const SCENE_PRESETS: readonly ScenePreset[] = [
  {
    id: 'morning',
    label: 'MORNING',
    shortLabel: 'MORNING',
    clock: '08:30',
    icon: '🌅',
    swatch: '#93c9f2',
    sceneBg: 0x7dbbe8,
    skyTop: 0x184b9c,
    skyMid: 0x7dbbe8,
    skyHorizon: 0xe8eef5,
    sunHaloColor: 0xffe9c7,
    sunHaloStrength: 0.95,
    sunOffset: [320, 135, 90],
    sunColor: 0xffe7c2,
    sunIntensity: 2.35,
    hemiSky: 0xcde6ff,
    hemiGround: 0x6b7f99,
    hemiIntensity: 1.05,
    fogColor: 0xb8d7ef,
    fogDensity: 0.00056,
    exposure: 1.06,
    snowIntensity: 0,
    stormWindIntensity: 0,
    beaconGlow: 0.1,
  },
  {
    id: 'noon',
    label: 'HIGH NOON',
    shortLabel: 'NOON',
    clock: '13:30',
    icon: '☀',
    swatch: '#5aa4e6',
    sceneBg: 0x5da4e8,
    skyTop: 0x114494,
    skyMid: 0x5aa4e6,
    skyHorizon: 0xcde5fa,
    sunHaloColor: 0xfff0c7,
    sunHaloStrength: 0.9,
    sunOffset: [210, 270, 135],
    sunColor: 0xfff2da,
    sunIntensity: 2.2,
    hemiSky: 0xc8e4ff,
    hemiGround: 0x8493a6,
    hemiIntensity: 1.2,
    fogColor: 0x8bc0ec,
    fogDensity: 0.00048,
    exposure: 1.08,
    snowIntensity: 0,
    stormWindIntensity: 0,
    beaconGlow: 0,
  },
  {
    id: 'alpenglow',
    label: 'ALPENGLOW',
    shortLabel: 'ALPENGLOW',
    clock: '17:45',
    icon: '🌇',
    swatch: '#f59d6e',
    sceneBg: 0x7e547a,
    skyTop: 0x191f4a,
    skyMid: 0x7e547a,
    skyHorizon: 0xf59d6e,
    sunHaloColor: 0xffa66b,
    sunHaloStrength: 1.08,
    sunOffset: [-280, 95, -240],
    sunColor: 0xff9f68,
    sunIntensity: 2.4,
    hemiSky: 0x9eb2e0,
    hemiGround: 0x564b64,
    hemiIntensity: 1.12,
    fogColor: 0xc48a84,
    fogDensity: 0.00062,
    exposure: 1.02,
    snowIntensity: 0,
    stormWindIntensity: 0.14,
    beaconGlow: 0.6,
  },
  {
    id: 'squall',
    label: 'SQUALL',
    shortLabel: 'SQUALL',
    clock: '14:45',
    icon: '❄',
    swatch: '#9aaab8',
    sceneBg: 0x7d8d9e,
    skyTop: 0x3c4857,
    skyMid: 0x6b7a8c,
    skyHorizon: 0xa7b4c2,
    sunHaloColor: 0xdce7f2,
    sunHaloStrength: 0.22,
    sunOffset: [160, 240, 80],
    sunColor: 0xcfe0f2,
    sunIntensity: 1.15,
    hemiSky: 0xa9bac9,
    hemiGround: 0x5e6975,
    hemiIntensity: 1.35,
    fogColor: 0x98a8b8,
    fogDensity: 0.0022,
    exposure: 0.98,
    snowIntensity: 1,
    stormWindIntensity: 1,
    beaconGlow: 1.0,
  },
];

export function getScenePreset(id: ScenePresetId): ScenePreset {
  return SCENE_PRESETS.find((p) => p.id === id) ?? SCENE_PRESETS[1];
}

export function getNextScenePresetId(current: ScenePresetId): ScenePresetId {
  const idx = SCENE_PRESETS.findIndex((p) => p.id === current);
  return SCENE_PRESETS[(idx + 1) % SCENE_PRESETS.length].id;
}

export function loadSavedScenePresetId(): ScenePresetId {
  try {
    const raw = window.localStorage.getItem(SCENE_STORAGE_KEY);
    if (raw && SCENE_PRESETS.some((p) => p.id === raw)) {
      return raw as ScenePresetId;
    }
  } catch {
    // Ignore storage errors in restricted contexts
  }
  return 'noon';
}
