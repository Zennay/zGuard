function normalized(value) {
  return String(value ?? '').trim();
}

function decimalInteger(value) {
  const text = normalized(value);
  if (!/^\d+$/.test(text)) return null;

  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function positiveInt(value, fallback) {
  const parsed = decimalInteger(value);
  return parsed !== null && parsed > 0 ? parsed : fallback;
}

export function nonNegativeInt(value, fallback) {
  const parsed = decimalInteger(value);
  return parsed !== null && parsed >= 0 ? parsed : fallback;
}

export function positiveNumber(value, fallback) {
  const text = normalized(value);
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return fallback;

  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
