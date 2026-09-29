export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: { attempts?: number; delayMs?: number; label?: string },
): Promise<T> {
  const attempts = options?.attempts ?? 3;
  const delayMs = options?.delayMs ?? 400;
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i === attempts) break;
      await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError));
}
