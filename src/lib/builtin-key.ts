/**
 * Private test builds only (`npm run build:private`, output dist-private/). The key comes from the
 * UNISAT_API_KEY environment variable at build time and is never in the source tree. Release builds
 * define __PB_PRIVATE_UNISAT__ as undefined, so this is "" there, and scripts/check-dist.mjs still
 * refuses any key in dist/. A key the user types in Settings always wins over this one.
 */
export const BUILT_IN_UNISAT_TOKEN: string =
  typeof __PB_PRIVATE_UNISAT__ === "string" && __PB_PRIVATE_UNISAT__.length > 0 ? __PB_PRIVATE_UNISAT__ : "";

/** The token to send: the user's own first, then the built in one, and only to the default UniSat host. */
export function effectiveUnisatToken(userToken: string | undefined, root: string, defaultRoot: string): string | undefined {
  if (userToken && userToken.length > 0) return userToken;
  if (BUILT_IN_UNISAT_TOKEN && root.replace(/\/$/, "") === defaultRoot.replace(/\/$/, "")) return BUILT_IN_UNISAT_TOKEN;
  return undefined;
}
