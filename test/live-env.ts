/** Live tests only. Reads the key from the test process; nothing in src reads the environment. */
export function envUnisatToken(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return (env?.PRIVATEBIT_LIVE_TEST_UNISAT_KEY ?? "").trim();
}
