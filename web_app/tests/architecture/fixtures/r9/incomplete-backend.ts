// R9 negative fixture: a backend object missing required commands must fail the gate.
export function createLiteBackend() {
  return {
    mount() {},
    dispose() {},
    setView() {},
  };
}
