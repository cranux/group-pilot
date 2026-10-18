import { DEFAULT_MODEL, createLlmAgent } from './index.js';

const effort = (process.env.LLM_EFFORT ?? 'low') as 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const app = createLlmAgent({ model: process.env.LLM_MODEL ?? DEFAULT_MODEL, effort, logger: process.env.LOG === '1' });
const port = Number(process.env.PORT ?? 4003);
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
console.log(`[llm-agent] listening on :${port} (model ${process.env.LLM_MODEL ?? DEFAULT_MODEL}, effort ${effort})`);
