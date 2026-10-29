import type { SceneLayer, XRayFilter } from '@/contracts/scene.port';

/** localStorage key of the "don't show again" onboarding preference. */
export const ONBOARDING_KEY = 'semicon_twin_onboarding_dismissed';

/** Frozen first-run onboarding copy (zh source strings translated by TwinLocale). */
export const ONBOARDING_STEPS = [
  { title: '一个单 FAB 洁净室', body: '121 台设备、双环 OHT、天花板 FFU 与 Subfab 都在同一场景中。' },
  { title: '层级与空间模式', body: '用 L1 / B1 / DUAL / Explode 切换楼层和拆解；设备卡可打开右侧检查器。' },
  { title: '开始五站导览', body: 'Tour 会依次带你查看光刻、刻蚀、OHT 和 Subfab。按 Esc 可退出。' },
];

export const CATEGORY_LABELS: Record<string, string> = {
  lithography: '光刻',
  resist_track: '涂胶显影',
  dry_etch: '干法刻蚀',
  thin_film_deposition: '薄膜沉积',
  cmp: '化学机械抛光',
  wet_clean: '湿法清洗',
  ion_implantation: '离子注入',
  thermal_processing: '热处理',
  metrology: '量测',
  inspection: '检测',
  packaging: '封装',
  test: '测试',
  other: '其他设备',
};

export const LAYER_LABELS: { layer: SceneLayer; label: string }[] = [
  { layer: 'amhs', label: 'AMHS' },
  { layer: 'ceiling', label: 'FFU' },
  { layer: 'roof', label: 'Roof/HVAC' },
  { layer: 'subfab', label: 'Subfab' },
  { layer: 'heatmap', label: 'Heatmap' },
  { layer: 'airflow', label: 'Airflow' },
];

export const XRAY_FILTERS: { filter: XRayFilter; label: string }[] = [
  { filter: 'all', label: 'ALL' },
  { filter: 'upw', label: 'UPW Water' },
  { filter: 'gas', label: 'GAS Specialty' },
  { filter: 'vac', label: 'VAC Vacuum' },
  { filter: 'exhaust', label: 'EXHAUST' },
  { filter: 'amhs', label: 'AMHS Track' },
];
