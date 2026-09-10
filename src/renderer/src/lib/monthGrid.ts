/**
 * Which dates a month view shows, including the neighbours that fill the
 * first and last rows.
 *
 * Dates are stepped by *calendar day*, not by adding 24 hours: on the two days
 * a year when the clocks change, a day is 23 or 25 hours long, and a grid built
 * on arithmetic quietly repeats or skips one.
 */
export function monthGrid(year: number, month: number, firstDayOfWeek: number): Date[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() - firstDayOfWeek + 7) % 7;

  const start = new Date(year, month, 1 - lead);
  const days: Date[] = [];
  const cursor = new Date(start);

  // Compare against the first day of the *next* month rather than against the
  // month number: `new Date(2026, 12, 1)` is January 2027, so December stops
  // where it should instead of running on through the new year.
  const end = new Date(year, month + 1, 1);

  // Run until the month is finished *and* the week is complete, so every row
  // is a full week.
  while (cursor < end || days.length % 7 !== 0) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
    if (days.length > 42) break;
  }

  return days;
}

/** Local midnight-to-midnight bounds for a grid, as RFC 3339 for the backend. */
export function gridWindow(days: Date[]): { from: string; to: string } {
  const first = days[0] ?? new Date();
  const last = days[days.length - 1] ?? first;
  const from = new Date(first.getFullYear(), first.getMonth(), first.getDate());
  const to = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}
