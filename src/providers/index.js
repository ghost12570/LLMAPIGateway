import { openaiAdapter } from './openai.js';
import { anthropicAdapter } from './anthropic.js';

const OPENAI_COMPATIBLE = new Set(['openai', 'azure', 'deepseek', 'dashscope', 'custom']);

export function getAdapter(provider) {
  if (provider === 'anthropic') return anthropicAdapter;
  if (OPENAI_COMPATIBLE.has(provider)) return openaiAdapter;
  throw new Error(`Unsupported provider: ${provider}`);
}

export function isOpenAICompatible(provider) {
  return OPENAI_COMPATIBLE.has(provider);
}

export const PROVIDER_IDS = ['openai', 'azure', 'anthropic', 'deepseek', 'dashscope', 'custom'];
export const EMBEDDING_PROVIDERS = new Set([...OPENAI_COMPATIBLE]);
