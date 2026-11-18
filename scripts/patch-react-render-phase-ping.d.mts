export interface PingPatchShape {
  buggy: string;
  fixed: string;
}
export const TARGETS: ReadonlyArray<readonly [string, PingPatchShape]>;
export function patchSource(
  src: string,
  shape: PingPatchShape,
  label?: string
): { status: "patched" | "already-fixed"; src: string };
