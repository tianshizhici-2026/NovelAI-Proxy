export const RESOLUTIONS = {
  portrait: { name: '竖图', width: 832, height: 1216, ratio: '2:3' },
  landscape: { name: '横图', width: 1216, height: 832, ratio: '3:2' },
  square: { name: '方图', width: 1024, height: 1024, ratio: '1:1' },
} as const;
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
};
export type HistoryEntry = {
  id: string;
  createdAt: number;
  blob: Blob;
  settings: Settings;
  mode: GenerationMode;
};
export const DEFAULT_SETTINGS: Settings = {
  prompt: '', negativePrompt: '', qualityTags: true, defaultNegative: true,
  resolution: 'portrait', steps: 23, guidance: 7,
  characters: [], useCoords: false, strength: 0.55, noise: 0.2,
};
