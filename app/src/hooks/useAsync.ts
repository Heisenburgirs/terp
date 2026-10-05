"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/errors";

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Runs `load` whenever `key` changes, on `reload()`, and every `intervalMs` when given.
 * Data from a previous run is kept while a refresh is in flight and dropped when `key` changes.
 * A `null` key means "nothing to load yet".
 */
export function useAsync<T>(load: () => Promise<T>, key: string | null, intervalMs?: number): AsyncState<T> {
  const [state, setState] = useState<{ key: string | null; data?: T; error: string | null; loading: boolean }>({
    key,
    error: null,
    loading: key !== null,
  });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (key === null) return;
    let live = true;
    loadRef.current().then(
      (data) => live && setState({ key, data, error: null, loading: false }),
      (error) =>
        live &&
        setState((previous) => ({
          key,
          data: previous.key === key ? previous.data : undefined,
          error: errorMessage(error),
          loading: false,
        })),
    );
    return () => {
      live = false;
    };
  }, [key, tick]);

  useEffect(() => {
    if (!intervalMs || key === null) return;
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, key]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const current = state.key === key;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : null,
    loading: key !== null && (!current || state.loading),
    reload,
  };
}
