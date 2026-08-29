export function deepMerge<T extends Record<string, any>>(from: Partial<T>, to: T): T {
  // Handle null or undefined cases
  if (!from) return to;
  if (!to) return from as T;

  // Create a new object to avoid modifying the original
  const result = { ...to };

  for (const key in from) {
    if (Object.prototype.hasOwnProperty.call(from, key)) {
      const fromValue = from[key];
      const toValue = to[key];

      // Handle array case
      if (Array.isArray(fromValue)) {
        result[key] = fromValue.slice();
        continue;
      }

      // Handle object case
      if (fromValue && typeof fromValue === 'object') {
        result[key] = deepMerge(fromValue, toValue || {}) as T[Extract<keyof T, string>];
        continue;
      }

      // Handle primitive values
      if (fromValue !== undefined) {
        result[key] = fromValue;
      }
    }
  }

  return result;
}
