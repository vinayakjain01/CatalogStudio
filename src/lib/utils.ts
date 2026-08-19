/**
 * @module utils
 *
 * Small shared UI utility.
 *
 * RESPONSIBILITIES:
 *   - cn — merges conditional class-name inputs and resolves Tailwind class
 *     conflicts.
 */
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/** Combine class-name values (clsx-style) and resolve Tailwind conflicts via twMerge. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
