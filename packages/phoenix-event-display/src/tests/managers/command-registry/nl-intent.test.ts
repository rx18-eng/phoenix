import { CommandRegistry } from '../../../managers/command-registry/command-registry';
import { registerDefaultCommands } from '../../../managers/command-registry/default-commands';
import type { CommandHost } from '../../../managers/command-registry/command-host';
import {
  buildIntentSchema,
  buildSystemPrompt,
  validateIntent,
  keywordFallback,
  parseIntentJson,
} from '../../../managers/command-registry/nl-intent';

function reg(): CommandRegistry {
  const r = new CommandRegistry({
    eventDisplay: {},
    ui: {},
    three: {},
    state: {},
    emit: () => undefined,
    resolveObject: () => undefined,
    listGeometryParts: () => [],
  } as unknown as CommandHost);
  registerDefaultCommands(r);
  return r;
}

describe('nl-intent: buildIntentSchema', () => {
  it('produces a JSON string that parses to a oneOf with one branch per command plus a "none" escape', () => {
    const r = reg();
    const tools = r.toToolSchemas();
    const parsed = JSON.parse(buildIntentSchema(tools));
    expect(Array.isArray(parsed.oneOf)).toBe(true);
    // one branch per command + the 'none' branch
    expect(parsed.oneOf.length).toBe(tools.length + 1);
    const consts = parsed.oneOf.map((b: any) => b.properties.command.const);
    for (const t of tools) expect(consts).toContain(t.name);
    expect(consts).toContain('none');
  });

  it('constrains each branch to a fixed command + that command args schema', () => {
    const r = reg();
    const parsed = JSON.parse(buildIntentSchema(r.toToolSchemas()));
    const themeBranch = parsed.oneOf.find(
      (b: any) => b.properties.command.const === 'set-theme',
    );
    expect(themeBranch.required).toEqual(['command', 'args']);
    expect(themeBranch.properties.args.properties.dark.type).toBe('boolean');
  });

  it('resolves enumSource to a concrete enum when live values are supplied', () => {
    const r = reg();
    const parsed = JSON.parse(
      buildIntentSchema(r.toToolSchemas(), {
        collections: ['Tracks', 'Hits'],
      }),
    );
    const hi = parsed.oneOf.find(
      (b: any) => b.properties.command.const === 'highlight-object',
    );
    expect(hi.properties.args.properties.collection.enum).toEqual([
      'Tracks',
      'Hits',
    ]);
    // enumSource is not a JSON-schema keyword and must never leak into the grammar
    expect(hi.properties.args.properties.collection.enumSource).toBeUndefined();
  });

  it('strips enumSource (leaving a plain string) when no live values are supplied', () => {
    const r = reg();
    const parsed = JSON.parse(buildIntentSchema(r.toToolSchemas()));
    const hi = parsed.oneOf.find(
      (b: any) => b.properties.command.const === 'highlight-object',
    );
    expect(hi.properties.args.properties.collection.type).toBe('string');
    expect(hi.properties.args.properties.collection.enumSource).toBeUndefined();
    expect(hi.properties.args.properties.collection.enum).toBeUndefined();
  });
});

describe('nl-intent: buildSystemPrompt', () => {
  it('lists every command name and description and demands JSON with a none escape', () => {
    const r = reg();
    const tools = r.toToolSchemas();
    const prompt = buildSystemPrompt(tools);
    for (const t of tools) {
      expect(prompt).toContain(t.name);
      expect(prompt).toContain(t.description);
    }
    expect(prompt.toLowerCase()).toContain('json');
    expect(prompt).toContain('none');
  });
});

describe('nl-intent: validateIntent', () => {
  it('accepts a well-formed intent for a real command', () => {
    const res = validateIntent(
      { command: 'set-theme', args: { dark: true } },
      reg(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.command).toBe('set-theme');
      expect(res.args).toEqual({ dark: true });
    }
  });

  it('accepts a no-arg command with empty args', () => {
    expect(validateIntent({ command: 'next-event', args: {} }, reg()).ok).toBe(
      true,
    );
  });

  it('treats {command:"none"} as an explicit no-match (not an error to fire)', () => {
    const res = validateIntent({ command: 'none', args: {} }, reg());
    expect(res.ok).toBe(false);
    expect((res as { none?: boolean }).none).toBe(true);
  });

  it('rejects an unknown command', () => {
    expect(
      validateIntent({ command: 'launch-rockets', args: {} }, reg()).ok,
    ).toBe(false);
  });

  it('rejects invalid args (wrong type) so a wrong word cannot fire a bad action', () => {
    const res = validateIntent(
      { command: 'set-theme', args: { dark: 'yes' } },
      reg(),
    );
    expect(res.ok).toBe(false);
  });

  it('rejects malformed input (missing command / not an object)', () => {
    expect(validateIntent(null, reg()).ok).toBe(false);
    expect(validateIntent({ args: {} }, reg()).ok).toBe(false);
    expect(validateIntent('next-event', reg()).ok).toBe(false);
  });

  it('defaults missing args to an empty object', () => {
    expect(validateIntent({ command: 'next-event' }, reg()).ok).toBe(true);
  });
});

describe('nl-intent: keywordFallback (deterministic, no model)', () => {
  const cases: [string, string, Record<string, any>][] = [
    ['next event', 'next-event', {}],
    ['go to the next event please', 'next-event', {}],
    ['previous event', 'previous-event', {}],
    ['dark theme', 'set-theme', { dark: true }],
    ['switch to light mode', 'set-theme', { dark: false }],
    ['auto rotate', 'toggle-auto-rotate', { on: true }],
    ['stop rotating', 'toggle-auto-rotate', { on: false }],
    ['show axis', 'show-axis', { show: true }],
    ['hide the axes', 'show-axis', { show: false }],
    ['zoom in', 'zoom', { direction: 'in' }],
    ['zoom out a bit', 'zoom', { direction: 'out' }],
    ['toggle camera projection', 'toggle-camera-projection', {}],
  ];
  for (const [text, command, args] of cases) {
    it(`maps "${text}" -> ${command}`, () => {
      const intent = keywordFallback(text);
      expect(intent).not.toBeNull();
      expect(intent!.command).toBe(command);
      expect(intent!.args).toEqual(args);
    });
  }

  it('returns null (never guesses) for an unmappable request', () => {
    expect(keywordFallback('make me a sandwich')).toBeNull();
    expect(keywordFallback('')).toBeNull();
  });

  it('every fallback intent it produces validates against the registry', () => {
    const r = reg();
    for (const [text] of cases) {
      const intent = keywordFallback(text)!;
      expect(validateIntent(intent, r).ok).toBe(true);
    }
  });
});

describe('nl-intent: parseIntentJson', () => {
  it('parses pure JSON (the constrained-decoding happy path)', () => {
    expect(parseIntentJson('{"command":"next-event","args":{}}')).toEqual({
      command: 'next-event',
      args: {},
    });
  });

  it('extracts the JSON object from markdown fences / surrounding prose', () => {
    const fenced = '```json\n{"command":"set-theme","args":{"dark":true}}\n```';
    expect(parseIntentJson(fenced)).toEqual({
      command: 'set-theme',
      args: { dark: true },
    });
    const prose = 'Sure! {"command":"next-event","args":{}} hope that helps';
    expect(parseIntentJson(prose)).toEqual({ command: 'next-event', args: {} });
  });

  it('returns null for empty or non-JSON text (never throws)', () => {
    expect(parseIntentJson('')).toBeNull();
    expect(parseIntentJson('no json here')).toBeNull();
    expect(parseIntentJson('{ broken')).toBeNull();
  });
});
