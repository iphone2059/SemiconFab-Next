/** Presentation-only formatters for the Workbench feature. */
export const isCompleted = (status: string): boolean => status.toUpperCase() === 'COMPLETED';

export const formatCount = (value: string): string => BigInt(value).toLocaleString('zh-CN');
