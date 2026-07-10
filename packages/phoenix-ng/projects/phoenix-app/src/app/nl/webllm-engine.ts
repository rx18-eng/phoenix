import { parseIntentJson } from 'phoenix-event-display';
import type { NlEngine } from 'phoenix-ui-components';

/**
 * Default in-browser model for natural-language command mapping. A tiny
 * instruct model is enough because constrained decoding (the schema grammar)
 * does the structural heavy lifting; the model only has to pick intent.
 */
export const DEFAULT_NL_MODEL = 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC';

/**
 * Whether this browser can actually run WebLLM: WebGPU must be present AND
 * expose an adapter. Feature-detects without importing the (heavy) engine.
 * @returns True when a WebGPU adapter is available.
 */
export async function isWebGpuAvailable(): Promise<boolean> {
  const gpu = (navigator as any)?.gpu;
  if (!gpu) return false;
  try {
    return !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

/** The minimal shape of a WebLLM engine this wrapper uses. */
export interface WebLlmChatEngine {
  chat: {
    completions: {
      create(opts: any): Promise<any>;
    };
  };
}

/**
 * Adapts a WebLLM engine to the `NlEngine` interface the natural-language
 * service consumes. Uses WebLLM's constrained-decoding JSON mode
 * (`response_format: { type: 'json_object', schema }`, XGrammar-backed) so the
 * output is guaranteed to match the command schema, then defensively parses it.
 */
export class WebLlmEngine implements NlEngine {
  /**
   * @param engine A ready WebLLM engine (main-thread or web-worker backed).
   */
  constructor(private engine: WebLlmChatEngine) {}

  /**
   * Interpret a request into a constrained intent JSON object.
   * @param text The user's request.
   * @param schema Stringified JSON schema constraining the output.
   * @param systemPrompt The system prompt listing the commands.
   * @returns The parsed `{command, args}` object (or null if unparseable).
   */
  async interpret(
    text: string,
    schema: string,
    systemPrompt: string,
  ): Promise<unknown> {
    const reply = await this.engine.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
      response_format: { type: 'json_object', schema },
      temperature: 0,
      max_tokens: 256,
    });
    const content = reply?.choices?.[0]?.message?.content ?? '';
    return parseIntentJson(content);
  }
}
