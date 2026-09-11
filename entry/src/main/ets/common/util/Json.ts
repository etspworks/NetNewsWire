/**
 * Json — typed reading of a parsed JSON tree.
 *
 * The Swift parsers index dictionaries as `d["key"] as? String`. ArkTS bans
 * `obj['key']` on arbitrary objects and bans `any`, so a parsed payload is walked
 * through `Record<string, Object>` with the typed accessors below. Everything that
 * has a fixed shape uses a declared interface + the model's `xFromJSON(wire)`
 * instead; this is for the genuinely dynamic parts (JSON Feed, RSS-in-JSON, and the
 * dynamically-keyed NewsBlur `feeds` / `flat_folders` objects).
 */

export type JsonObject = Record<string, Object>;

/** JSON.parse that never throws; returns undefined for malformed input. */
export function parseJson(text: string): Object | undefined {
  try {
    const parsed: Object | null = JSON.parse(text) as Object | null;
    return parsed === null ? undefined : parsed;
  } catch (e) {
    return undefined;
  }
}

export function parseJsonObject(text: string): JsonObject | undefined {
  const parsed: Object | undefined = parseJson(text);
  return asObject(parsed);
}

export function asObject(value?: Object): JsonObject | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value) || typeof value !== 'object') {
    return undefined;
  }
  return value as JsonObject;
}

export function asArray(value?: Object): Object[] | undefined {
  if (value === undefined || value === null || !Array.isArray(value)) {
    return undefined;
  }
  return value as Object[];
}

export function getValue(obj: JsonObject, key: string): Object | undefined {
  const value: Object | undefined = obj[key];
  return value === null ? undefined : value;
}

export function getString(obj: JsonObject, key: string): string | undefined {
  const value: Object | undefined = getValue(obj, key);
  return typeof value === 'string' ? value as string : undefined;
}

export function getNumber(obj: JsonObject, key: string): number | undefined {
  const value: Object | undefined = getValue(obj, key);
  return typeof value === 'number' ? value as number : undefined;
}

export function getBoolean(obj: JsonObject, key: string): boolean | undefined {
  const value: Object | undefined = getValue(obj, key);
  return typeof value === 'boolean' ? value as boolean : undefined;
}

export function getObject(obj: JsonObject, key: string): JsonObject | undefined {
  return asObject(getValue(obj, key));
}

export function getArray(obj: JsonObject, key: string): Object[] | undefined {
  return asArray(getValue(obj, key));
}

export function getStringArray(obj: JsonObject, key: string): string[] | undefined {
  const array: Object[] | undefined = getArray(obj, key);
  if (array === undefined) {
    return undefined;
  }
  const out: string[] = [];
  for (const element of array) {
    if (typeof element === 'string') {
      out.push(element as string);
    }
  }
  return out;
}

export function getObjectArray(obj: JsonObject, key: string): JsonObject[] | undefined {
  const array: Object[] | undefined = getArray(obj, key);
  if (array === undefined) {
    return undefined;
  }
  const out: JsonObject[] = [];
  for (const element of array) {
    const asObj: JsonObject | undefined = asObject(element);
    if (asObj !== undefined) {
      out.push(asObj);
    }
  }
  return out;
}

/**
 * The JSON Feed spec says an item id must be a string, but version 1 says a number
 * should be coerced — `JSONFeedParser.parseUniqueID` does exactly this.
 */
export function getStringOrNumberAsString(obj: JsonObject, key: string): string | undefined {
  const value: Object | undefined = getValue(obj, key);
  if (typeof value === 'string') {
    return value as string;
  }
  if (typeof value === 'number') {
    return (value as number).toString();
  }
  return undefined;
}

/** Keys of a dynamically-keyed JSON object (NewsBlur `feeds` / `flat_folders`). */
export function keysOf(obj: JsonObject): string[] {
  return Object.keys(obj);
}

/** Serializes a value back to JSON; returns undefined rather than throwing. */
export function stringifyJson(value: Object): string | undefined {
  try {
    return JSON.stringify(value);
  } catch (e) {
    return undefined;
  }
}
