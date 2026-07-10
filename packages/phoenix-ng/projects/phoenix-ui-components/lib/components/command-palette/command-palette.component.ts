import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  NgZone,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
import type {
  Command,
  CommandProperty,
  CommandRegistry,
} from 'phoenix-event-display';
import { EventDisplayService } from '../../services/event-display.service';
import { NotificationService } from '../../services/notification.service';
import {
  NaturalLanguageService,
  type NlOutcome,
} from '../../services/natural-language.service';

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
export class CommandPaletteComponent implements OnInit, OnDestroy {
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
  /**
   * Fields rendered by the parameter form, built ONCE when a command's form
   * opens. This is a stable array (with precomputed option lists) iterated by
   * `*ngFor` + `trackBy`. It must NOT be a template method call: a method that
   * returns a fresh array every change-detection cycle makes `*ngFor` recreate
   * its embedded `[(ngModel)]` inputs each cycle, whose value-accessor writes
   * schedule another cycle, spinning into an infinite change-detection loop
   * that hard-freezes the tab.
   */
  formFields: { name: string; prop: CommandProperty; options: string[] }[] = [];

  /** Current panel mode: pick from the list, or ask in natural language. */
  mode: 'commands' | 'ask' = 'commands';
  /** The natural-language request being typed in ask mode. */
  askText = '';
  /** True while a request is being interpreted/run. */
  askBusy = false;
  /** The last ask outcome (interpreted command + result, or an error). */
  askOutcome: NlOutcome | null = null;

  private registry!: CommandRegistry;
  private keydownHandler = (e: KeyboardEvent) => this.onDocumentKeydown(e);
  private mousedownHandler = (e: MouseEvent) => this.onDocMouseDown(e);

  /**
   * @param eventDisplay The Phoenix event display service.
   * @param cdr Change detector for pushing updates outside Angular events.
   * @param notification Service for success/error toasts after a command runs.
   * @param elementRef Host element, used to detect clicks outside the panel.
   * @param ngZone Angular zone; palette listeners run outside it so mouse and
   *   key events never trigger Phoenix's expensive app-wide change detection.
   */
  constructor(
    private eventDisplay: EventDisplayService,
    private cdr: ChangeDetectorRef,
    private notification: NotificationService,
    private elementRef: ElementRef<HTMLElement>,
    private ngZone: NgZone,
    private nl: NaturalLanguageService,
  ) {}

  /**
   * Cache the command registry and register the global key/mouse listeners
   * OUTSIDE Angular's zone. Bound via @HostListener they would run in-zone and
   * schedule a full app-wide change-detection tick on every keystroke and
   * mouse press anywhere in Phoenix (~seconds on the heavy 3D scene). Running
   * them outside the zone and re-rendering only the palette via detectChanges
   * keeps interaction cheap.
   */
  ngOnInit(): void {
    this.registry = this.eventDisplay.getCommandRegistry();
    this.filtered = this.registry.list();
    this.ngZone.runOutsideAngular(() => {
      document.addEventListener('keydown', this.keydownHandler);
      document.addEventListener('mousedown', this.mousedownHandler);
    });
  }

  /** Remove the global listeners. */
  ngOnDestroy(): void {
    document.removeEventListener('keydown', this.keydownHandler);
    document.removeEventListener('mousedown', this.mousedownHandler);
  }

