import { NaturalLanguageService, NlEngine } from './natural-language.service';
import {
  CommandRegistry,
  registerDefaultCommands,
} from 'phoenix-event-display';

/** Build a real registry over a recording host so execute() truly runs. */
function makeRegistry() {
  const calls: any = {
    setDarkTheme: jest.fn(),
    nextEvent: jest.fn(),
    setAutoRotate: jest.fn(),
    emit: jest.fn(),
  };
  const host: any = {
    eventDisplay: {
      nextEvent: calls.nextEvent,
      previousEvent: jest.fn(),
      loadEvent: jest.fn(),
      zoomTo: jest.fn(),
      highlightObject: jest.fn(),
      lookAtObject: jest.fn(),
      getCollections: jest.fn(() => ({ Tracks: [{}], Hits: [{}] })),
      getCollection: jest.fn(() => [{ uuid: 'u0' }]),
      getCurrentEventKey: jest.fn(() => 'e1'),
      getEventMetadata: jest.fn(() => [{}]),
    },
    ui: {
      setDarkTheme: calls.setDarkTheme,
      setAutoRotate: calls.setAutoRotate,
      setClipping: jest.fn(),
      setShowAxis: jest.fn(),
      geometryVisibility: jest.fn(),
      getPresetViews: jest.fn(() => [{ name: 'Front' }]),
      displayView: jest.fn(),
    },
    three: { revertMainCamera: jest.fn() },
    state: {},
    emit: calls.emit,
    resolveObject: jest.fn((_c: string, i: number) =>
      i === 0 ? { uuid: 'u0' } : undefined,
    ),
    listGeometryParts: () => ['LAr Barrel'],
  };
  const registry = new CommandRegistry(host);
  registerDefaultCommands(registry);
  return { registry, calls };
}

function makeService(registry: CommandRegistry) {
  const eventDisplay: any = {
    getCommandRegistry: () => registry,
    getCollections: () => ({ Tracks: [{}], Hits: [{}] }),
    getUIManager: () => ({ getPresetViews: () => [{ name: 'Front' }] }),
    getEventsData: () => ({ e1: {}, e2: {} }),
  };
  return new NaturalLanguageService(eventDisplay);
}

describe('NaturalLanguageService (fallback path, no model)', () => {
  it('runs a keyword-mapped command end-to-end through the registry', async () => {
    const { registry, calls } = makeRegistry();
    const svc = makeService(registry);
    const out = await svc.ask('switch to dark theme');
    expect(out.ok).toBe(true);
    expect(out.command).toBe('set-theme');
    expect(out.usedFallback).toBe(true);
    expect(calls.setDarkTheme).toHaveBeenCalledWith(true);
  });

  it('interpret() maps a request WITHOUT executing it (side-effect-free dry run)', async () => {
    const { registry, calls } = makeRegistry();
    const svc = makeService(registry);
    const out = await svc.interpret('switch to dark theme');
    expect(out.ok).toBe(true);
    expect(out.command).toBe('set-theme');
    expect(out.usedFallback).toBe(true);
    expect(calls.setDarkTheme).not.toHaveBeenCalled();
  });

  it('reports a no-match (without firing anything) for an unmappable request', async () => {
    const { registry, calls } = makeRegistry();
    const svc = makeService(registry);
    const out = await svc.ask('make me a sandwich');
    expect(out.ok).toBe(false);
    expect(out.none).toBe(true);
    expect(calls.setDarkTheme).not.toHaveBeenCalled();
    expect(calls.nextEvent).not.toHaveBeenCalled();
  });
});

