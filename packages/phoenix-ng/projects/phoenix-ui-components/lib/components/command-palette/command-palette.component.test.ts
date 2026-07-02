import { CommandPaletteComponent } from './command-palette.component';

function fakeCommand(name: string, extra: any = {}) {
  return {
    name,
    title: extra.title ?? name,
    description: extra.description ?? name,
    category: extra.category ?? 'View',
    inputSchema: extra.inputSchema ?? {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    mutates: extra.mutates ?? true,
    run: () => undefined,
  };
}

function make(
  commands = [
    fakeCommand('set-theme', { description: 'dark/light' }),
    fakeCommand('next-event', { category: 'Navigation' }),
  ],
) {
  const registry = {
    list: jest.fn(() => commands),
    execute: jest.fn(async () => ({ ok: true })),
  };
  const eventDisplay: any = {
    getCommandRegistry: () => registry,
    getCollections: () => ({}),
    getUIManager: () => ({ getPresetViews: () => [] }),
    getEventsData: () => ({}),
  };
  const cdr: any = { detectChanges: jest.fn() };
  const c = new CommandPaletteComponent(eventDisplay, cdr);
  c.ngOnInit();
  return { c, registry };
}

const key = (over: any) =>
  ({ preventDefault: jest.fn(), ...over }) as unknown as KeyboardEvent;

describe('CommandPaletteComponent (keyboard + filter)', () => {
  it('Ctrl+K opens and prevents default; again closes', () => {
    const { c } = make();
    expect(c.open).toBe(false);
    const e1 = key({ ctrlKey: true, altKey: false, key: 'k' });
    c.onDocumentKeydown(e1);
    expect(c.open).toBe(true);
    expect(e1.preventDefault).toHaveBeenCalled();
    c.onDocumentKeydown(key({ ctrlKey: true, altKey: false, key: 'k' }));
    expect(c.open).toBe(false);
  });

  it('Cmd+K also toggles (mac)', () => {
    const { c } = make();
    c.onDocumentKeydown(key({ metaKey: true, altKey: false, key: 'k' }));
    expect(c.open).toBe(true);
  });

  it('does NOT toggle on Ctrl+Alt+K (AltGr safety)', () => {
    const { c } = make();
    c.onDocumentKeydown(key({ ctrlKey: true, altKey: true, key: 'k' }));
    expect(c.open).toBe(false);
  });

  it('filters commands by query across name/description', () => {
    const { c } = make();
    c.openPalette();
    c.updateQuery('theme');
    expect(c.filtered.map((x) => x.name)).toEqual(['set-theme']);
    c.updateQuery('');
    expect(c.filtered.length).toBe(2);
  });

  it('Escape closes when open', () => {
    const { c } = make();
    c.openPalette();
    c.onDocumentKeydown(key({ key: 'Escape' }));
    expect(c.open).toBe(false);
  });

  it('ArrowDown/Up move selection within bounds', () => {
    const { c } = make();
    c.openPalette();
    expect(c.selectedIndex).toBe(0);
    c.onDocumentKeydown(key({ key: 'ArrowDown' }));
    expect(c.selectedIndex).toBe(1);
    c.onDocumentKeydown(key({ key: 'ArrowDown' }));
    expect(c.selectedIndex).toBe(1);
    c.onDocumentKeydown(key({ key: 'ArrowUp' }));
    expect(c.selectedIndex).toBe(0);
  });

  it('ignores navigation keys when closed', () => {
    const { c } = make();
    c.onDocumentKeydown(key({ key: 'ArrowDown' }));
    expect(c.open).toBe(false);
    expect(c.selectedIndex).toBe(0);
  });
});

describe('CommandPaletteComponent (choose, params, run)', () => {
  it('runs a no-arg command immediately on choose', async () => {
    const { c, registry } = make();
    c.openPalette();
    const nav = c.filtered.find((x) => x.name === 'next-event')!;
    await c.choose(nav);
    expect(registry.execute).toHaveBeenCalledWith('next-event', {});
  });

  it('opens a param form for a command with parameters (no execute yet)', async () => {
    const themed = fakeCommand('set-theme', {
      inputSchema: {
        type: 'object',
        properties: { dark: { type: 'boolean' } },
        required: ['dark'],
        additionalProperties: false,
      },
    });
    const { c, registry } = make([themed]);
    c.openPalette();
    await c.choose(themed);
    expect(c.activeCommand?.name).toBe('set-theme');
    expect(registry.execute).not.toHaveBeenCalled();
  });

  it('resolves enumSource options from the live service', () => {
    const cmd = fakeCommand('preset-view', {
      inputSchema: {
        type: 'object',
        properties: { view: { type: 'string', enumSource: 'presetViews' } },
        required: ['view'],
        additionalProperties: false,
      },
    });
    const { c } = make([cmd]);
    (c as any).eventDisplay.getUIManager = () => ({
      getPresetViews: () => [{ name: 'Front' }, { name: 'Side' }],
    });
    expect(c.optionsFor(cmd.inputSchema.properties.view)).toEqual([
      'Front',
      'Side',
    ]);
    (c as any).eventDisplay.getCollections = () => ({
      Tracks: ['T1'],
      Hits: ['CSC'],
    });
    expect(
      c.optionsFor({ type: 'string', enumSource: 'collections' } as any),
    ).toEqual(['T1', 'CSC']);
  });

  it('coerces numeric params from text before executing', async () => {
    const cmd = fakeCommand('highlight-object', {
      inputSchema: {
        type: 'object',
        properties: {
          collection: { type: 'string' },
          index: { type: 'integer' },
        },
        required: ['collection', 'index'],
        additionalProperties: false,
      },
    });
    const { c, registry } = make([cmd]);
    c.openPalette();
    await c.choose(cmd);
    c.paramValues = { collection: 'T1', index: '2' };
    await c.submitParams();
    expect(registry.execute).toHaveBeenCalledWith('highlight-object', {
      collection: 'T1',
      index: 2,
    });
  });

  it('shows an error result when a command fails', async () => {
    const { c, registry } = make();
    registry.execute.mockResolvedValueOnce({ ok: false, error: 'boom' });
    c.openPalette();
    await c.choose(c.filtered.find((x) => x.name === 'next-event')!);
    expect(c.result?.ok).toBe(false);
    expect(c.result?.text).toContain('boom');
  });
});
