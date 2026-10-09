export const RESOLUTIONS = {
  portrait: { name: '竖图', width: 832, height: 1216, ratio: '2:3' },
  landscape: { name: '横图', width: 1216, height: 832, ratio: '3:2' },
  square: { name: '方图', width: 1024, height: 1024, ratio: '1:1' },
  largePortrait: { name: '大竖图', width: 1024, height: 1536, ratio: '2:3' },
  largeLandscape: { name: '大横图', width: 1536, height: 1024, ratio: '3:2' },
  largeSquare: { name: '大方图', width: 1472, height: 1472, ratio: '1:1' },
  wallpaperPortrait: { name: '竖屏壁纸', width: 1088, height: 1920, ratio: '9:16' },
  wallpaperLandscape: { name: '横屏壁纸', width: 1920, height: 1088, ratio: '16:9' },
} as const;
export const FREE_RESOLUTIONS = ['portrait', 'landscape', 'square'] as const;
export type Resolution = keyof typeof RESOLUTIONS;
export type Character = {
  id: string;
  name: string;
  prompt: string;
  negativePrompt: string;
  enabled: boolean;
  x: number;
  y: number;
};
export type Settings = {
  effort?: 'high' | 'medium';
  prompt: string;
  negativePrompt: string;
  qualityTags: boolean;
  defaultNegative: boolean;
  resolution: Resolution;
  steps: number;
  guidance: number;
  characters: Character[];
  useCoords: boolean;
  strength: number;
  noise: number;
  seed: number | null;
  useAnlas?: boolean;
  promptModules?: import('./prompts').SelectedPrompt[];
};
export type GenerationMode = 'generate' | 'inpaint' | 'img2img';
export type GenerateInput = Settings & {
  mode: GenerationMode;
  image?: string;
  mask?: string;
};
export type GenerationQueueStatus = { generating: boolean; waiting: number; capacity: number };
export type GenerationJobStatus = GenerationQueueStatus & { state: 'waiting' | 'running'; position: number };
export type ServiceStatus = {
  queue?: GenerationQueueStatus;
  account?: import('./accounts').AccountView;
  configured: boolean;
  ready: boolean;
  message: string;
  usagePercent?: number;
  anlas?: { subscription: number; purchased: number; total: number };
  paidReady?: boolean;
};
export type HistoryEntry = {
  id: string;
  createdAt: number;
  blob: Blob;
  settings: Settings;
  mode: GenerationMode;
  imageWidth?: number;
  imageHeight?: number;
};
export const DEFAULT_SETTINGS: Settings = {
  prompt: '', negativePrompt: '', qualityTags: true, defaultNegative: true,
  resolution: 'portrait', effort: 'high', steps: 23, guidance: 7,
  characters: [], useCoords: false, strength: 0.55, noise: 0.2, seed: null,
};
