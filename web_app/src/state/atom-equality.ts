/** Object projections notify their consumers only when a selected field changes. */
export function shallowRecordEqual(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null
    && Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every(key => Object.hasOwn(right, key) && Object.is(Reflect.get(left, key), Reflect.get(right, key))));
}
