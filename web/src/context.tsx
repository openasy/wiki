// What every page of the UI reads: the API, the spaces the person can read, and a way to say something changed.
import { createContext, useContext } from "react";
import type { Space, Summary } from "./api.ts";
import type { Call } from "./common.tsx";

export interface WikiContext {
  call: Call;
  spaces: Space[];
  summary: Summary | undefined;
  /** Load the spaces, the trees and the counts again after a change. */
  changed: () => void;
  /** Goes up with every change, so the trees reload. */
  version: number;
  /** A line shown above the next page, such as "Published". */
  say: (message: string) => void;
}

export const Wiki = createContext<WikiContext | null>(null);

export function useWiki(): WikiContext {
  const c = useContext(Wiki);
  if (!c) throw new Error("useWiki outside the app");
  return c;
}

/** The spaces where the person may write. */
export const writable = (spaces: Space[]) => spaces.filter((s) => s.role === "editor" || s.role === "admin");
