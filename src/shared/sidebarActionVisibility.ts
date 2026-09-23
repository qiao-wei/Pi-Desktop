/**
 * Sidebar row actions (project "…" menu, new session, pin, delete) stay hidden until the
 * pointer is over the row, so the list reads as a list of projects rather than a toolbar.
 *
 * Rules encoded here:
 * - hide with `opacity-0`, never conditional rendering: the buttons keep occupying their
 *   grid slot, so revealing them cannot reflow the row or shift the title;
 * - reveal on row hover (`group` must sit on the row container) *and* on keyboard focus
 *   inside the row, otherwise tabbing to an invisible control loses it completely;
 * - the focus variant is `:has(:focus-visible)`, not `:focus-within`: clicking a row leaves a
 *   *mouse* focus on it (the row is a `div[role=button][tabindex]`), and under `:focus-within`
 *   that kept the icons parked until the user clicked somewhere else;
 * - an open dropdown keeps the actions visible (Radix moves focus into a portal, so no
 *   focus-inside-row survives that): `data-[state=open]` covers the class sitting on the
 *   trigger itself, `group-has-[[data-state=open]]` covers the wrapper form below.
 *
 * ⚠️ Apply this to a **wrapper element around the buttons**, never to a `Button` directly.
 * A disabled button carries `disabled:opacity-50` (base) and, while a conversation switch is
 * in flight, `disabled:opacity-100` (switch lock). Those selectors are `.x:disabled` — one
 * pseudo-class more specific than the bare `.opacity-0` (and emitted later on top of that), so
 * they win the cascade whenever the button is disabled. Selecting another conversation locks
 * the sidebar for the duration of the bootstrap refetch, which is exactly the moment those
 * rules apply: the project "…" / new-session icons flashed into view on every switch. On a
 * wrapper the two multiply instead of compete — hidden stays hidden, and a hovered row shows
 * the buttons at their own (locked = full, dimmed = 50%) opacity.
 */
export const sidebarHoverActionClass =
  "opacity-0 transition-opacity group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 group-has-[[data-state=open]]:opacity-100 data-[state=open]:opacity-100";
