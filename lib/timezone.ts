// Converts a wall-clock date/time as observed in a given IANA timezone into
// the correct UTC instant, using only Intl (no external tz library, per
// scope). Never construct `new Date("YYYY-MM-DDTHH:MM")` directly — that is
// parsed as UTC or local-to-the-server, neither of which is the location's
// timezone.
//
// Approach: guess the UTC instant by treating the wall-clock fields as UTC,
// then ask Intl what wall-clock time that instant reads as in the target
// timezone. The difference between the guess and the desired wall-clock time
// is the zone's offset at that instant, which corrects the guess. A second
// pass re-reads at the corrected instant to absorb any DST-boundary drift
// from the first correction.
export function zonedTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);
  const desiredUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  function readAsUtcMs(instantMs: number): number {
    const parts = formatter.formatToParts(new Date(instantMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  }

  let instantMs = desiredUtcMs - (readAsUtcMs(desiredUtcMs) - desiredUtcMs);
  instantMs = desiredUtcMs - (readAsUtcMs(instantMs) - instantMs);

  return new Date(instantMs);
}

// The inverse direction: which wall-clock calendar day (in `timeZone`) does
// this UTC instant fall on. en-CA formats as YYYY-MM-DD, giving a directly
// comparable calendar-date string — used to bucket instants into day
// columns without an external tz library.
export function localDayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
