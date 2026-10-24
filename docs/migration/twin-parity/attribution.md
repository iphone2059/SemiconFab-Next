# Twin source and licence record

The reference is `C:/Users/han_qingyu/SemiconFab/twin.html`, original repository
`jinjiefan2020/SemiconFab`, commit `b3666132e5d8cab2cebe4c4227fc04c52242eb28`.
The user selected its **final loaded construction**, including the custom
`twin/layout-default.json` layout. The reference files remain unchanged.
File hashes are in [source-manifest.json](source-manifest.json).

The original code, data, geometry recipes, pressure field, tour waypoints and
site mark are covered by the original **PolyForm Noncommercial License 1.0.0**.
This migration does not relicense those portions. The complete notice is retained
in the immutable import snapshot and at
[`web_app/public/licenses/semiconfab-LICENSE.txt`](../../../web_app/public/licenses/semiconfab-LICENSE.txt).
Its original noncommercial/commercial-use boundary continues to apply.

`original-tool-geometry.ts` ports the original parametric families and catalog
boxes; `original-environment.ts` ports floor textures, zone planes, columns,
amber lights/panels/curtains; `airflow-texture.ts`, `cleanroom-pressure.ts` and
`original-tour.ts` port their named source functions/constants. The new renderer
uses Babylon WebGPU and native GPU depth resources; no original renderer or
glTF asset is embedded in the product. Screenshots contain the original page
solely as comparison evidence and retain its original notice.

`original-icons.tsx` stores SVG paths observed in the original controls.
Except for the original wafer/site mark, these are Lucide icons. Lucide's
[upstream licence](https://github.com/lucide-icons/lucide/blob/main/LICENSE)
was checked on 2026-10-25 and includes ISC plus the MIT notice for its listed
Feather-derived icons. Both notices are preserved verbatim at
[`web_app/public/licenses/lucide-LICENSE.txt`](../../../web_app/public/licenses/lucide-LICENSE.txt).
No Lucide CDN or additional icon runtime is required.

The original displayed machine templates are conceptual representations, not
manufacturer-certified CAD. Nominal dimensions and inferred/draft provenance
remain distinct from rendered bounds. Reproducing these geometries does not
certify physical dimensions, industrial interoperability or model accuracy.
