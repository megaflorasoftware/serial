import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type Dispatch, type SetStateAction, useState, useEffect } from "react";
import { type z, type ZodType } from "zod";

export function useSearchParamState<T extends ZodType>(
  key: string,
  defaultValue: z.infer<T>,
  schema: T,
) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const updateUrl = (newValue: string) => {
    const newSearchParams = new URLSearchParams(searchParams);
    if (newValue === defaultValue) {
      newSearchParams.delete(key);
    } else {
      newSearchParams.set(key, newValue);
    }
    const url = `${pathname}?${newSearchParams.toString()}`;
    router.push(url);
  };

  const getValue = (): z.infer<T> => {
    const value = searchParams.get(key);
    if (value === null) {
      return defaultValue;
    }

    const res = schema.safeParse(value);
    if (res.success) {
      return value;
    }

    return defaultValue;
  };

  const [value, setStateValue] = useState<z.infer<T>>(() => getValue());

  useEffect(() => {
    const value = getValue();
    setStateValue(value);
  }, [searchParams]);

  const setValue: Dispatch<SetStateAction<z.infer<T>>> = (
    newValueOrCallback,
  ) => {
    const newValue =
      typeof newValueOrCallback === "function"
        ? // @ts-expect-error I don't know, can't be bothered
          newValueOrCallback(value)
        : newValueOrCallback;

    setStateValue(newValue);
    updateUrl(newValue);
  };

  return [value, setValue] as const;
}
