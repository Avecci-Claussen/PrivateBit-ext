/** Chrome extension messages are JSON. BigInt in a PLAN/PSBT payload made sendResponse fail with "no response". */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as T;
}
