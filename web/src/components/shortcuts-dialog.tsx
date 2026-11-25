"use client";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { formatKeyCombo, type ShortcutCommand } from "@/lib/shortcuts";

interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: readonly ShortcutCommand[];
}

export function ShortcutsDialog({
  open,
  onOpenChange,
  commands,
}: ShortcutsDialogProps) {
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Atajos de teclado"
      description="Busca y ejecuta los atajos de teclado disponibles en la aplicación."
      showCloseButton
      className="sm:max-w-lg"
    >
      <Command>
        <CommandInput
          className="pr-8"
          placeholder="Buscar atajo de teclado..."
        />
        <CommandList>
          <CommandEmpty>No se encontraron atajos.</CommandEmpty>
          {commands.map((command) => {
            const label = formatKeyCombo(command.combo);
            return (
              <CommandItem
                key={command.id}
                value={`${command.description} ${label}`}
                onSelect={() => {
                  onOpenChange(false);
                  if (command.id !== "shortcuts.help") {
                    command.execute();
                  }
                }}
              >
                <span>{command.description}</span>
                <CommandShortcut className="shrink-0 whitespace-nowrap">
                  <Kbd className="whitespace-nowrap">{label}</Kbd>
                </CommandShortcut>
              </CommandItem>
            );
          })}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
