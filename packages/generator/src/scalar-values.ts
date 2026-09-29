/**
 * Supported non-empty temporal literals, deliberately independent of locale / Date.parse.
 * date: YYYY-MM-DD; datetime: YYYY-MM-DDTHH:mm:ss[.1..7 digits][Z|+/-HH:mm].
 * A datetime without a zone stays unspecified: do not silently assume local time or UTC.
 * Years are 0001..9999, fractions retain .NET tick precision, offsets are at most 14:00.
 * This validates literals; it neither rewrites XML nor proves native execution compatibility.
 */
export function isTemporalLiteral(type: "date" | "datetime", value: string): boolean {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.slice(0, 10));
  if (!date) return false;
  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (year < 1 || days === undefined || day < 1 || day > days) return false;
  if (type === "date") return value.length === 10;

  const time = /^T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?(?:Z|[+-](\d{2}):(\d{2}))?$/.exec(
    value.slice(10),
  );
  if (
    !time ||
    time[0] !== value.slice(10) ||
    Number(time[1]) > 23 ||
    Number(time[2]) > 59 ||
    Number(time[3]) > 59
  )
    return false;
  const offsetHours = Number(time[5] ?? 0);
  const offsetMinutes = Number(time[6] ?? 0);
  return offsetHours <= 14 && offsetMinutes <= 59 && (offsetHours < 14 || offsetMinutes === 0);
}

/**
 * Canonical decimal comparison without rounding through a JS Number. No locale separators,
 * whitespace, Infinity or NaN. Exponents are limited to safe integers (no expansion needed).
 */
function decimalKey(value: string): string | undefined {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match || match[0] !== value) return undefined;
  const fraction = match[3] ?? match[4] ?? "";
  const exponent = Number(match[5] ?? 0) - fraction.length;
  if (!Number.isSafeInteger(exponent)) return undefined;
  const digits = `${match[2] ?? ""}${fraction}`.replace(/^0+/, "");
  if (digits === "") return "0";
  const coefficient = digits.replace(/0+$/, "");
  const scale = exponent + digits.length - coefficient.length;
  if (!Number.isSafeInteger(scale)) return undefined;
  return `${match[1] === "-" ? "-" : ""}${coefficient}e${scale}`;
}

/**
 * Key for scalar assertions. Text (including whitespace) and temporal literals compare
 * exactly; date/time zones are never inferred. Numbers compare as decimals, flags ignore
 * case. Empty text is a value; an empty temporal/number/flag value is invalid.
 */
export function scalarComparisonKey(type: string, value: string): string | undefined {
  switch (type) {
    case "text":
      return value;
    case "number":
      return decimalKey(value);
    case "flag":
      return ["true", "false"].includes(value.toLowerCase()) ? value.toLowerCase() : undefined;
    case "date":
    case "datetime":
      return isTemporalLiteral(type, value) ? value : undefined;
    default:
      return undefined;
  }
}
