import { describe, expect, it } from "vite-plus/test";

import { moveColumn, orderColumns } from "./columnOrder";

const columns = (...keys: string[]) => keys.map((key) => ({ key }));
const keysOf = (items: ReadonlyArray<{ key: string }>) => items.map((item) => item.key);

describe("orderColumns", () => {
  it("keeps the default order when nothing was moved", () => {
    expect(keysOf(orderColumns(columns("a", "b", "c"), []))).toEqual(["a", "b", "c"]);
  });

  it("follows the saved order and puts unplaced columns last in default order", () => {
    expect(keysOf(orderColumns(columns("a", "b", "c", "d"), ["c", "a"]))).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });
});

describe("moveColumn", () => {
  it("lands after the target when moving right and before it when moving left", () => {
    expect(moveColumn([], ["a", "b", "c"], "a", "b")).toEqual(["b", "a", "c"]);
    expect(moveColumn([], ["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("keeps a hidden column's slot", () => {
    const order = moveColumn(["a", "hidden", "b", "c"], ["a", "b", "c"], "c", "a");
    expect(order).toEqual(["c", "a", "hidden", "b"]);
    expect(keysOf(orderColumns(columns("a", "hidden", "b", "c"), order))).toEqual([
      "c",
      "a",
      "hidden",
      "b",
    ]);
  });

  it("places a column that was never moved", () => {
    const order = moveColumn(["b", "a"], ["a", "b", "new"], "new", "b");
    expect(keysOf(orderColumns(columns("a", "b", "new"), order))).toEqual(["new", "b", "a"]);
  });
});
