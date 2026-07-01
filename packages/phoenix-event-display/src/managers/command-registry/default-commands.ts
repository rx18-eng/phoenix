import type { Command, CommandParamSchema } from './command.model';
import type { CommandRegistry } from './command-registry';

/** No-argument object schema shared by parameterless commands. */
const NO_ARGS: CommandParamSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

/** A collection-name + row-index schema for object-addressed commands. */
const OBJECT_REF: CommandParamSchema = {
  type: 'object',
  properties: {
    collection: {
      type: 'string',
      description: 'Collection name',
      enumSource: 'collections',
    },
    index: {
      type: 'integer',
      description: 'Row index within the collection',
      minimum: 0,
    },
  },
  required: ['collection', 'index'],
  additionalProperties: false,
};

/**
 * Build the generic, experiment-agnostic v1 command set. Every command wraps
 * an existing deterministic Phoenix method; object args use (collection,index)
 * and mutating view state goes through UIManager to stay state-synced.
 * @returns The default commands.
 */
export function defaultCommands(): Command[] {
  return [
    {
      name: 'next-event',
      title: 'Next event',
      description: 'Load the next event in the dataset.',
      category: 'Navigation',
      inputSchema: { ...NO_ARGS },
      mutates: true,
      run: (_a, h) => h.eventDisplay.nextEvent(),
    },
    {
      name: 'previous-event',
      title: 'Previous event',
      description: 'Load the previous event in the dataset.',
      category: 'Navigation',
      inputSchema: { ...NO_ARGS },
      mutates: true,
      run: (_a, h) => h.eventDisplay.previousEvent(),
    },
    {
      name: 'load-event',
      title: 'Load event',
      description: 'Load a specific event by its key.',
      category: 'Navigation',
      inputSchema: {
        type: 'object',
        properties: {
          eventKey: {
            type: 'string',
            description: 'Event key',
            enumSource: 'eventKeys',
          },
        },
        required: ['eventKey'],
        additionalProperties: false,
      },
      mutates: true,
      run: (a, h) => h.eventDisplay.loadEvent(a.eventKey),
    },

    {
      name: 'set-theme',
      title: 'Set theme',
      description: 'Switch between dark and light theme.',
      category: 'View',
      inputSchema: {
        type: 'object',
        properties: {
          dark: { type: 'boolean', description: 'True for dark theme' },
        },
        required: ['dark'],
        additionalProperties: false,
      },
      mutates: true,
      run: (a, h) => h.ui.setDarkTheme(a.dark),
    },
    {
      name: 'preset-view',
      title: 'Preset view',
      description: 'Snap the camera to a named preset view.',
      category: 'View',
      inputSchema: {
        type: 'object',
        properties: {
          view: {
            type: 'string',
            description: 'Preset view name',
            enumSource: 'presetViews',
          },
        },
        required: ['view'],
        additionalProperties: false,
      },
      mutates: true,
      run: (a, h) => {
        const match = (h.ui.getPresetViews?.() ?? []).find(
          (v: any) => v.name === a.view,
        );
        if (!match) throw new Error(`unknown view '${a.view}'`);
        h.ui.displayView(match);
      },
    },
    {
      name: 'zoom',
      title: 'Zoom',
      description: 'Zoom the camera in or out.',
      category: 'View',
      inputSchema: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['in', 'out'],
            description: 'Zoom direction',
          },
        },
        required: ['direction'],
        additionalProperties: false,
      },
      mutates: true,
      run: (a, h) =>
        h.eventDisplay.zoomTo(a.direction === 'in' ? 1 / 1.2 : 1.2, 100),
    },
    {
      name: 'toggle-auto-rotate',
      title: 'Auto-rotate',
      description: 'Turn camera auto-rotation on or off.',
      category: 'View',
      inputSchema: {
        type: 'object',
        properties: { on: { type: 'boolean' } },
        required: ['on'],
        additionalProperties: false,
      },
      mutates: true,
      run: (a, h) => h.ui.setAutoRotate(a.on),
    },
    {
      name: 'set-clipping',
      title: 'Clipping',
      description: 'Enable or disable the geometry clipping planes.',
      category: 'View',
      inputSchema: {
        type: 'object',
        properties: { on: { type: 'boolean' } },
        required: ['on'],
        additionalProperties: false,
      },
      mutates: true,
      run: (a, h) => h.ui.setClipping(a.on),
    },
    {
      name: 'show-axis',
      title: 'Show axis',
      description: 'Show or hide the XYZ axis helper.',
      category: 'View',
      inputSchema: {
        type: 'object',
        properties: { show: { type: 'boolean' } },
        required: ['show'],
        additionalProperties: false,
      },
      mutates: true,
      run: (a, h) => h.ui.setShowAxis(a.show),
    },
    {
      name: 'toggle-camera-projection',
      title: 'Camera projection',
      description:
        'Switch the main camera between perspective and orthographic.',
      category: 'View',
      inputSchema: { ...NO_ARGS },
      mutates: true,
      run: (_a, h) => h.three.revertMainCamera(),
    },

    {
      name: 'set-geometry-visibility',
      title: 'Show/hide geometry',
      description: 'Show or hide a named detector geometry part.',
      category: 'Geometry',
      inputSchema: {
        type: 'object',
        properties: {
          part: {
            type: 'string',
            description: 'Geometry part name',
            enumSource: 'geometryParts',
          },
          visible: { type: 'boolean' },
        },
        required: ['part', 'visible'],
        additionalProperties: false,
      },
      mutates: true,
      run: (a, h) => h.ui.geometryVisibility(a.part, a.visible),
    },

    {
      name: 'highlight-object',
      title: 'Highlight object',
      description: 'Outline an object selected by collection and row index.',
      category: 'Selection',
      inputSchema: { ...OBJECT_REF },
      mutates: true,
      run: (a, h) => {
        const obj = h.resolveObject(a.collection, a.index);
        if (!obj) throw new Error(`no object at ${a.collection}[${a.index}]`);
        h.eventDisplay.highlightObject(obj.uuid);
      },
    },
    {
      name: 'look-at-object',
      title: 'Look at object',
      description:
        'Move the camera to an object selected by collection and row index.',
      category: 'Selection',
      inputSchema: { ...OBJECT_REF },
      mutates: true,
      run: (a, h) => {
        const obj = h.resolveObject(a.collection, a.index);
        if (!obj) throw new Error(`no object at ${a.collection}[${a.index}]`);
        h.eventDisplay.lookAtObject(obj.uuid);
      },
    },

    {
      name: 'list-collections',
      title: 'List collections',
      description: 'List the event-data collections grouped by type.',
      category: 'Query',
      inputSchema: { ...NO_ARGS },
      mutates: false,
      run: (_a, h) => h.eventDisplay.getCollections(),
    },
    {
      name: 'describe-event',
      title: 'Describe event',
      description: 'Report the current event key and metadata.',
      category: 'Query',
      inputSchema: { ...NO_ARGS },
      mutates: false,
      run: (_a, h) => ({
        eventKey: h.eventDisplay.getCurrentEventKey(),
        metadata: h.eventDisplay.getEventMetadata(),
      }),
    },
    {
      name: 'get-object',
      title: 'Get object',
      description:
        'Return the raw data of one object by collection and row index.',
      category: 'Query',
      inputSchema: { ...OBJECT_REF },
      mutates: false,
      run: (a, h) => {
        const arr = h.eventDisplay.getCollection(a.collection);
        return arr?.[a.index];
      },
    },
  ];
}

/**
 * Register the generic v1 command set on a registry.
 * @param registry The registry to populate.
 */
export function registerDefaultCommands(registry: CommandRegistry): void {
  for (const command of defaultCommands()) {
    registry.register(command);
  }
}
