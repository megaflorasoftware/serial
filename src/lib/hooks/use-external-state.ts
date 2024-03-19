import { useEffect, useState } from "react";

export function useExternalState<T>(value: T) {
  const [state, setState] = useState<T>(value);

  useEffect(() => {
    setState(value);
  }, [value]);

  return [state, setState] as const;
}
