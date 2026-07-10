import type {
  CommandParamSchema,
  CommandProperty,
  McpToolShape,
} from './command.model';
import { validateArgs } from './schema-validator';

/**
 * Natural-language intent layer for the command registry (#942, Phase 3).
 *
 * Pure, framework-agnostic, dependency-free helpers that turn the registry
 * into (a) a CONSTRAINED JSON schema and system prompt a small in-browser LLM
 * decodes against, and (b) a deterministic keyword fallback for when no model
 * is available. The model can only ever pick a REGISTERED command and fill its
 * typed arguments; everything is re-validated here and again by the registry
 * before running, so a wrong word can never fire a wrong (or physics-altering)
 * action. The heavy WebLLM engine and the UI live in the app layer; this file
 * stays pure so it is unit-testable without a browser or a model.
 */

/** A model- or rule-produced command choice. */
export interface Intent {
  /** The chosen command name (must be a registered command). */
  command: string;
  /** The command arguments. */
  args: Record<string, any>;
}

/** Result of validating a proposed intent against the registry. */
export type IntentResult =
  | { ok: true; command: string; args: Record<string, any> }
  | { ok: false; error: string; none?: boolean };

/** Live values that fill an `enumSource` parameter, keyed by source name. */
export type EnumSources = Partial<
  Record<NonNullable<CommandProperty['enumSource']>, string[]>
>;

/** Minimal registry surface needed to validate an intent. */
interface CommandLookup {
  get(name: string): { inputSchema: CommandParamSchema } | undefined;
}

/**
 * Convert a command's input schema into a plain JSON-Schema args object,
 * resolving (or stripping) `enumSource`, which is not a JSON-Schema keyword and
 * must never reach the grammar. When live values are supplied for a source the
 * parameter is pinned to that concrete `enum`; otherwise it is left a plain
 * typed field the registry validates after the fact.
 * @param input The command's input schema.
 * @param enums Live enum values keyed by source name.
 * @returns A JSON-Schema object describing the command's arguments.
 */
function toArgsSchema(input: CommandParamSchema, enums?: EnumSources): any {
  const properties: Record<string, any> = {};
  for (const [name, prop] of Object.entries(input.properties ?? {})) {
    const p: any = { type: prop.type };
    if (prop.description) p.description = prop.description;
    if (prop.enum) {
      p.enum = [...prop.enum];
    } else if (prop.enumSource && enums?.[prop.enumSource]?.length) {
      p.enum = [...(enums[prop.enumSource] as string[])];
    }
    if (prop.minimum !== undefined) p.minimum = prop.minimum;
    if (prop.maximum !== undefined) p.maximum = prop.maximum;
    properties[name] = p;
  }
  const schema: any = {
    type: 'object',
    properties,
    additionalProperties: false,
  };
  if (input.required?.length) schema.required = [...input.required];
  return schema;
}

/** One `oneOf` branch pinning `command` to a name and `args` to its schema. */
function branch(name: string, args: any): any {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['command', 'args'],
    properties: { command: { const: name }, args },
  };
}

/**
 * Build the stringified JSON schema a constrained decoder (WebLLM/XGrammar)
 * uses so the model can ONLY emit `{command, args}` for a registered command,
 * or `{command:'none', args:{}}` when nothing matches. This is the physics-
 * safety core: the grammar makes an unregistered or malformed action
 * structurally impossible.
 * @param tools The registry's MCP tool shapes.
 * @param enums Optional live enum values to pin `enumSource` parameters.
 * @returns The schema as a JSON string (WebLLM's `response_format.schema`).
 */
