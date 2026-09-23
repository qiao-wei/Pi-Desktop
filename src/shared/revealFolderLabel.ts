/**
 * Wording for the "open this folder" affordance.
 *
 * The same action is reachable from the sidebar (project "…" menu), the sidebar hover card
 * and the conversation header, and each platform calls the file manager something else:
 * macOS gets Finder, Windows gets Explorer. Keeping the branch here means the three call
 * sites cannot drift apart, and it is plain data so it can be unit tested without a DOM.
 */

export type RevealFolderLabelKey = "sidebar.revealInFinder" | "sidebar.revealInExplorer";

/**
 * `navigator.platform` is the signal every desktop/web renderer has (no user agent
 * parsing needed): Windows strings start with "Win". Anything else — macOS, Linux,
 * an unknown/absent platform — keeps the Finder wording, which is what the sidebar
 * has always fallen back to.
 */
export function revealFolderLabelKey(platform: string | null | undefined): RevealFolderLabelKey {
  return /^win/i.test(String(platform ?? "").trim()) ? "sidebar.revealInExplorer" : "sidebar.revealInFinder";
}

/** The label key for the renderer we are actually running in. */
export function platformRevealFolderLabelKey(): RevealFolderLabelKey {
  return revealFolderLabelKey(typeof navigator === "undefined" ? "" : navigator.platform);
}