export interface ScenarioFields { lotCount: string; processTimeUs: string; durationUs: string; warmupUs: string; masterSeed: string }
export function validateScenario(fields: ScenarioFields): string | undefined {
  if (!Object.values(fields).every(value => /^(0|[1-9][0-9]*)$/.test(value))) return '参数必须为非负十进制整数；时间单位为微秒。';
  const lots = BigInt(fields.lotCount);
  if (lots < 1n || lots > 10000n) return 'Lot 数须为 1–10000 的整数。';
  const times = [fields.processTimeUs, fields.durationUs, fields.warmupUs].map(value => BigInt(value));
  if (times.some(value => value > 9223372036854775807n) || times[0] < 1n || times[1] < 1n || times[2] >= times[1]) return '加工时长与时域须大于零，预热须小于时域，时间须在 int64 范围内。';
  if (BigInt(fields.masterSeed) > 18446744073709551615n) return '主随机种子须在 uint64 范围内。';
  return undefined;
}
