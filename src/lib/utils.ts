import { type ClassValue, clsx } from "clsx";
import { toast } from "sonner";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function handleErrors(error: unknown) {
  JSON.parse(error.message).forEach((err) => {
    toast.error(err.message);
  });
}
