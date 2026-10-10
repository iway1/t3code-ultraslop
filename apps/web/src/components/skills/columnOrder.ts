/** Columns in the saved order; columns never placed follow in their default order. */
export function orderColumns<T extends { readonly key: string }>(
  columns: ReadonlyArray<T>,
  order: ReadonlyArray<string>,
): ReadonlyArray<T> {
  const rank = (key: string) => (order.includes(key) ? order.indexOf(key) : order.length);
  return columns.toSorted((left, right) => rank(left.key) - rank(right.key));
}

/**
 * The saved order after dropping column `from` on column `to`: it takes `to`'s
 * place, landing after it when moving right and before it when moving left.
 * Hidden columns keep their slots for when they are shown again.
 */
export function moveColumn(
  order: ReadonlyArray<string>,
  shownKeys: ReadonlyArray<string>,
  from: string,
  to: string,
): ReadonlyArray<string> {
  const keys = [...order, ...shownKeys.filter((key) => !order.includes(key))];
  const next = keys.filter((key) => key !== from);
  next.splice(keys.indexOf(to), 0, from);
  return next;
}
