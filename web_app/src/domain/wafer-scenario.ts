import { buildWaferWaypoints, type WaferProduct, type WaferRouteStep } from '@/domain/wafer-route';
import type { WaferBay, WaferScenario } from '@/domain/wafer-timeline';

// Frozen CATEGORY_BAYS names used by updateWaferFollowHUD (b3666132).
export const WAFER_BAYS: Readonly<Record<string, WaferBay>> = {
  lithography: { nameEn: 'Lithography Scanner Bay', nameZh: '光刻曝光核心间 (黄光区)' },
  resist_track: { nameEn: 'Resist Track & Coater/Dev Bay', nameZh: '涂胶显影跟踪机区 (黄光区)' },
  dry_etch: { nameEn: 'Plasma Dry Etch & Strip Bay', nameZh: '等离子干法刻蚀区' },
  thin_film_deposition: { nameEn: 'Thin Film Deposition (CVD/PVD/ALD)', nameZh: '薄膜沉积与外延区' },
  thermal_processing: { nameEn: 'Thermal Diffusion & Oxidation Bay', nameZh: '高温氧化扩散炉管区' },
  ion_implantation: { nameEn: 'Ion Implantation Bay', nameZh: '离子注入机区' },
  cmp: { nameEn: 'CMP Chemical Mechanical Planarization Bay', nameZh: '化学机械研磨平坦化区' },
  wet_clean: { nameEn: 'Automated Wet Cleaning Bay', nameZh: '湿法清洗腐蚀工作台区' },
  metrology: { nameEn: 'In-line CD-SEM & Thin Film Metrology', nameZh: '在线微观量测与椭偏仪区' },
  inspection: { nameEn: 'Darkfield Wafer Defect Inspection Bay', nameZh: '光学缺陷暗场检测区' },
  packaging: { nameEn: 'Advanced 2.5D/3D Packaging Bay', nameZh: '先进封装与异构集成区' },
  test: { nameEn: 'Wafer Sort & ATE Final Test Bay', nameZh: '晶圆探针测试与ATE分选区' },
  other: { nameEn: 'Facility Support & Auxiliary Systems', nameZh: '厂务辅助与综合保障区' },
};

export function buildWaferScenario(routes: Record<WaferProduct, WaferRouteStep[]>, language: 'zh' | 'en'): WaferScenario {
  const project = (product: WaferProduct) => buildWaferWaypoints(routes[product]).map(point => ({
    step: point.step, tool_group: point.toolGroup, recipe: point.recipe || null,
    category: point.category, x: point.x, y: point.y, z: point.z,
  }));
  return {
    clockStartMs: 0, frameMs: 1000 / 60, product: 'A', speed: 1,
    initialCamera: { x: 0, y: 52, z: 64 },
    hudLanguage: language === 'zh' ? 'zh-CN' : 'en', categoryBays: WAFER_BAYS,
    products: { A: project('A'), B: project('B'), C: project('C') },
  };
}
