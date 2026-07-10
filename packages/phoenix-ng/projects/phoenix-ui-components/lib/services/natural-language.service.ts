import { Inject, Injectable, InjectionToken, Optional } from '@angular/core';
import {
  buildIntentSchema,
  buildSystemPrompt,
  keywordFallback,
  validateIntent,
  type EnumSources,
} from 'phoenix-event-display';
import { EventDisplayService } from './event-display.service';

/** Model-loading progress (0..1) with a human-readable label. */
export interface NlProgress {
  /** Fraction complete, 0..1. */
  progress: number;
  /** Status text from the engine (e.g. "Fetching param cache[3/50]"). */
  text: string;
}

/**
 * A natural-language engine: turns a user request into a parsed intent object,
 * constrained by the given JSON schema. Implemented by the lazy WebLLM wrapper;
 * the service depends only on this interface so it stays testable and never
 * imports the heavy engine.
 */
export interface NlEngine {
  /**
   * @param text The user's request.
   * @param schema Stringified JSON schema constraining the output.
   * @param systemPrompt The system prompt listing the commands.
   * @returns The parsed model output (expected `{command, args}`).
   */
  interpret(
    text: string,
    schema: string,
    systemPrompt: string,
  ): Promise<unknown>;
}

/** An async factory that loads an engine, reporting progress. */
export type NlEngineFactory = (
  onProgress: (p: NlProgress) => void,
) => Promise<NlEngine>;

/**
 * Optional DI token an application provides to supply an in-browser model
 * engine (the WebLLM wrapper). The reusable library never imports the heavy
 * engine; when no factory is provided the natural-language feature runs on the
 * deterministic keyword fallback only.
 */
export const NL_ENGINE_FACTORY = new InjectionToken<NlEngineFactory>(
  'phoenix.nl-engine-factory',
);

/** Lifecycle status of the natural-language service. */
export type NlStatus = 'idle' | 'loading' | 'ready' | 'thinking' | 'error';

/** Outcome of an `ask()` call. */
export interface NlOutcome {
  /** True when a command ran successfully. */
  ok: boolean;
  /** The command that ran (or was proposed). */
  command?: string;
  /** The arguments used. */
  args?: Record<string, any>;
  /** The command's return value, if any. */
  result?: any;
  /** Error message when not ok. */
  error?: string;
  /** True when nothing matched (an honest "I didn't understand"). */
  none?: boolean;
  /** True when the deterministic keyword path handled it (no model). */
  usedFallback?: boolean;
}

/**
 * Orchestrates natural-language control of Phoenix (#942, Phase 3): resolves the
 * command registry into a constrained schema, routes a request to either the
 * in-browser model (when loaded) or the deterministic keyword fallback,
 * validates the proposed intent, and runs it through the SAME
 * `registry.execute()` path the command palette uses. Physics-safe by
 * construction: only registered, schema-validated commands can ever run.
 */
@Injectable({ providedIn: 'root' })
export class NaturalLanguageService {
  /** Current lifecycle status (read by the UI). */
  status: NlStatus = 'idle';
  /** Latest model-load progress (while status === 'loading'). */
  progress: NlProgress = { progress: 0, text: '' };
  /** Last error message, if any. */
  lastError = '';

  /** The loaded engine, or null when running on the keyword fallback. */
  private engine: NlEngine | null = null;

  /**
   * @param eventDisplay The Phoenix event display service (registry + live data).
   * @param engineFactory Optional app-provided factory for the in-browser model.
   */
  constructor(
    private eventDisplay: EventDisplayService,
    @Optional()
    @Inject(NL_ENGINE_FACTORY)
    private engineFactory: NlEngineFactory | null = null,
  ) {}

