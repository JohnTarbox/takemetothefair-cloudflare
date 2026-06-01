/**
 * Small text helpers shared across UI components. Kept as discrete
 * functions (not classes / instances) so they're tree-shakeable at
 * the Pages edge-bundle layer.
 */

/**
 * Pluralize a noun based on a count. Returns "N noun" / "N nouns" with
 * the count rendered via toLocaleString() so 1,234 reads correctly.
 *
 * @param count The count to display.
 * @param singular The singular form ("event").
 * @param plural Optional explicit plural ("entries"); defaults to
 *               `${singular}s` ("events"). Use when English isn't naive
 *               (entry/entries, day/days is fine but party/parties is not).
 */
export function pluralize(count: number, singular: string, plural?: string): string {
  const noun = count === 1 ? singular : (plural ?? `${singular}s`);
  return `${count.toLocaleString()} ${noun}`;
}
