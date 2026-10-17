const PACIFIC_TIME_ZONE = "America/Los_Angeles";

const tableTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: PACIFIC_TIME_ZONE,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

const fullTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: PACIFIC_TIME_ZONE,
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

export function formatPacificTableTime(date: Date): string {
  return tableTimeFormatter.format(date);
}

export function formatPacificTimestamp(date: Date): string {
  return fullTimeFormatter.format(date);
}
