/** JSON-Schema (2020-12 subset) description of one command parameter. */
export interface CommandProperty {
  /** JSON type of the parameter. */
  type: 'string' | 'number' | 'integer' | 'boolean';
  /** Human-readable description shown in the palette and NL prompt. */
  description?: string;
  /** Allowed static values. */
  enum?: (string | number)[];
  /** Name of a live source that fills `enum` at runtime, resolved by later phases. */
  enumSource?: 'collections' | 'geometryParts' | 'presetViews' | 'eventKeys';
  /** Inclusive lower bound for numeric parameters. */
  minimum?: number;
  /** Inclusive upper bound for numeric parameters. */
  maximum?: number;
}

/** JSON-Schema (2020-12 subset) for a command's arguments object. */
export interface CommandParamSchema {
  /** Always 'object' for command arguments. */
  type: 'object';
  /** Parameter definitions keyed by parameter name. */
  properties: Record<string, CommandProperty>;
  /** Names of required parameters. */
  required?: string[];
  /** When false, unknown parameters are rejected. */
  additionalProperties?: false;
}