describe('NaturalLanguageService (model path)', () => {
  it('uses the engine when one is set, and executes its interpreted command', async () => {
    const { registry, calls } = makeRegistry();
    const svc = makeService(registry);
    const engine: NlEngine = {
      interpret: jest.fn(async () => ({ command: 'next-event', args: {} })),
    };
    svc.setEngine(engine);
    const out = await svc.ask('go forward one event');
    expect(engine.interpret).toHaveBeenCalled();
    expect(out.ok).toBe(true);
    expect(out.command).toBe('next-event');
    expect(out.usedFallback).toBe(false);
    expect(calls.nextEvent).toHaveBeenCalled();
  });

  it('passes a constrained schema + system prompt (mentioning commands) to the engine', async () => {
    const { registry } = makeRegistry();
    const svc = makeService(registry);
    const interpret = jest.fn(async () => ({ command: 'none', args: {} }));
    svc.setEngine({ interpret });
    await svc.ask('do something');
    const [, schema, prompt] = interpret.mock.calls[0];
    expect(JSON.parse(schema).oneOf.length).toBeGreaterThan(1);
    expect(prompt).toContain('set-theme');
  });

  it('resolves live enumSource values into the schema (collections become concrete)', async () => {
    const { registry } = makeRegistry();
    const svc = makeService(registry);
    const interpret = jest.fn(async () => ({ command: 'none', args: {} }));
    svc.setEngine({ interpret });
    await svc.ask('highlight a track');
    const schema = JSON.parse(interpret.mock.calls[0][1]);
    const hi = schema.oneOf.find(
      (b: any) => b.properties.command.const === 'highlight-object',
    );
    expect(hi.properties.args.properties.collection.enum).toEqual([
      'Tracks',
      'Hits',
    ]);
  });

  it('falls back to keyword mapping when the engine throws', async () => {
    const { registry, calls } = makeRegistry();
    const svc = makeService(registry);
    svc.setEngine({
      interpret: jest.fn(async () => {
        throw new Error('model boom');
      }),
    });
    const out = await svc.ask('dark theme');
    expect(out.ok).toBe(true);
    expect(out.usedFallback).toBe(true);
    expect(calls.setDarkTheme).toHaveBeenCalledWith(true);
  });

  it('rejects an engine-proposed command that is not registered (never executes it)', async () => {
    const { registry, calls } = makeRegistry();
    const svc = makeService(registry);
    svc.setEngine({
      interpret: jest.fn(async () => ({ command: 'delete-all', args: {} })),
    });
    const out = await svc.ask('delete everything');
    expect(out.ok).toBe(false);
    expect(calls.nextEvent).not.toHaveBeenCalled();
    expect(calls.setDarkTheme).not.toHaveBeenCalled();
  });

  it('rejects engine output with invalid args (type mismatch)', async () => {
    const { registry, calls } = makeRegistry();
    const svc = makeService(registry);
    svc.setEngine({
      interpret: jest.fn(async () => ({
        command: 'set-theme',
        args: { dark: 'yes' },
      })),
    });
    const out = await svc.ask('theme');
    expect(out.ok).toBe(false);
    expect(calls.setDarkTheme).not.toHaveBeenCalled();
  });
});

describe('NaturalLanguageService (WebGPU support)', () => {
  it('reflects navigator.gpu availability', () => {
    const { registry } = makeRegistry();
    const svc = makeService(registry);
    const original = (navigator as any).gpu;
    (navigator as any).gpu = {};
    expect(svc.isSupported()).toBe(true);
    (navigator as any).gpu = undefined;
    expect(svc.isSupported()).toBe(false);
    (navigator as any).gpu = original;
  });
});

describe('NaturalLanguageService (model availability + opt-in)', () => {
  const eventDisplay: any = {
    getCommandRegistry: () => makeRegistry().registry,
  };

  it('is not model-available without an engine factory (fallback only)', () => {
    const svc = new NaturalLanguageService(eventDisplay, null);
    (navigator as any).gpu = {};
    expect(svc.isModelAvailable()).toBe(false);
  });

  it('is model-available only with BOTH a factory and WebGPU', () => {
    const factory = jest.fn();
    const svc = new NaturalLanguageService(eventDisplay, factory as any);
    const original = (navigator as any).gpu;
    (navigator as any).gpu = {};
    expect(svc.isModelAvailable()).toBe(true);
    (navigator as any).gpu = undefined;
    expect(svc.isModelAvailable()).toBe(false);
    (navigator as any).gpu = original;
  });

  it('enableModel loads the engine via the provided factory (adapter present)', async () => {
    const engine: NlEngine = { interpret: jest.fn(async () => ({})) };
    const factory = jest.fn(async () => engine);
    const svc = new NaturalLanguageService(eventDisplay, factory);
    const original = (navigator as any).gpu;
    (navigator as any).gpu = { requestAdapter: async () => ({}) };
    await svc.enableModel();
    expect(factory).toHaveBeenCalled();
    expect(svc.hasEngine).toBe(true);
    expect(svc.status).toBe('ready');
    (navigator as any).gpu = original;
  });

  it('enableModel fails fast (no download) when there is no WebGPU adapter', async () => {
    const factory = jest.fn(async () => ({ interpret: jest.fn() }));
    const svc = new NaturalLanguageService(eventDisplay, factory);
    const original = (navigator as any).gpu;
    (navigator as any).gpu = { requestAdapter: async () => null };
    await svc.enableModel();
    expect(factory).not.toHaveBeenCalled();
    expect(svc.hasEngine).toBe(false);
    expect(svc.status).toBe('error');
    (navigator as any).gpu = original;
  });

  it('enableModel is a no-op when no factory was provided', async () => {
    const svc = new NaturalLanguageService(eventDisplay, null);
    await svc.enableModel();
    expect(svc.hasEngine).toBe(false);
  });
});
