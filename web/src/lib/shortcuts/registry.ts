import { DefaultShortcutMatcher, DomEditableTargetGuard } from "./matcher";
import type {
  EditableTargetGuard,
  ShortcutCommand,
  ShortcutMatcher,
  ShortcutRegistry,
} from "./types";

export class InMemoryShortcutRegistry implements ShortcutRegistry {
  private readonly commands = new Map<string, ShortcutCommand>();

  constructor(
    private readonly matcher: ShortcutMatcher = new DefaultShortcutMatcher(),
    private readonly guard: EditableTargetGuard = new DomEditableTargetGuard()
  ) {}

  register(command: ShortcutCommand): () => void {
    this.commands.set(command.id, command);
    return () => {
      if (this.commands.get(command.id) === command) {
        this.commands.delete(command.id);
      }
    };
  }

  dispatch(event: KeyboardEvent): boolean {
    const editable = this.guard.isEditable(event.target);
    for (const command of this.commands.values()) {
      if (editable && !command.allowInInputs) continue;
      if (this.matcher.matches(event, command.combo)) {
        event.preventDefault();
        command.execute(event);
        return true;
      }
    }
    return false;
  }

  list(): readonly ShortcutCommand[] {
    return Array.from(this.commands.values());
  }
}