  /**
   * Global keyboard handler: Ctrl/Cmd+K toggles the palette (excluding AltGr
   * combos); Escape closes; Arrow keys and Enter drive the list while open.
   * Runs outside Angular's zone, so view changes are flushed via detectChanges.
   * @param event The keydown event.
   */
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
    // In ask mode, or while a parameter form is open, let the inputs handle
    // keys (the ask box runs the request on its own Enter binding).
    if (this.mode === 'ask' || this.activeCommand) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.selectedIndex = Math.min(
        this.selectedIndex + 1,
        this.filtered.length - 1,
      );
      this.cdr.detectChanges();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.cdr.detectChanges();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const cmd = this.filtered[this.selectedIndex];
      if (cmd) this.choose(cmd);
    }
  }

  /**
   * Close the palette when the user presses down outside the panel. Uses
   * mousedown (not click) so containment is checked before Angular re-renders:
   * clicking a command that opens a parameter form detaches the clicked list
   * item, which would make a later bubbled click look "outside" and wrongly
   * close the panel.
   * Runs outside Angular's zone; close() flushes the view via detectChanges.
   * @param event The mousedown event.
   */
  onDocMouseDown(event: MouseEvent): void {
    if (!this.open) return;
    if (!this.elementRef.nativeElement.contains(event.target as Node)) {
      this.close();
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
    this.activeCommand = null;
    this.formFields = [];
    this.selectedIndex = 0;
    this.mode = 'commands';
    this.askText = '';
    this.askOutcome = null;
    this.askBusy = false;
    this.filtered = this.registry.list();
    this.cdr.detectChanges();
  }

  /** Close the palette and clear transient state. */
  close(): void {
    this.open = false;
    this.activeCommand = null;
    this.formFields = [];
    this.askOutcome = null;
    this.askBusy = false;
    this.cdr.detectChanges();
  }

  /**
   * Switch between picking a command from the list and asking in natural
   * language. Clears the last ask result when entering ask mode.
   * @param mode The mode to switch to.
   */
  setMode(mode: 'commands' | 'ask'): void {
    this.mode = mode;
    this.askOutcome = null;
    this.cdr.detectChanges();
  }

  /** Whether an in-browser model can be offered (app-provided + WebGPU). */
  get aiModelAvailable(): boolean {
    return this.nl.isModelAvailable();
  }

  /** The natural-language service status (idle/loading/ready/thinking/error). */
  get aiStatus(): string {
    return this.nl.status;
  }

  /** Model-load progress as a 0..100 integer, for the progress label. */
  get aiProgressPercent(): number {
    return Math.round((this.nl.progress?.progress ?? 0) * 100);
  }

  /** Opt in to the in-browser model (lazy one-time load). */
  async enableAi(): Promise<void> {
    try {
      await this.nl.enableModel();
    } catch {
      /* status/lastError already set by the service; UI shows the fallback */
    }
    this.cdr.detectChanges();
  }

  /**
   * Interpret and run the typed natural-language request. Delegates to the
   * natural-language service (model when available, else keyword fallback),
   * which only ever runs a registered, schema-validated command. Keeps the
   * panel open so the outcome is visible and follow-up requests are easy.
   */
  async runAsk(): Promise<void> {
    const text = this.askText.trim();
    if (!text || this.askBusy) return;
    this.askBusy = true;
    this.askOutcome = null;
    this.cdr.detectChanges();
    const outcome = await this.nl.ask(text);
    this.askBusy = false;
    this.askOutcome = outcome;
    if (outcome.ok) this.askText = '';
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
    const props = command.inputSchema?.properties ?? {};
    if (Object.keys(props).length === 0) {
      await this.runNow(command, {});
      return;
    }
    this.activeCommand = command;
    this.paramValues = {};
    // Build the form fields ONCE here (stable array + precomputed options),
    // in declared order. The template iterates this field with trackBy; it
    // never calls a method that rebuilds the array each change-detection cycle.
    this.formFields = Object.entries(props).map(([name, prop]) => {
      this.paramValues[name] = prop.type === 'boolean' ? false : '';
      return { name, prop, options: this.optionsFor(prop) };
    });
    this.cdr.detectChanges();
  }

  /** trackBy for the form fields: param names are unique within a command. */
  trackByName(_index: number, field: { name: string }): string {
    return field.name;
  }

  /** Leave the parameter form and return to the command list. */
  back(): void {
    this.activeCommand = null;
    this.formFields = [];
    this.cdr.detectChanges();
  }

  /**
   * Resolve the selectable options for a parameter, from a static enum or a
   * live enumSource (collections, presetViews, eventKeys). An empty array
   * means the field is rendered as free text. Called once per field when the
   * form opens (see `choose`), never from the template.
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
   * Execute a command through the registry. The palette closes FIRST so its
   * panel never sits over the live WebGL canvas while a command runs.
   *
   * On success there is NO toast: the command's own effect (theme change, axis
   * appears, camera moves) is the feedback, and opening a MatSnackBar overlay
   * on top of the continuously-rendering full-resolution 3D scene for every
   * command stalls the page. Only the rare failure path surfaces a toast.
   * @param command The command to run.
   * @param args The argument object.
   */
  async runNow(command: Command, args: Record<string, any>): Promise<void> {
    this.close();
    const res = await this.registry.execute(command.name, args);
    if (!res.ok) {
      // This workspace compiles without strictNullChecks, so truthiness
      // narrowing does not split the ok:true/false result union. Read the
      // failure message off the explicitly-typed failure variant instead.
      const failure = res as { ok: false; error?: string };
      // Re-enter the zone (listeners run outside it) so the toast renders.
      this.ngZone.run(() =>
        this.notification.error(failure.error ?? 'Command failed'),
      );
    }
  }
}
