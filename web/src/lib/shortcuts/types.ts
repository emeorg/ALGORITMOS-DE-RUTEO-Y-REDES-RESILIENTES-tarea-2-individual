export interface KeyCombo {
  /** Primary KeyboardEvent.key value used for matching and display (e.g. "ArrowLeft", "+", "h"). */
  readonly key: string;
  /** Optional alternate KeyboardEvent.key values across keyboard layouts (e.g. "=" for "+"). */
  readonly aliases?: readonly string[];
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  /** Ignore Shift state when matching layout-dependent symbol keys like "+" or "-". */
  readonly ignoreShift?: boolean;
}

export interface ShortcutCommand {
  readonly id: string;
  readonly description: string;
  readonly combo: KeyCombo;
  readonly allowInInputs?: boolean;
  execute(event?: KeyboardEvent): void;
}

export interface ShortcutMatcher {
  matches(event: KeyboardEvent, combo: KeyCombo): boolean;
}

export interface EditableTargetGuard {
  isEditable(target: EventTarget | null): boolean;
}

export interface ShortcutRegistry {
  register(command: ShortcutCommand): () => void;
  dispatch(event: KeyboardEvent): boolean;
  list(): readonly ShortcutCommand[];
}
