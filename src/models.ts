/** BAE Systems GenAI model catalog (from internal LLM table). */

export interface CatalogModel {
  name: string;
  urlSlug: string;
  modelName: string;
  context: number;
  modalities: string;
}

export const BAE_HOST = 'https://devmissionassist.api.us.baesystems.com';

export const BAE_MODELS: CatalogModel[] = [
  { name: 'Gemma 4 26B', urlSlug: 'bae-api-gemma4-26B', modelName: '/genai/Gemma-4-26B-A4B', context: 262144, modalities: 'Text, Image' },
  { name: 'Gemma 4 31B', urlSlug: 'bae-api-gemma-4-31B', modelName: '/genai/Gemma-4-31B-IT', context: 262144, modalities: 'Text, Image' },
  { name: 'Gemma 4 E4B', urlSlug: 'bae-api-gemma4-E4B', modelName: '/genai/Gemma-4-E4B', context: 131072, modalities: 'Text, Image, Audio' },
  { name: 'GPT OSS 120B', urlSlug: 'bae-api-gptoss', modelName: '/genai/gpt-oss-120b', context: 131072, modalities: 'Text' },
  { name: 'GPT OSS 20B', urlSlug: 'bae-api-gpt-oss-20B', modelName: '/genai/gpt-oss-20b', context: 131072, modalities: 'Text' },
  { name: 'Granite 4.1 30B', urlSlug: 'bae-api-granite4.1', modelName: '/genai/ibm-granite-4.1-30b', context: 43000, modalities: 'Text' },
  { name: 'Laguna S 2.1', urlSlug: 'bae-laguna', modelName: 'laguna', context: 262144, modalities: 'Text' },
  { name: 'Llama 3.3 70B', urlSlug: 'bae-api-llama', modelName: '/genai/Llama-3.3-70b', context: 90000, modalities: 'Text' },
  { name: 'Llama 4 Scout', urlSlug: 'bae-api-llama4', modelName: '/genai/Llama-4-Scout-17B', context: 400000, modalities: 'Text, Image' },
  { name: 'Microsoft Phi 4', urlSlug: 'bae-api-phi4', modelName: '/genai/microsoft-phi-4', context: 16384, modalities: 'Text' },
  { name: 'Ministral 3 14B', urlSlug: 'bae-api-ministral', modelName: '/genai/Ministral-3-14B-Instruct-2512', context: 150000, modalities: 'Text' },
  { name: 'Muse Glimmer', urlSlug: 'bae-api-Muse-Glimmer-30B', modelName: '/genai/Muse-Glimmer-30B', context: 131072, modalities: 'Text, Image' },
  { name: 'NVIDIA Nemotron 3 Super 120B', urlSlug: 'bae-api-NVIDIA-Nemotron-3-Super-120B', modelName: '/genai/NVIDIA-Nemotron-3-Super-120B-A12B', context: 262144, modalities: 'Text' },
  { name: 'NVIDIA Nemotron Lightning', urlSlug: 'bae-api-Nemotron-3.5-Lightning-30B', modelName: '/genai/Nemotron-3.5-Lightning-30B', context: 262144, modalities: 'Text' },
  { name: 'NVIDIA Omni Nano 30B', urlSlug: 'bae-api-nvidia-omni-nano', modelName: '/genai/Nemotron-3-Nano-Omni-30B-A3B', context: 262144, modalities: 'Text, Image, Audio' },
  { name: 'Snowflake Arctic Text2SQL', urlSlug: 'bae-api-Arctic-Text2SQL-R1-7B', modelName: '/genai/Arctic-Text2SQL-R1-7B', context: 32768, modalities: 'Text' }
];

export function apiBaseFor(slug: string): string {
  return `${BAE_HOST}/${slug}/v1`;
}
