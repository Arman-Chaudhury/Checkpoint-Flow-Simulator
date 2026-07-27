import { useEffect, useState } from 'react';

/**
 * Returns a value that trails `value` by `delayMs`. Used so that dragging a
 * slider updates the control immediately but only re-runs the simulation once
 * the drag settles, instead of on every intermediate frame.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(handle);
  }, [value, delayMs]);

  return debounced;
}
