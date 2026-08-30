/** Turn a `fetch` rejection into something an operator can act on.
 *
 *  undici reports every connect-level failure as a bare
 *  `TypeError: fetch failed` and hides the reason in `err.cause.code`
 *  (`ECONNREFUSED`, `EHOSTUNREACH`, `ENOTFOUND`, …), and reports our own
 *  AbortController firing as `This operation was aborted`. Neither string
 *  tells the operator whether the endpoint said *no* or said *nothing*, and
 *  that distinction is the diagnosis: refused means the service is down,
 *  while silence means the route is black-holed — e.g. a container whose
 *  `host.containers.internal` mapping points at an address that no longer
 *  routes, where the service itself is perfectly healthy.
 *
 *  `waitedMs` is how long THIS hop waited, not the probe total. */
export function describeFetchError(err: unknown, waitedMs: number): string {
  if (isAbort(err)) return `no response after ${waitedMs}ms (timed out)`;
  const message = err instanceof Error ? err.message : String(err);
  // Prefer the errno; fall back to the cause's own text, which is all undici
  // gives for its internal refusals (e.g. `bad port`). Either beats the naked
  // `fetch failed` the operator would otherwise be handed.
  const reason = causeCode(err) ?? causeMessage(err);
  return reason && reason !== message ? `${message} (${reason})` : message;
}

/** An abort can arrive as a real `AbortError` from undici or, in tests and
 *  older runtimes, as a plain Error carrying only the message — match both. */
export function isAbort(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || /operation was aborted/i.test(err.message);
}

/** Dig the errno out of undici's wrapper. `cause` is usually the coded error
 *  itself, but when Happy Eyeballs raced several addresses it is an
 *  AggregateError whose own `code` is undefined and whose `errors[]` hold the
 *  real ones — that is the common shape for a refused localhost connection,
 *  so missing it leaves the operator with a bare `fetch failed`. */
function causeCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const cause: unknown = (err as { cause?: unknown }).cause;
  const direct = codeOf(cause);
  if (direct) return direct;
  const nested: unknown = (cause as { errors?: unknown } | undefined)?.errors;
  if (!Array.isArray(nested)) return undefined;
  for (const inner of nested) {
    const code = codeOf(inner);
    if (code) return code;
  }
  return undefined;
}

function causeMessage(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const cause: unknown = (err as { cause?: unknown }).cause;
  if (!(cause instanceof Error) || cause.message === '') return undefined;
  return cause.message;
}

function codeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('code' in value)) return undefined;
  const code: unknown = (value as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
