import { CommandRegistry } from '../../../managers/command-registry/command-registry';
import {
  registerDefaultCommands,
  defaultCommands,
} from '../../../managers/command-registry/default-commands';
import type { CommandHost } from '../../../managers/command-registry/command-host';

function host() {
  const h = {
    eventDisplay: {
      nextEvent: jest.fn(),
      previousEvent: jest.fn(),
      loadEvent: jest.fn(),
      zoomTo: jest.fn(),
      highlightObject: jest.fn(),
      lookAtObject: jest.fn(),
      getCollections: jest.fn(() => ({ Tracks: ['a'] })),
      getCollection: jest.fn(() => [{ uuid: 'u0', pt: 5 }]),
      getCurrentEventKey: jest.fn(() => 'evt1'),
      getEventMetadata: jest.fn(() => [{ run: 1 }]),
    },
    ui: {
      setDarkTheme: jest.fn(),
      setAutoRotate: jest.fn(),
      setClipping: jest.fn(),
      setShowAxis: jest.fn(),
      geometryVisibility: jest.fn(),
      getPresetViews: jest.fn(() => [{ name: 'Front' }]),
      displayView: jest.fn(),
    },
    three: { revertMainCamera: jest.fn() },
    state: {},
    emit: jest.fn(),
    resolveObject: jest.fn((_c: string, i: number) =>
      i === 0 ? { uuid: 'u0' } : undefined,
    ),
    listGeometryParts: () => ['LAr Barrel'],
  };
  return h as unknown as CommandHost & typeof h;
}

function reg(h: CommandHost) {
  const r = new CommandRegistry(h);
  registerDefaultCommands(r);
  return r;
}

describe('default commands', () => {
  it('registers a non-trivial generic set', () => {
    expect(defaultCommands().length).toBeGreaterThanOrEqual(15);
  });

  it('next-event calls EventDisplay.nextEvent', async () => {
    const h = host();
    expect((await reg(h).execute('next-event')).ok).toBe(true);
    expect(h.eventDisplay.nextEvent).toHaveBeenCalled();
  });

  it('set-theme routes through UIManager.setDarkTheme', async () => {
    const h = host();
    await reg(h).execute('set-theme', { dark: true });
    expect(h.ui.setDarkTheme).toHaveBeenCalledWith(true);
  });

  it('zoom rejects an invalid direction', async () => {
    const h = host();
    expect((await reg(h).execute('zoom', { direction: 'sideways' })).ok).toBe(
      false,
    );
  });

  it('preset-view resolves the view by name', async () => {
    const h = host();
    await reg(h).execute('preset-view', { view: 'Front' });
    expect(h.ui.displayView).toHaveBeenCalledWith({ name: 'Front' });
  });

  it('highlight-object resolves collection+index to a uuid', async () => {
    const h = host();
    await reg(h).execute('highlight-object', {
      collection: 'Tracks',
      index: 0,
    });
    expect(h.eventDisplay.highlightObject).toHaveBeenCalledWith('u0');
  });

  it('highlight-object fails when the object is missing', async () => {
    const h = host();
    expect(
      (
        await reg(h).execute('highlight-object', {
          collection: 'Tracks',
          index: 9,
        })
      ).ok,
    ).toBe(false);
  });

  it('set-geometry-visibility routes through UIManager.geometryVisibility', async () => {
    const h = host();
    await reg(h).execute('set-geometry-visibility', {
      part: 'LAr Barrel',
      visible: false,
    });
    expect(h.ui.geometryVisibility).toHaveBeenCalledWith('LAr Barrel', false);
  });

  it('list-collections returns the grouped collections', async () => {
    const h = host();
    expect(await reg(h).execute('list-collections')).toEqual({
      ok: true,
      result: { Tracks: ['a'] },
    });
  });
});
