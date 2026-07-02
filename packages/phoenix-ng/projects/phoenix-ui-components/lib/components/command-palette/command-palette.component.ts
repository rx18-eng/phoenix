import {
  ChangeDetectorRef,
  Component,
  HostListener,
  type OnInit,
} from '@angular/core';
import type {
  Command,
  CommandProperty,
  CommandRegistry,
} from 'phoenix-event-display';
import { EventDisplayService } from '../../services/event-display.service';

/**
 * Keyboard-triggered command palette (#942). Opens on Ctrl/Cmd+K, lists the
 * registered commands, prompts for parameters from each command's inputSchema,
 * and runs them through the command registry. Icon-less and self-hiding, so it
 * adds zero toolbar footprint and works even when the toolbar is hidden.
 */
@Component({
  standalone: false,
  selector: 'app-command-palette',
  templateUrl: './command-palette.component.html',
  styleUrls: ['./command-palette.component.scss'],
})
export class CommandPaletteComponent implements OnInit {
  /** Whether the palette overlay is visible. */
  open = false;
  /** Current search query. */
  query = '';
  /** Commands matching the current query, in registry order. */
  filtered: Command[] = [];
  /** Index of the highlighted command in the filtered list. */
  selectedIndex = 0;
  /** Command awaiting parameter input, or null when picking from the list. */
  activeCommand: Command | null = null;
  /** Working parameter values for the active command's form. */
  paramValues: Record<string, any> = {};
  /** Last execution result banner, or null. */
  result: { ok: boolean; text: string } | null = null;

  private registry!: CommandRegistry;

  /**
   * @param eventDisplay The Phoenix event display service.
   * @param cdr Change detector for pushing updates outside Angular events.
   */
  constructor(
    private eventDisplay: EventDisplayService,
    private cdr: ChangeDetectorRef,
  ) {}

  /** Cache the command registry once the service is ready. */
  ngOnInit(): void {
    this.registry = this.eventDisplay.getCommandRegistry();
    this.filtered = this.registry.list();
  }

  /**
   * Global keyboard handler: Ctrl/Cmd+K toggles the palette (excluding AltGr
   * combos); Escape closes; Arrow keys and Enter drive the list while open.
   * @param event The keydown event.
   */
  @HostListener('document:keydown', ['$event'])
  onDocumentKeydown(event: KeyboardEvent): void {
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      event.key?.toLowerCase() === 'k'
    ) {
      event.preventDefault();
      this.toggle();
      return;
    }
    if (!this.open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    // While a parameter form is open, let its inputs handle keys.
    if (this.activeCommand) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.selectedIndex = Math.min(
        this.selectedIndex + 1,
        this.filtered.length - 1,
      );
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const cmd = this.filtered[this.selectedIndex];
      if (cmd) this.choose(cmd);
    }
  }

  /** Toggle the palette open/closed. */
  toggle(): void {
    if (this.open) this.close();
    else this.openPalette();
  }

  /** Open the palette, resetting query and selection. */
  openPalette(): void {
    this.open = true;
    this.query = '';
    this.result = null;
    this.activeCommand = null;
    this.selectedIndex = 0;
    this.filtered = this.registry.list();
    this.cdr.detectChanges();
  }

  /** Close the palette and clear transient state. */
  close(): void {
    this.open = false;
    this.activeCommand = null;
    this.result = null;
    this.cdr.detectChanges();
  }

  /**
   * Filter the command list by a query (matches name, title, description).
   * @param query The search text.
   */
  updateQuery(query: string): void {
    this.query = query;
    const q = query.trim().toLowerCase();
    this.filtered = this.registry.list().filter((c) => {
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        (c.title ?? '').toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q)
      );
    });
    this.selectedIndex = 0;
  }

  /**
   * Pick a command: run it immediately when it takes no parameters, otherwise
   * open its parameter form.
   * @param command The chosen command.
   */
  async choose(command: Command): Promise<void> {
    this.result = null;
    const props = command.inputSchema?.properties ?? {};
    if (Object.keys(props).length === 0) {
      await this.runNow(command, {});
      return;
    }
    this.activeCommand = command;
    this.paramValues = {};
    for (const [name, prop] of Object.entries(props)) {
      this.paramValues[name] = prop.type === 'boolean' ? false : '';
    }
    this.cdr.detectChanges();
  }

  /**
   * Resolve the selectable options for a parameter, from a static enum or a
   * live enumSource (collections, presetViews, eventKeys). An empty array
   * means the field is rendered as free text.
   * @param prop The parameter schema.
   * @returns The option strings.
   */
  optionsFor(prop: CommandProperty): string[] {
    if (prop.enum) return prop.enum.map((v) => String(v));
    switch (prop.enumSource) {
      case 'collections':
        return Object.values(this.eventDisplay.getCollections() ?? {}).flat();
      case 'presetViews':
        return (this.eventDisplay.getUIManager()?.getPresetViews() ?? []).map(
          (v: any) => v.name,
        );
      case 'eventKeys':
        return Object.keys(this.eventDisplay.getEventsData() ?? {});
      default:
        return [];
    }
  }

  /**
   * The active command's parameters in declared order, for the form template.
   * @returns Name/schema pairs, or an empty array when no command is active.
   */
  activeParams(): { name: string; prop: CommandProperty }[] {
    const props = this.activeCommand?.inputSchema?.properties ?? {};
    return Object.entries(props).map(([name, prop]) => ({ name, prop }));
  }

  /** Submit the active command's parameter form, coercing values by type. */
  async submitParams(): Promise<void> {
    if (!this.activeCommand) return;
    const props = this.activeCommand.inputSchema?.properties ?? {};
    const args: Record<string, any> = {};
    for (const [name, prop] of Object.entries(props)) {
      const raw = this.paramValues[name];
      if (raw === undefined || raw === '') continue;
      if (prop.type === 'integer' || prop.type === 'number') {
        args[name] = Number(raw);
      } else if (prop.type === 'boolean') {
        args[name] = !!raw;
      } else {
        args[name] = raw;
      }
    }
    await this.runNow(this.activeCommand, args);
  }

  /**
   * Execute a command through the registry and show the result banner.
   * @param command The command to run.
   * @param args The argument object.
   */
  async runNow(command: Command, args: Record<string, any>): Promise<void> {
    const res = await this.registry.execute(command.name, args);
    if (res.ok) {
      this.result = { ok: true, text: `${command.title ?? command.name} done` };
      this.activeCommand = null;
      this.query = '';
    } else {
      // This workspace compiles without strictNullChecks, so truthiness
      // narrowing does not split the ok:true/false result union. Read the
      // failure message off the explicitly-typed failure variant instead.
      const failure = res as { ok: false; error?: string };
      this.result = { ok: false, text: failure.error ?? 'Command failed' };
    }
    this.cdr.detectChanges();
  }
}
