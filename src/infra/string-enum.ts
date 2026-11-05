import { Type, type TUnsafe } from "typebox";

/**
 * String enum as `{ type: "string", enum }` for providers without anyOf/const
 * support. Same JSON as Pi's `StringEnum`, but typed with TypeBox: Pi 1.5 moved
 * its helper to its own schema type, which TypeBox objects cannot infer.
 */
export function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values,
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}
