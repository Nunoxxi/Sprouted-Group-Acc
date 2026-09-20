/**
 * Date/time text that is identical on the server and in every browser.
 *
 * `toLocaleString()` with no arguments takes the locale and timezone of
 * whichever machine runs it, so server-rendered HTML and the browser's
 * re-render can disagree and React reports a hydration mismatch. The
 * business runs on Ghana time, so that is the fixed zone.
 */

const dateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Accra',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatDateTime(value: string | Date): string {
  return dateTime.format(typeof value === 'string' ? new Date(value) : value);
}