  /** Whether this browser can run the in-browser model (needs WebGPU). */
  isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!(navigator as any).gpu;
  }

  /**
   * Whether an in-browser model can be offered: the app supplied an engine
   * factory AND this browser supports WebGPU. When false, the feature still
   * works via the keyword fallback.
   */
  isModelAvailable(): boolean {
    return !!this.engineFactory && this.isSupported();
  }

  /**
   * Whether a real WebGPU adapter is available. `navigator.gpu` can exist with
   * no usable adapter (e.g. software-only or blocked GPUs), so this asks for
   * one. Used to fail fast before a large model download that would only error.
   * @returns True when an adapter can be acquired.
   */
  private async hasWebGpuAdapter(): Promise<boolean> {
    const gpu = (navigator as any)?.gpu;
    if (!gpu) return false;
    try {
      return !!(await gpu.requestAdapter());
    } catch {
      return false;
    }
  }

  /**
   * Opt in to the in-browser model: lazily load it via the app-provided
   * factory. Fails fast (without downloading anything) when there is no usable
   * WebGPU adapter, leaving the keyword fallback in effect. No-op when no
   * factory was provided.
   */
  async enableModel(): Promise<void> {
    if (!this.engineFactory) return;
    if (!(await this.hasWebGpuAdapter())) {
      this.status = 'error';
      this.lastError =
        'No usable WebGPU adapter on this device; using keyword matching.';
      return;
    }
    await this.loadEngine(this.engineFactory);
  }

  /** Whether a model engine is currently loaded. */
  get hasEngine(): boolean {
    return this.engine !== null;
  }

  /**
   * Inject an engine directly (used by tests and the UI once loaded).
   * @param engine The engine to use, or null to revert to the fallback.
   */
  setEngine(engine: NlEngine | null): void {
    this.engine = engine;
    this.status = engine ? 'ready' : 'idle';
  }

  /**
   * Lazily load an engine via the given factory, tracking progress/status.
   * The factory (the WebLLM wrapper) is passed in so this service never imports
   * the heavy engine and stays out of the static bundle.
   * @param factory Async factory that builds an engine.
   */
  async loadEngine(factory: NlEngineFactory): Promise<void> {
    if (this.engine) return;
    this.status = 'loading';
    this.lastError = '';
    this.progress = { progress: 0, text: 'Starting…' };
    try {
      const engine = await factory((p) => (this.progress = p));
      this.engine = engine;
      this.status = 'ready';
    } catch (e) {
      this.status = 'error';
      this.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  /**
   * Interpret and run a natural-language request. Uses the loaded model when
   * present (constrained decoding), otherwise the deterministic keyword
   * fallback; on model error it degrades to the fallback rather than failing.
   * The proposed command is always validated against the registry before it
   * runs, so an unregistered or malformed action can never fire.
   * @param text The user's request.
   * @returns The outcome (ran / no-match / error), with which path was used.
   */
  async ask(text: string): Promise<NlOutcome> {
    const registry = this.eventDisplay.getCommandRegistry();
    const tools = registry.toToolSchemas();
    let parsed: unknown = null;
    let usedFallback = false;

    if (this.engine) {
      const enums = this.resolveEnums();
      const schema = buildIntentSchema(tools, enums);
      const prompt = buildSystemPrompt(tools, enums);
      this.status = 'thinking';
      try {
        parsed = await this.engine.interpret(text, schema, prompt);
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        parsed = keywordFallback(text);
        usedFallback = true;
      }
      this.status = 'ready';
    } else {
      parsed = keywordFallback(text);
      usedFallback = true;
    }

    if (parsed === null || parsed === undefined) {
      return {
        ok: false,
        none: true,
        usedFallback,
        error: 'Sorry, I could not map that to a command.',
      };
    }

    const intent = validateIntent(parsed, registry);
    if (!intent.ok) {
      const failed = intent as { error: string; none?: boolean };
      return {
        ok: false,
        none: failed.none,
        usedFallback,
        error: failed.none
          ? 'Sorry, I could not map that to a command.'
          : failed.error,
      };
    }

    const res = await registry.execute(intent.command, intent.args);
    if (!res.ok) {
      const failed = res as { ok: false; error: string };
      return {
        ok: false,
        command: intent.command,
        args: intent.args,
        usedFallback,
        error: failed.error,
      };
    }
    return {
      ok: true,
      command: intent.command,
      args: intent.args,
      result: res.result,
      usedFallback,
    };
  }

  /**
   * Resolve live values for `enumSource` parameters so the model is constrained
   * to real collection names, preset views and event keys. Best-effort: any
   * source that is unavailable is simply left unconstrained (validated later).
   * @returns The resolved enum sources.
   */
  private resolveEnums(): EnumSources {
    const ed = this.eventDisplay as any;
    const enums: EnumSources = {};
    try {
      const collections = ed.getCollections?.();
      if (collections) enums.collections = Object.keys(collections);
    } catch {
      /* leave unconstrained */
    }
    try {
      const views = ed.getUIManager?.()?.getPresetViews?.();
      if (views) enums.presetViews = views.map((v: any) => v.name);
    } catch {
      /* leave unconstrained */
    }
    try {
      const events = ed.getEventsData?.();
      if (events) enums.eventKeys = Object.keys(events);
    } catch {
      /* leave unconstrained */
    }
    try {
      // Real detector-geometry part names (top two levels of the live scene
      // tree), so "hide the calorimeter" maps to an actual part. Read live so
      // it stays experiment-agnostic (ATLAS/LHCb/CMS have different parts).
      const geometries = ed
        .getThreeManager?.()
        ?.getSceneManager?.()
        ?.getGeometries?.();
      const children: any[] = geometries?.children ?? [];
      if (children.length) {
        const parts = new Set<string>();
        for (const child of children) {
          if (child?.name) parts.add(child.name);
          for (const grandChild of child?.children ?? []) {
            if (grandChild?.name) parts.add(grandChild.name);
          }
        }
        if (parts.size) enums.geometryParts = [...parts].slice(0, 60);
      }
    } catch {
      /* leave unconstrained */
    }
    return enums;
  }
}
