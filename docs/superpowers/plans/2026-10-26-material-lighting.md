# Frozen material and lighting alignment

Baseline committed first as `09abdbf`, per user request. Continue on main in this checkout.
Reference: frozen `SemiconFab@b3666132`, remaining-parity-phases and native depth-shadow contract.

1. Pin failing behavior tests for source Lambert diffuse, unclipped light slots, legacy point decay,
   and basement lighting staying active across level visibility. Preserve LinearEncoding and no IBL.
2. Port the evidenced material equations in `original-lighting.ts`. Diagnostic five-swatch experiment
   already shows exact center RGB agreement after Lambert plus removal of Babylon's extra 4% diffuse
   reduction; no exposure/brightness fitting is needed.
3. Restore four missing B1 fluorescent strips/lights; preserve six high-bay lights with source decay
   1.2, soft lights decay 1.5, and source always-lit state. Move their light root with exploded B1.
   Keep key/fill in two native slots, with key at slot 0. Pack local lights into the material UBO
   (four vec4 per light, capacity 24), since a separate UBO per light exceeds the GPU binding limit.
4. Map Wafer carrier's StandardMaterial approximations to source PBR values and point light.
5. Apply the same source response to lazily created live status-lamp materials. A production browser
   assertion reproduced their missing plugin before the repair.
6. Verify source material swatches and point falloff in real WebGPU, then production scene suites,
   typecheck/full Vitest/build/source checks. Re-capture ISO/Litho/Wafer/B1/Dual/Tour Goldens and report
   both gains and unresolved differences. Keep native shadows; no fake ambient or invented IBL.

User exclusions persist: no 60-minute soak or device-loss matrix. This increment prioritizes material
and light fidelity; sidebar/HUD structure is not redesigned. Review source scope and per-level light
ownership explicitly, since the frozen source never disables basement lights on level switches.

All six steps completed. Five source swatches and four ninth-light legacy decay samples match frozen
source RGB values exactly. Nine production suites passed with zero console/runtime errors; GPU-aware
suites recorded zero uncaptured device errors. TypeScript, 190/190 Vitest, build, 16/16 Python tests,
architecture/contracts/import and all eight source gates passed. Resource-contended initial runs were
repeated separately at the same timeout thresholds, without changing production code or test limits.

Seven targeted Goldens all improved (full-frame): ISO 72.0%, Litho 70.2%, B1 69.3%, Dual 68.1%,
Wafer 61.9%, Tour 73.0%, X-Ray 61.7%; capture errors 0. Full inventory was not recaptured. Evidence:
`docs/migration/twin-parity/evidence/material-lighting-2026-10-26/README.md`.
Scope/remaining source approximations are recorded there; status remains NOT_PARITY_VERIFIED.
