import { clsx, type ClassValue } from "clsx";

/**
 * The dashboard's `cn` also runs tailwind-merge, which isn't a dependency of this app. The design
 * primitives here therefore never rely on later classes overriding earlier ones — callers pass
 * additive classes only.
 */
export function cn(...classes: ClassValue[]): string {
  return clsx(classes);
}
