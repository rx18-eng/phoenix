import type {
  NlEngine,
  NlEngineFactory,
  NlProgress,
} from 'phoenix-ui-components';
import { DEFAULT_NL_MODEL, WebLlmEngine } from './webllm-engine';

/**
 * Build the natural-language engine factory the app provides to the library
 * through `NL_ENGINE_FACTORY` (#942, Phase 3). WebLLM is loaded with a dynamic
 * `import()` so it (and the model runtime) is a lazy chunk kept OUT of the
 * initial bundle; the model runs in a web worker (off the render thread) and
 * its weights are fetched from the CDN at runtime and cached by the browser.
 * The reusable library never depends on WebLLM: this wiring lives in the app.
 * @param modelId The WebLLM model id to load (defaults to a small model).
 * @returns A factory that lazily loads and returns a ready engine.
 */
export function createWebLlmEngineFactory(
  modelId: string = DEFAULT_NL_MODEL,
): NlEngineFactory {
  return async (onProgress: (p: NlProgress) => void): Promise<NlEngine> => {
    const webllm = await import('@mlc-ai/web-llm');
    const worker = new Worker(new URL('./webllm.worker', import.meta.url), {
      type: 'module',
    });
    const engine = await webllm.CreateWebWorkerMLCEngine(worker, modelId, {
      initProgressCallback: (report: { progress?: number; text?: string }) =>
        onProgress({
          progress: report?.progress ?? 0,
          text: report?.text ?? '',
        }),
    });
    return new WebLlmEngine(engine);
  };
}
