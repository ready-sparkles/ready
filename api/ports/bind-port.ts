/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Binders return the configured function unchanged. */
export function bindPortFunction<T extends (...args: never[]) => unknown>(resolve: () => T): T {
  return ((...args: Parameters<T>): ReturnType<T> => {
    const fn = resolve();

    return fn(...args) as ReturnType<T>;
  }) as T;
}
