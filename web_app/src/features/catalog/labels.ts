import type { Preferences } from '../../state/preferences';

export type Language = Preferences['language'];

/** Small bilingual text selector; every catalog surface goes through it. */
export const text = (language: Language, zh: string, en: string): string =>
  language === 'zh' ? zh : en;

export const valueText = (value: unknown): string =>
  value === null || value === undefined
    ? '—'
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);

const categoryNames: Readonly<Record<string, readonly [string, string]>> = {
  lithography: ['光刻', 'Lithography'],
  resist_track: ['涂胶显影', 'Resist track'],
  dry_etch: ['干法刻蚀', 'Dry etch'],
  wet_clean: ['湿法清洗', 'Wet clean'],
  thin_film_deposition: ['薄膜沉积', 'Thin film deposition'],
  cmp: ['化学机械抛光', 'CMP'],
  thermal_processing: ['热处理', 'Thermal processing'],
  ion_implantation: ['离子注入', 'Ion implantation'],
  metrology: ['量测', 'Metrology'],
  inspection: ['检测', 'Inspection'],
  test: ['测试', 'Test'],
  packaging: ['封装', 'Packaging'],
  other: ['其他', 'Other'],
  osat_dicing: ['OSAT 划片', 'OSAT dicing'],
  osat_die_attach: ['OSAT 固晶', 'OSAT die attach'],
  osat_wire_bonding: ['OSAT 引线键合', 'OSAT wire bonding'],
  osat_flip_chip: ['OSAT 倒装', 'OSAT flip chip'],
  osat_molding: ['OSAT 塑封', 'OSAT molding'],
  osat_singulation: ['OSAT 分割', 'OSAT singulation'],
  osat_bumping_rdl: ['OSAT 凸点 / RDL', 'OSAT bumping / RDL'],
  osat_prober: ['OSAT 探针台', 'OSAT prober'],
  osat_ate: ['OSAT 自动测试', 'OSAT ATE'],
  osat_test_handler: ['OSAT 测试分选', 'OSAT test handler'],
  osat_inspection: ['OSAT 检测', 'OSAT inspection'],
};

export const categoryText = (category: string, language: Language): string =>
  categoryNames[category]?.[language === 'zh' ? 0 : 1] ?? category;
