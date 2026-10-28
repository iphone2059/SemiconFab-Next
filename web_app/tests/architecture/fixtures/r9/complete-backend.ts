// R9 positive fixture: an object covering every required command passes the coverage gate.
export function createLiteBackend() {
  return {
    mount() {},
    dispose() {},
    setView() {},
    setCameraPose() {},
    getCameraPose() { return null; },
    zoom() {},
    resize() {},
    clearSelection() {},
    selectTool() {},
    setLayer() {},
    setToolState() {},
    setTour() {},
    setExplodeFactor() {},
    setBasement() {},
    setDual() {},
    setCutPlane() {},
    setXRayFilter() {},
    setWaferPoint() {},
    setWaferTrail() {},
    focusPatrol() {},
    setLanguage() {},
    acceptance: { forceDeviceLoss() {} },
  };
}
