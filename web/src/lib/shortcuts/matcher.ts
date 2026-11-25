import type {
  EditableTargetGuard,
  KeyCombo,
  ShortcutMatcher,
} from "./types";

const KEY_LABELS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Escape: "Esc",
  Enter: "↵",
  " ": "Space",
};

export class DefaultShortcutMatcher implements ShortcutMatcher {
  matches(event: KeyboardEvent, combo: KeyCombo): boolean {
    const pressed = event.key.toLowerCase();
    const candidates = [combo.key, ...(combo.aliases ?? [])].map((k) =>
      k.toLowerCase()
    );
    const keyMatch = candidates.includes(pressed);
    const shiftMatch = combo.ignoreShift
      ? true
      : event.shiftKey === Boolean(combo.shift);

    return (
      keyMatch &&
      event.ctrlKey === Boolean(combo.ctrl) &&
      event.altKey === Boolean(combo.alt) &&
      shiftMatch &&
      event.metaKey === Boolean(combo.meta)
    );
  }
}

export class DomEditableTargetGuard implements EditableTargetGuard {
  isEditable(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      target.isContentEditable
    );
  }
}

export function formatKeyComboParts(combo: KeyCombo): string[] {
  const parts: string[] = [];
  if (combo.ctrl) parts.push("Ctrl");
  if (combo.alt) parts.push("Alt");
  if (combo.shift) parts.push("Shift");
  if (combo.meta) parts.push("Meta");
  parts.push(KEY_LABELS[combo.key] ?? combo.key.toLowerCase());
  return parts;
}

export function formatKeyCombo(combo: KeyCombo): string {
  return formatKeyComboParts(combo).join(" + ");
}