export function buildIntentSchema(
  tools: McpToolShape[],
  enums?: EnumSources,
): string {
  const oneOf = tools.map((t) =>
    branch(t.name, toArgsSchema(t.inputSchema, enums)),
  );
  oneOf.push(
    branch('none', {
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
  );
  return JSON.stringify({ oneOf });
}

/**
 * Canonical few-shot examples spanning command categories. Only examples whose
 * command is actually registered (or the `none` escape) are shown, so the
 * prompt stays correct if the command set changes. Small instruct models map
 * intent far more reliably with a few concrete examples than from a bare list.
 */
const FEWSHOT_EXAMPLES: {
  q: string;
  command: string;
  args: Record<string, any>;
}[] = [
  { q: 'go to the next event', command: 'next-event', args: {} },
  {
    q: 'hide the calorimeter',
    command: 'set-geometry-visibility',
    args: { part: 'calorimeter', visible: false },
  },
  { q: 'make the background dark', command: 'set-theme', args: { dark: true } },
  { q: 'spin the detector', command: 'toggle-auto-rotate', args: { on: true } },
  {
    q: 'what collections are in this event',
    command: 'list-collections',
    args: {},
  },
  { q: 'order me a pizza', command: 'none', args: {} },
];

/** Render a parameter with its type and, when known, its allowed values. */
function describeParam(
  name: string,
  prop: CommandProperty,
  enums?: EnumSources,
): string {
  let allowed = '';
  if (prop.enum) {
    allowed = `: ${prop.enum.join('|')}`;
  } else if (prop.enumSource && enums?.[prop.enumSource]?.length) {
    const values = enums[prop.enumSource] as string[];
    allowed = `: ${values.slice(0, 20).join('|')}${values.length > 20 ? '|...' : ''}`;
  }
  return `${name} (${prop.type}${allowed})`;
}

/**
 * Build the system prompt describing the available commands to the model,
 * with allowed argument values and a few worked examples. Passing the same
 * live `enums` used for the schema lets the model see real collection/part
 * names so it can map "the calorimeter" to an actual geometry part.
 * @param tools The registry's MCP tool shapes.
 * @param enums Optional live enum values to show valid argument choices.
 * @returns A prompt listing every command, its arguments and examples.
 */
export function buildSystemPrompt(
  tools: McpToolShape[],
  enums?: EnumSources,
): string {
  const names = new Set(tools.map((t) => t.name));
  const lines = tools.map((t) => {
    const params = Object.entries(t.inputSchema.properties ?? {})
      .map(([n, p]) => describeParam(n, p, enums))
      .join(', ');
    return `- ${t.name}: ${t.description}${params ? ` [args: ${params}]` : ''}`;
  });
  const examples = FEWSHOT_EXAMPLES.filter(
    (e) => e.command === 'none' || names.has(e.command),
  ).map(
    (e) =>
      `user: ${e.q}\n${JSON.stringify({ command: e.command, args: e.args })}`,
  );
  return [
    "You control a 3D particle-physics event display. Choose the ONE command whose purpose best matches the user's intent, and fill its arguments from the request.",
    'Reply with ONLY a compact JSON object {"command": "<name>", "args": {...}} and nothing else: no prose, no markdown.',
    'If no command matches, reply {"command": "none", "args": {}}. Never invent a command or an argument value.',
    '',
    'Commands:',
    ...lines,
    '',
    'Examples:',
    ...examples,
  ].join('\n');
}

/**
 * Validate a proposed intent against the registry: the command must be
 * registered and its arguments must satisfy the command's schema. The sentinel
 * `none` is reported as an explicit no-match rather than an error.
 * @param parsed The parsed model/rule output.
 * @param registry The command registry (or any command lookup).
 * @returns A normalized ok result, or a reason it was rejected.
 */
export function validateIntent(
  parsed: unknown,
  registry: CommandLookup,
): IntentResult {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'intent must be an object' };
  }
  const obj = parsed as Record<string, unknown>;
  const command = obj['command'];
  if (typeof command !== 'string' || command.length === 0) {
    return { ok: false, error: 'intent is missing a command' };
  }
  if (command === 'none') {
    return { ok: false, error: 'no matching command', none: true };
  }
  const cmd = registry.get(command);
  if (!cmd) {
    return { ok: false, error: `unknown command '${command}'` };
  }
  const args =
    obj['args'] !== undefined && obj['args'] !== null
      ? (obj['args'] as Record<string, any>)
      : {};
  const v = validateArgs(cmd.inputSchema, args);
  if (!v.valid) {
    return { ok: false, error: v.error ?? 'invalid arguments' };
  }
  return { ok: true, command, args };
}

/**
 * Defensively parse a model's text reply into an intent object. Constrained
 * decoding returns pure JSON, but this also tolerates markdown code fences and
 * surrounding prose by extracting the first balanced `{...}` block. Returns
 * null when no JSON object is present (never throws).
 * @param text The model's raw text output.
 * @returns The parsed object, or null.
 */
export function parseIntentJson(text: string): unknown {
  const raw = (text ?? '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through to extraction */
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      /* not valid JSON */
    }
  }
  return null;
}

/**
 * Deterministic keyword fallback used when no model is available (e.g. no
 * WebGPU). Maps a handful of common phrasings to safe, no-/simple-argument
 * commands, and returns `null` rather than ever guessing a command. Any intent
 * it returns is a registered command and passes `validateIntent`.
 * @param text The user's request.
 * @returns A mapped intent, or null when nothing clearly matches.
 */
export function keywordFallback(text: string): Intent | null {
  const t = (text ?? '').toLowerCase().trim();
  if (!t) return null;
  const has = (...w: string[]) => w.some((x) => t.includes(x));
  const negated = has(
    'stop',
    'disable',
    'hide',
    'remove',
    'turn off',
    ' off',
    "don't",
    'without',
    'no ',
  );

  if (has('next')) return { command: 'next-event', args: {} };
  if (has('previous', 'prev ', 'last event', 'go back'))
    return { command: 'previous-event', args: {} };

  if (has('dark')) return { command: 'set-theme', args: { dark: true } };
  if (has('light')) return { command: 'set-theme', args: { dark: false } };

  if (has('rotat', 'spin'))
    return { command: 'toggle-auto-rotate', args: { on: !negated } };

  if (has('axis', 'axes'))
    return { command: 'show-axis', args: { show: !negated } };

  if (has('zoom in', 'zoom closer'))
    return { command: 'zoom', args: { direction: 'in' } };
  if (has('zoom out', 'zoom away'))
    return { command: 'zoom', args: { direction: 'out' } };

  if (has('projection', 'orthographic', 'perspective'))
    return { command: 'toggle-camera-projection', args: {} };

  if (has('clip')) return { command: 'set-clipping', args: { on: !negated } };

  return null;
}
