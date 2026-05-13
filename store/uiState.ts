/**
 * AegisLayer — Core Type Definitions
 *
 * Contains shared types used across the extension.
 * The zustand store was removed as overlay.tsx manages
 * all state internally via React hooks.
 */

export type PIIEntity = {
  id: string;
  type: string;
  value: string;
  shouldMask: boolean;
  box?: { x: number; y: number; width: number; height: number; pageIndex: number };
};
