import { createContext, useContext } from 'solid-js';

/**
 * Document-level facts a block deep in the tree occasionally needs without
 * every container threading them as props: today only the note's path, which
 * the svg block uses to seed the "Download .svg" save dialog with
 * `<note-stem>-<block-id>.svg` beside the note. Provided once by the mdx
 * modal around the rendered document.
 */
export interface PlanDocInfo {
  /** Absolute path of the `.mdx` being rendered. */
  notePath: string;
}

export const PlanDocContext = createContext<PlanDocInfo>();

/** The enclosing document's info, or `undefined` outside the mdx modal. */
export function usePlanDoc(): PlanDocInfo | undefined {
  return useContext(PlanDocContext);
}
