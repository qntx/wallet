export const attempt = <T>(
  run: () => T,
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown } => {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, error };
  }
};
