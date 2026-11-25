"use client";

import { useEffect, useRef } from "react";
import {
  InMemoryShortcutRegistry,
  type ShortcutCommand,
  type ShortcutRegistry,
} from "@/lib/shortcuts";

export function useShortcuts(
  commands: readonly ShortcutCommand[],
  externalRegistry?: ShortcutRegistry
): void {
  const internalRegistryRef = useRef<ShortcutRegistry | null>(null);
  if (!internalRegistryRef.current) {
    internalRegistryRef.current = new InMemoryShortcutRegistry();
  }
  const registry = externalRegistry ?? internalRegistryRef.current;

  useEffect(() => {
    const unregisters = commands.map((cmd) => registry.register(cmd));
    const handleKeyDown = (event: KeyboardEvent) => {
      registry.dispatch(event);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      for (const unregister of unregisters) unregister();
    };
  }, [commands, registry]);
}
