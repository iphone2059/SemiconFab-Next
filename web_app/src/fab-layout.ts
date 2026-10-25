// Original 121-tool layout, catalog selection rule and inspector dimensions.
// Draft inspector dimensions are the original nominal 2.2 x 2.6 x 3.2 m;
// rendered geometry comes from original-tool-geometry.ts, without scaling to these labels.
// Source: assets/legacy/<snapshot>/raw/twin/layout-default.json + SemiconFab catalog.json.
// Coordinates and dimensions are the original cleanroom metres.

export type FabToolCategory = 'lithography' | 'resist_track' | 'dry_etch' | 'thin_film_deposition' | 'cmp' | 'wet_clean' | 'ion_implantation' | 'thermal_processing' | 'metrology' | 'inspection' | 'packaging' | 'test' | 'other';

export interface FabLayoutTool {
  readonly recordId: string;
  readonly rotationDegrees: number;
  readonly originalKind: 'draft' | 'catalog';
  readonly dimensionTier: string;
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly category: FabToolCategory;
  readonly vendor: string;
  readonly model: string;
}


export const FAB_LAYOUT: readonly FabLayoutTool[] = [
  { recordId: 'c327b57f-9e72-50d5-87a3-0986242ffb86', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -31, z: -22.5, width: 2.2, depth: 2.6, height: 3.2, category: 'lithography', vendor: 'ASML', model: 'TWINSCAN NXT:2050i' },
  { recordId: '80de0311-3bee-589e-be9e-c6e58527668c', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: -24, z: -22.5, width: 2.2, depth: 2.6, height: 3.2, category: 'lithography', vendor: 'ASML', model: 'TWINSCAN NXT:2000i' },
  { recordId: 'a46a0eaf-8fac-578a-b4d0-3496f2cb94f2', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -31, z: -17.5, width: 2.2, depth: 2.6, height: 3.2, category: 'lithography', vendor: 'ASML', model: 'TWINSCAN NXE:3400C' },
  { recordId: '640e01d7-420a-5ada-b39c-0e363ec47f11', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: -24, z: -17.5, width: 2.2, depth: 2.6, height: 3.2, category: 'lithography', vendor: 'ASML', model: 'TWINSCAN NXE:3600D' },
  { recordId: 'cde65e61-a3f5-5b18-a11f-7c2a9a220442', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -31, z: -12.5, width: 2.2, depth: 2.6, height: 3.2, category: 'lithography', vendor: 'ASML', model: 'TWINSCAN NXE:3800E' },
  { recordId: 'bc44c286-8316-5bcf-867e-6990181bc9c4', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: -24, z: -12.5, width: 2.2, depth: 2.6, height: 3.2, category: 'lithography', vendor: 'ASML', model: 'TWINSCAN EXE:5000' },
  { recordId: '752bb9b8-00dc-594d-9003-4e49aaf84d94', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -31, z: -7.5, width: 2.2, depth: 2.6, height: 3.2, category: 'lithography', vendor: 'ASML', model: 'TWINSCAN EXE:5200 / 5200B' },
  { recordId: 'c20129c0-b029-5da5-8576-fdabf3f96753', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: -24, z: -7.5, width: 2.2, depth: 2.6, height: 3.2, category: 'lithography', vendor: 'Nikon', model: 'NSR-S635E' },
  { recordId: '5b0a3bb2-da3e-5981-9431-99e04edda4c0', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -32.75, z: -1.5, width: 2.2, depth: 2.6, height: 3.2, category: 'resist_track', vendor: 'Tokyo Electron', model: 'CLEAN TRACK ACT 12' },
  { recordId: 'b8574715-05b3-5bd4-9449-3c34dd00ed02', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -29.25, z: -1.5, width: 2.2, depth: 2.6, height: 3.2, category: 'resist_track', vendor: 'Tokyo Electron', model: 'CLEAN TRACK LITHIUS Pro Z' },
  { recordId: '5b0a3bb2-da3e-5981-9431-99e04edda4c0', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -25.75, z: -1.5, width: 2.2, depth: 2.6, height: 3.2, category: 'resist_track', vendor: 'Tokyo Electron', model: 'CLEAN TRACK ACT 12' },
  { recordId: 'b8574715-05b3-5bd4-9449-3c34dd00ed02', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -22.25, z: -1.5, width: 2.2, depth: 2.6, height: 3.2, category: 'resist_track', vendor: 'Tokyo Electron', model: 'CLEAN TRACK LITHIUS Pro Z' },
  { recordId: '5b0a3bb2-da3e-5981-9431-99e04edda4c0', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: -32.75, z: 4.5, width: 2.2, depth: 2.6, height: 3.2, category: 'resist_track', vendor: 'Tokyo Electron', model: 'CLEAN TRACK ACT 12' },
  { recordId: 'b8574715-05b3-5bd4-9449-3c34dd00ed02', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: -29.25, z: 4.5, width: 2.2, depth: 2.6, height: 3.2, category: 'resist_track', vendor: 'Tokyo Electron', model: 'CLEAN TRACK LITHIUS Pro Z' },
  { recordId: '5b0a3bb2-da3e-5981-9431-99e04edda4c0', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: -25.75, z: 4.5, width: 2.2, depth: 2.6, height: 3.2, category: 'resist_track', vendor: 'Tokyo Electron', model: 'CLEAN TRACK ACT 12' },
  { recordId: 'b8574715-05b3-5bd4-9449-3c34dd00ed02', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: -22.25, z: 4.5, width: 2.2, depth: 2.6, height: 3.2, category: 'resist_track', vendor: 'Tokyo Electron', model: 'CLEAN TRACK LITHIUS Pro Z' },
  { recordId: 'c88c9684-f141-5d2f-9c83-2ec670767089', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -10.5, z: -23.5, width: 2.2, depth: 2.6, height: 3.2, category: 'dry_etch', vendor: 'Lam Research', model: '2300 Versys Kiyo3x / Kiyo F series' },
  { recordId: 'dbaa6c67-67ba-52e5-8406-f0358e5eda94', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -10.5, z: -19.5, width: 2.2, depth: 2.6, height: 3.2, category: 'dry_etch', vendor: 'Lam Research', model: 'Flex G Series' },
  { recordId: '2ce14b1f-68b3-5111-a9c4-1e1191ca6272', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -10.5, z: -15.5, width: 2.2, depth: 2.6, height: 3.2, category: 'dry_etch', vendor: 'Lam Research', model: '2300 Syndion / Syndion GP' },
  { recordId: '7ae544a6-85c8-56e6-b84d-a942fffd85af', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -10.5, z: -11.5, width: 2.2, depth: 2.6, height: 3.2, category: 'dry_etch', vendor: 'Lam Research', model: 'Vantex' },
  { recordId: 'e75be56f-ac9d-5f9c-97d8-dc8788185d22', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -10.5, z: -7.5, width: 2.2, depth: 2.6, height: 3.2, category: 'dry_etch', vendor: 'Tokyo Electron', model: 'Tactras Vigus' },
  { recordId: 'a5dc900e-762e-57ab-aa7c-9fea763e60b9', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -6.5, z: -23.5, width: 2.2, depth: 2.6, height: 3.2, category: 'dry_etch', vendor: 'Tokyo Electron', model: 'Tactras-UDEMAE' },
  { recordId: 'f5e193da-325c-51c6-b39e-b79a5c34f4bd', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -6.5, z: -19.5, width: 2.2, depth: 2.6, height: 3.2, category: 'dry_etch', vendor: 'Applied Materials', model: 'Centura AdvantEdge (Mesa)' },
  { recordId: '0fa9f3d2-9283-50cc-b179-5ce3eea7715f', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -6.5, z: -15.5, width: 2.2, depth: 2.6, height: 3.2, category: 'dry_etch', vendor: 'Applied Materials', model: 'Producer Etch' },
  { recordId: 'ca805c75-37f2-590e-96c0-d10090990e6c', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -6.5, z: -11.5, width: 2.2, depth: 2.6, height: 3.2, category: 'dry_etch', vendor: 'Hitachi High-Tech', model: 'M-8000 Series (Conductor Etch)' },
  { recordId: '15a7fae3-29b8-5be4-90e6-d2124bff4b0c', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -6.5, z: -7.5, width: 2.2, depth: 2.6, height: 3.2, category: 'dry_etch', vendor: 'Hitachi High-Tech', model: 'EMCP Etch Chamber' },
  { recordId: '8e4c6025-2b2d-5f90-adc5-89a7cc5c787e', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: -2.5, z: -23.5, width: 2.2, depth: 2.6, height: 3.2, category: 'dry_etch', vendor: 'AMEC', model: 'Primo HD-RIE' },
  { recordId: '8e8831fb-1f58-5bdc-9d46-160abc86c1fe', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: -2.5, z: -19.5, width: 2.2, depth: 2.6, height: 3.2, category: 'dry_etch', vendor: 'AMEC', model: 'Primo XD-RIE' },
  { recordId: '830aae95-3738-5796-9f9a-ab6737647d28', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: -2.5, z: -15.5, width: 2.2, depth: 2.6, height: 3.2, category: 'dry_etch', vendor: 'NAURA', model: '(model not disclosed)' },
  { recordId: '556a9772-9972-5c70-b0bd-8ca790b4156e', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: -2.5, z: -11.5, width: 2.2, depth: 2.6, height: 3.2, category: 'dry_etch', vendor: 'NAURA', model: 'NMC612H' },
  { recordId: '26f68b6d-99a8-510a-9319-ae7c6ba9225e', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 1.5, z: -23.5, width: 2.2, depth: 2.6, height: 3.2, category: 'dry_etch', vendor: 'NAURA', model: 'Acme Glaion130' },
  { recordId: 'c88c9684-f141-5d2f-9c83-2ec670767089', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 1.5, z: -19.5, width: 2.2, depth: 2.6, height: 3.2, category: 'dry_etch', vendor: 'Lam Research', model: '2300 Versys Kiyo3x / Kiyo F series' },
  { recordId: 'dbaa6c67-67ba-52e5-8406-f0358e5eda94', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 1.5, z: -15.5, width: 2.2, depth: 2.6, height: 3.2, category: 'dry_etch', vendor: 'Lam Research', model: 'Flex G Series' },
  { recordId: '2ce14b1f-68b3-5111-a9c4-1e1191ca6272', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 1.5, z: -11.5, width: 2.2, depth: 2.6, height: 3.2, category: 'dry_etch', vendor: 'Lam Research', model: '2300 Syndion / Syndion GP' },
  { recordId: 'e6a771bf-392c-51f8-a79b-95bdf6e51980', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 13.5, z: -23.5, width: 2.2, depth: 2.6, height: 3.2, category: 'thin_film_deposition', vendor: 'Applied Materials', model: 'Producer GT' },
  { recordId: 'd32faad5-0b46-5364-a423-d7d6ccd06d19', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 13.5, z: -19.5, width: 2.2, depth: 2.6, height: 3.2, category: 'thin_film_deposition', vendor: 'Applied Materials', model: 'Endura 5500/XP' },
  { recordId: '7bfdc673-da69-5c8e-ad61-15a64b78dac9', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 13.5, z: -15.5, width: 2.2, depth: 2.6, height: 3.2, category: 'thin_film_deposition', vendor: 'Lam Research', model: 'Vector Extreme' },
  { recordId: '6b2814d7-78f4-57be-a738-3a4b64501406', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 13.5, z: -11.5, width: 2.2, depth: 2.6, height: 3.2, category: 'thin_film_deposition', vendor: 'Lam Research', model: 'Striker FE' },
  { recordId: 'd789e8ed-c89d-577b-ac0a-001f076565df', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 13.5, z: -7.5, width: 2.2, depth: 2.6, height: 3.2, category: 'thin_film_deposition', vendor: 'ASM International', model: 'Epsilon 300' },
  { recordId: '46eb2c49-e770-5b66-adcf-5efc55366f3c', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 17.5, z: -23.5, width: 2.2, depth: 2.6, height: 3.2, category: 'thin_film_deposition', vendor: 'ASM International', model: 'Intrepid ES' },
  { recordId: '9a91170f-bca1-56b6-b6d9-c57b16e696a2', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 17.5, z: -19.5, width: 2.2, depth: 2.6, height: 3.2, category: 'thin_film_deposition', vendor: 'Tokyo Electron', model: 'Trias' },
  { recordId: '86c91512-c56a-5b1a-a573-67ed75449aec', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 17.5, z: -15.5, width: 2.2, depth: 2.6, height: 3.2, category: 'thin_film_deposition', vendor: 'Kokusai Electric', model: 'TSURUGI-C2' },
  { recordId: 'c519ba08-2236-5b8a-9059-bcb6279fae8b', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 17.5, z: -11.5, width: 2.2, depth: 2.6, height: 3.2, category: 'thin_film_deposition', vendor: 'NAURA', model: 'Cygnus PECVD' },
  { recordId: '97fd4069-802a-5f8c-9835-06c29603480e', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 17.5, z: -7.5, width: 2.2, depth: 2.6, height: 3.2, category: 'thin_film_deposition', vendor: 'AMEC', model: 'Prismo A7' },
  { recordId: '6828d3b2-1285-5ed5-8125-64f9ee5f5130', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 22.5, z: -23.5, width: 2.2, depth: 2.6, height: 3.2, category: 'thin_film_deposition', vendor: 'Piotech', model: 'PF-300T' },
  { recordId: '4566b1a5-caae-5be9-a767-09a2ee8b84db', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 22.5, z: -19.5, width: 2.2, depth: 2.6, height: 3.2, category: 'thin_film_deposition', vendor: 'Piotech', model: 'FT-300T' },
  { recordId: 'e6a771bf-392c-51f8-a79b-95bdf6e51980', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 22.5, z: -15.5, width: 2.2, depth: 2.6, height: 3.2, category: 'thin_film_deposition', vendor: 'Applied Materials', model: 'Producer GT' },
  { recordId: 'd32faad5-0b46-5364-a423-d7d6ccd06d19', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 22.5, z: -11.5, width: 2.2, depth: 2.6, height: 3.2, category: 'thin_film_deposition', vendor: 'Applied Materials', model: 'Endura 5500/XP' },
  { recordId: '7bfdc673-da69-5c8e-ad61-15a64b78dac9', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 26.5, z: -23.5, width: 2.2, depth: 2.6, height: 3.2, category: 'thin_film_deposition', vendor: 'Lam Research', model: 'Vector Extreme' },
  { recordId: '6b2814d7-78f4-57be-a738-3a4b64501406', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 26.5, z: -19.5, width: 2.2, depth: 2.6, height: 3.2, category: 'thin_film_deposition', vendor: 'Lam Research', model: 'Striker FE' },
  { recordId: 'd789e8ed-c89d-577b-ac0a-001f076565df', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 26.5, z: -15.5, width: 2.2, depth: 2.6, height: 3.2, category: 'thin_film_deposition', vendor: 'ASM International', model: 'Epsilon 300' },
  { recordId: '46eb2c49-e770-5b66-adcf-5efc55366f3c', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 26.5, z: -11.5, width: 2.2, depth: 2.6, height: 3.2, category: 'thin_film_deposition', vendor: 'ASM International', model: 'Intrepid ES' },
  { recordId: '2c8ee49e-b417-50be-a642-6fe000760c2a', rotationDegrees: 0, originalKind: 'catalog', dimensionTier: 'inferred', x: -10.5, z: 7, width: 2.7, depth: 4.1, height: 2.5, category: 'cmp', vendor: 'Ebara', model: 'F-REX300' },
  { recordId: '1cf7aafa-36a9-57c7-bbab-b18ce6f8535d', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: -6.5, z: 7, width: 2.2, depth: 2.6, height: 3.2, category: 'cmp', vendor: 'Applied Materials', model: 'Reflexion LK Prime' },
  { recordId: '746eba13-baf5-5ec1-959c-ad66fd799932', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -10.5, z: 12, width: 2.2, depth: 2.6, height: 3.2, category: 'cmp', vendor: 'Applied Materials', model: 'Reflexion LK' },
  { recordId: '0274d687-f89d-5c0c-bd5d-61b502a60c15', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: -6.5, z: 12, width: 2.2, depth: 2.6, height: 3.2, category: 'cmp', vendor: 'Applied Materials', model: 'Reflexion LK Ecmp' },
  { recordId: 'c5ce9e6e-a036-55d6-8527-e01bff1f68f9', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -10.5, z: 17, width: 2.2, depth: 2.6, height: 3.2, category: 'cmp', vendor: 'Ebara', model: 'F-REX300S' },
  { recordId: '26b49060-218b-545a-ad86-eaa342c47fc5', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: -6.5, z: 17, width: 2.2, depth: 2.6, height: 3.2, category: 'cmp', vendor: 'Ebara', model: 'F-REX300X / F-REX300XA' },
  { recordId: '6d356eb0-506f-5d19-9bf1-6c3068bb0699', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -10.5, z: 22, width: 2.2, depth: 2.6, height: 3.2, category: 'cmp', vendor: 'Ebara', model: 'FREX200' },
  { recordId: 'e87575b6-6ce2-50c7-bd7b-cf8c1ca4e97b', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: -6.5, z: 22, width: 2.2, depth: 2.6, height: 3.2, category: 'cmp', vendor: 'Huahai Qingke', model: '(model not confirmed)' },
  { recordId: '5e19f35a-ac9d-50ee-b8c2-a836b6ee861f', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -1.5, z: 6.5, width: 2.2, depth: 2.6, height: 3.2, category: 'wet_clean', vendor: 'SCREEN', model: 'SU-3300' },
  { recordId: 'b5300e1d-9189-5962-81e2-64c1d3524339', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 2.5, z: 6.5, width: 2.2, depth: 2.6, height: 3.2, category: 'wet_clean', vendor: 'SCREEN', model: 'SS-3300S' },
  { recordId: '48494344-f8b9-5f1a-9995-80ad51cd7a01', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -1.5, z: 10.7, width: 2.2, depth: 2.6, height: 3.2, category: 'wet_clean', vendor: 'Tokyo Electron', model: 'CELLESTA SCD' },
  { recordId: 'e83fa592-c53f-548a-9c30-3dcd2b7c9fd7', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 2.5, z: 10.7, width: 2.2, depth: 2.6, height: 3.2, category: 'wet_clean', vendor: 'Tokyo Electron', model: 'CELLESTA -i MD' },
  { recordId: 'ffb7c3a3-7f53-5cbf-8337-ca7eb5b96638', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -1.5, z: 14.9, width: 2.2, depth: 2.6, height: 3.2, category: 'wet_clean', vendor: 'Lam Research', model: 'DV-Prime' },
  { recordId: '663778ae-ca7e-5e09-bb9c-a03c7a2d1cec', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 2.5, z: 14.9, width: 2.2, depth: 2.6, height: 3.2, category: 'wet_clean', vendor: 'Lam Research', model: 'Da Vinci' },
  { recordId: '57218784-3aaf-5203-80b1-3485be695b5e', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -1.5, z: 19.1, width: 2.2, depth: 2.6, height: 3.2, category: 'wet_clean', vendor: 'SEMES', model: '(model not disclosed)' },
  { recordId: '0692771c-1149-5fc9-be7d-98d849256bc8', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 2.5, z: 19.1, width: 2.2, depth: 2.6, height: 3.2, category: 'wet_clean', vendor: 'ACM Research', model: 'Ultra C Tahoe' },
  { recordId: '81497b52-7ff7-527f-8f82-a7ad2aa9e498', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -1.5, z: 23.3, width: 2.2, depth: 2.6, height: 3.2, category: 'wet_clean', vendor: 'ACMR', model: 'Ultra C VI' },
  { recordId: '5e19f35a-ac9d-50ee-b8c2-a836b6ee861f', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 2.5, z: 23.3, width: 2.2, depth: 2.6, height: 3.2, category: 'wet_clean', vendor: 'SCREEN', model: 'SU-3300' },
  { recordId: '7f4f54a9-d416-5a3c-a522-2064c07790d7', rotationDegrees: 0, originalKind: 'catalog', dimensionTier: 'inferred', x: 15.5, z: 6.5, width: 8.9, depth: 4.2, height: 2.86, category: 'ion_implantation', vendor: 'SRII', model: 'SRII-4.5M' },
  { recordId: '4876fdc8-11e8-5d2b-8fe9-5ad9ff8cda4e', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 13.5, z: 11.5, width: 2.2, depth: 2.6, height: 3.2, category: 'ion_implantation', vendor: 'Axcelis', model: 'Purion H200' },
  { recordId: 'fc9fa2bd-fe5a-5c9a-b679-aa8d7c727997', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 17.5, z: 11.5, width: 2.2, depth: 2.6, height: 3.2, category: 'ion_implantation', vendor: 'Axcelis', model: 'Purion XEmax' },
  { recordId: '8f81cb70-a28d-5804-b1fb-a76a4eab063c', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 13.5, z: 16, width: 2.2, depth: 2.6, height: 3.2, category: 'ion_implantation', vendor: 'Applied Materials', model: 'VIISta 900 3D' },
  { recordId: 'e5a97846-cf6d-5034-b7a2-13b30cdba992', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 17.5, z: 16, width: 2.2, depth: 2.6, height: 3.2, category: 'ion_implantation', vendor: 'Applied Materials', model: 'VIISta Trident XP2' },
  { recordId: '91cd500b-46ac-5a34-afd7-8cfba43a23ef', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 13.5, z: 20.5, width: 2.2, depth: 2.6, height: 3.2, category: 'ion_implantation', vendor: 'SMIT (Sumitomo Heavy Industries)', model: 'SHX-III (HC)' },
  { recordId: '836a5356-bd8f-563c-ae4f-b5a91235e1f6', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 17.5, z: 20.5, width: 2.2, depth: 2.6, height: 3.2, category: 'ion_implantation', vendor: 'Nissin Ion Equipment', model: 'EXCEED9600A' },
  { recordId: '841a47b6-428b-5c29-9ab9-5109afd9dc1e', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 13.5, z: 25, width: 2.2, depth: 2.6, height: 3.2, category: 'ion_implantation', vendor: 'Nissin Ion Equipment', model: 'IMPHEAT-II' },
  { recordId: '84ec4cb1-7fc7-5cf5-bbd0-9be5db89a817', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 23.5, z: 7, width: 2.2, depth: 2.6, height: 3.2, category: 'thermal_processing', vendor: 'Kokusai Electric', model: 'QUIXACE' },
  { recordId: '6964f52b-7e71-5a46-a03f-e1610a0374e8', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 27.5, z: 7, width: 2.2, depth: 2.6, height: 3.2, category: 'thermal_processing', vendor: 'ASM International', model: 'A412' },
  { recordId: '41c16e65-cc7c-5907-b2e2-98af1095dcd5', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 23.5, z: 12, width: 2.2, depth: 2.6, height: 3.2, category: 'thermal_processing', vendor: 'ASM International', model: 'SONORA' },
  { recordId: '47121709-93b4-5896-931e-1c6fe6290821', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 27.5, z: 12, width: 2.2, depth: 2.6, height: 3.2, category: 'thermal_processing', vendor: 'Tokyo Electron', model: 'Alpha-8SE' },
  { recordId: '0fcf58f8-4126-540b-8a8b-2fd77d23e18a', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 23.5, z: 17, width: 2.2, depth: 2.6, height: 3.2, category: 'thermal_processing', vendor: 'Tokyo Electron', model: 'Alpha 303i' },
  { recordId: '7ceaf1c8-7910-5bc9-bd68-adbd81367034', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 27.5, z: 17, width: 2.2, depth: 2.6, height: 3.2, category: 'thermal_processing', vendor: 'Applied Materials', model: 'Radiance Vantage' },
  { recordId: 'e08bdd1a-8dda-517c-8506-32bd3f3b5110', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 23.5, z: 22, width: 2.2, depth: 2.6, height: 3.2, category: 'thermal_processing', vendor: 'Mattson (now Ferrotec)', model: 'Helios' },
  { recordId: '4b5ef9ed-188c-5b4e-9d2e-d5fe27d2cd99', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 27.5, z: 22, width: 2.2, depth: 2.6, height: 3.2, category: 'thermal_processing', vendor: 'NAURA', model: '(model not disclosed)' },
  { recordId: '042c350c-d1a0-51f2-ba11-ef22e2507f73', rotationDegrees: 90, originalKind: 'draft', dimensionTier: 'inferred', x: -31, z: 10.5, width: 2.2, depth: 2.6, height: 3.2, category: 'metrology', vendor: 'KLA', model: 'Archer 750' },
  { recordId: '3a03fd80-7476-588a-919d-cf605f154958', rotationDegrees: 90, originalKind: 'draft', dimensionTier: 'inferred', x: -24, z: 10.5, width: 2.2, depth: 2.6, height: 3.2, category: 'metrology', vendor: 'KLA', model: 'SpectraShape 11k' },
  { recordId: '5f374ae5-af0d-5f2b-88a7-ce1863356bc5', rotationDegrees: 90, originalKind: 'draft', dimensionTier: 'inferred', x: -31, z: 13.5, width: 2.2, depth: 2.6, height: 3.2, category: 'metrology', vendor: 'KLA', model: 'Aleris 8500' },
  { recordId: '09b4a776-277f-5203-8f72-80361b049f10', rotationDegrees: 90, originalKind: 'draft', dimensionTier: 'inferred', x: -24, z: 13.5, width: 2.2, depth: 2.6, height: 3.2, category: 'metrology', vendor: 'KLA', model: '3935 (39xx series)' },
  { recordId: 'bdd36ff2-ada4-5655-8230-ccd30e4919a6', rotationDegrees: 90, originalKind: 'draft', dimensionTier: 'inferred', x: -31, z: 16.5, width: 2.2, depth: 2.6, height: 3.2, category: 'metrology', vendor: 'KLA', model: '2930 (29xx series)' },
  { recordId: '5adab9b7-42f7-5df0-be24-4e9f9a7e9fca', rotationDegrees: 90, originalKind: 'draft', dimensionTier: 'inferred', x: -24, z: 16.5, width: 2.2, depth: 2.6, height: 3.2, category: 'metrology', vendor: 'KLA', model: 'eDR7280' },
  { recordId: '65a9c409-0449-5ea6-a5df-089ae1bfb174', rotationDegrees: 90, originalKind: 'draft', dimensionTier: 'inferred', x: -31, z: 19.5, width: 2.2, depth: 2.6, height: 3.2, category: 'metrology', vendor: 'ASML', model: 'YieldStar 385' },
  { recordId: '03719f6a-8748-5223-b1d1-88769f43b79d', rotationDegrees: 90, originalKind: 'draft', dimensionTier: 'inferred', x: -24, z: 19.5, width: 2.2, depth: 2.6, height: 3.2, category: 'metrology', vendor: 'Onto Innovation', model: 'Atlas V' },
  { recordId: '1618a1eb-086d-5dbc-9635-1d7577b0602c', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -32.75, z: 25, width: 2.2, depth: 2.6, height: 3.2, category: 'inspection', vendor: 'KLA', model: '2920 Series Broadband Plasma Inspection' },
  { recordId: 'ac5b0753-0843-5980-a016-cc5297bb0438', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -29.25, z: 25, width: 2.2, depth: 2.6, height: 3.2, category: 'inspection', vendor: 'Applied Materials', model: 'UVision 4' },
  { recordId: '1618a1eb-086d-5dbc-9635-1d7577b0602c', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -25.75, z: 25, width: 2.2, depth: 2.6, height: 3.2, category: 'inspection', vendor: 'KLA', model: '2920 Series Broadband Plasma Inspection' },
  { recordId: 'ac5b0753-0843-5980-a016-cc5297bb0438', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: -22.25, z: 25, width: 2.2, depth: 2.6, height: 3.2, category: 'inspection', vendor: 'Applied Materials', model: 'UVision 4' },
  { recordId: '3e5137b6-78c4-5ac8-a6ef-912562fb9311', rotationDegrees: 0, originalKind: 'catalog', dimensionTier: 'independent_verified', x: 35.5, z: -23, width: 1.6, depth: 1.2, height: 1.54, category: 'packaging', vendor: 'BESI', model: 'Datacon 2200 EVO' },
  { recordId: 'cb1548a3-cdb0-5c6b-9798-f86b99ae10ad', rotationDegrees: 180, originalKind: 'catalog', dimensionTier: 'inferred', x: 39, z: -23, width: 2.2, depth: 3.6, height: 2.9, category: 'packaging', vendor: 'ACMR', model: 'Ultra ECP 3d' },
  { recordId: '1fdd1137-9952-5584-8236-48bd6f119cb6', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 42.5, z: -23, width: 2.2, depth: 2.6, height: 3.2, category: 'packaging', vendor: 'BESI', model: '9800 TC next' },
  { recordId: 'de700138-a965-51b6-b2c3-ec6e39d03c6f', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 35.5, z: -17.5, width: 2.2, depth: 2.6, height: 3.2, category: 'packaging', vendor: 'BESI', model: 'Datacon 8800 CHAMEO ultra plus' },
  { recordId: '4d551549-f6fb-514f-9fac-51c9f2eca182', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 39, z: -17.5, width: 2.2, depth: 2.6, height: 3.2, category: 'packaging', vendor: 'ASMPT', model: 'AD838L-G2' },
  { recordId: '3f391e71-feb9-5bb8-8c26-271898119fca', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 42.5, z: -17.5, width: 2.2, depth: 2.6, height: 3.2, category: 'packaging', vendor: 'ASMPT', model: 'AMICRA CoS Die Bonder' },
  { recordId: '333f4c12-f6d3-5e59-86ad-f34a93da85a1', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 35.5, z: -12, width: 2.2, depth: 2.6, height: 3.2, category: 'packaging', vendor: 'ASMPT', model: 'AERO PRO' },
  { recordId: 'ea7acafa-f623-5b53-9820-cff153396595', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 39, z: -12, width: 2.2, depth: 2.6, height: 3.2, category: 'packaging', vendor: 'EV Group', model: 'GEMINI FB XT' },
  { recordId: '0e08ee0e-204e-5c35-93ee-9d4449bd50de', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 42.5, z: -12, width: 2.2, depth: 2.6, height: 3.2, category: 'packaging', vendor: 'SUSS MicroTec', model: 'XBS200' },
  { recordId: 'b7dd05c1-c14a-5a5b-8c2c-237c1828de31', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 35.5, z: -6.8, width: 2.2, depth: 2.6, height: 3.2, category: 'packaging', vendor: 'Kulicke & Soffa', model: 'Asterion' },
  { recordId: '178aac84-6158-559f-a04e-1d86d6b5ad09', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 39, z: -6.8, width: 2.2, depth: 2.6, height: 3.2, category: 'packaging', vendor: 'Kulicke & Soffa', model: 'ASTERION-TW' },
  { recordId: '4dec86af-c292-57a5-95ef-535c36c929f4', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 42.5, z: -6.8, width: 2.2, depth: 2.6, height: 3.2, category: 'packaging', vendor: 'ACMR', model: 'Ultra ECP ap-p' },
  { recordId: 'dd6715e4-f628-5687-9e2a-8ede1b0d6071', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 36.8, z: -1.5, width: 2.2, depth: 2.6, height: 3.2, category: 'test', vendor: 'Advantest', model: 'V93000 EXA Scale' },
  { recordId: '640c395b-69d8-5a73-890f-6d72ef905241', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 41.2, z: -1.5, width: 2.2, depth: 2.6, height: 3.2, category: 'test', vendor: 'Advantest', model: 'T5835' },
  { recordId: '1bf9bd68-eaa2-5a6a-a0d6-81341e6b83de', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 36.8, z: 3.5, width: 2.2, depth: 2.6, height: 3.2, category: 'test', vendor: 'Advantest', model: 'T5833' },
  { recordId: '21a38ffd-f475-5a84-a4de-518a96be045f', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 41.2, z: 3.5, width: 2.2, depth: 2.6, height: 3.2, category: 'test', vendor: 'Teradyne', model: 'UltraFLEX' },
  { recordId: 'e7bff566-aa87-59c9-be15-c628195812e0', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 36.8, z: 8.5, width: 2.2, depth: 2.6, height: 3.2, category: 'test', vendor: 'Teradyne', model: 'J750Ex-HD' },
  { recordId: '0b9c07fe-924b-59c0-8922-bf120d0d5bf1', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'independent_verified', x: 41.2, z: 8.5, width: 2.2, depth: 2.6, height: 3.2, category: 'test', vendor: 'Cohu (Rasco)', model: 'Jupiter' },
  { recordId: 'edbdcab9-5356-5e8d-81f5-edb3843f21f5', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 36.8, z: 13.5, width: 2.2, depth: 2.6, height: 3.2, category: 'test', vendor: 'Cohu (Rasco)', model: 'Jaguar (SO3000)' },
  { recordId: 'b53c0b48-f9a7-5b68-9f78-981de60654e4', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 41.2, z: 13.5, width: 2.2, depth: 2.6, height: 3.2, category: 'test', vendor: 'Cohu (Rasco)', model: 'SO1000A' },
  { recordId: '888d0ee7-2fb8-52f1-909b-b36ac0f9509e', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 36.8, z: 18.5, width: 2.2, depth: 2.6, height: 3.2, category: 'test', vendor: 'Accretech (Tokyo Seimitsu)', model: 'UF3000EX' },
  { recordId: '400f5451-48aa-51d9-b987-cf98fa5a5566', rotationDegrees: 180, originalKind: 'draft', dimensionTier: 'inferred', x: 41.2, z: 18.5, width: 2.2, depth: 2.6, height: 3.2, category: 'test', vendor: 'Changchuan', model: 'CTA series' },
  { recordId: 'f0bb0ec9-b4d6-5086-a98d-fef8ae9ccd29', rotationDegrees: 0, originalKind: 'draft', dimensionTier: 'inferred', x: 39, z: 25, width: 2.2, depth: 2.6, height: 3.2, category: 'other', vendor: 'Edwards Vacuum', model: 'iXH1820' },
];

export type FabToolState = 'running' | 'idle' | 'down' | 'maint';

export const FAB_TOOL_STATE_META: Record<FabToolState, { label: string; color: string }> = {
  running: { label: '运行', color: '#10b981' },
  idle: { label: '待机', color: '#f59e0b' },
  down: { label: '故障', color: '#ef4444' },
  maint: { label: '维护', color: '#3b82f6' },
};

const stateFor = (index: number): FabToolState => {
  if (index > 0 && index % 19 === 0) return 'down';
  if (index > 0 && index % 13 === 0) return 'maint';
  if (index > 0 && index % 5 === 0) return 'idle';
  return 'running';
};

export const FAB_TOOL_STATES: readonly FabToolState[] = FAB_LAYOUT.map((_, index) => stateFor(index));
