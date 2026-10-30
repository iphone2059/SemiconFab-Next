/**
 * Compatibility re-export: the canonical strict option validators live in
 * contracts/command-config.ts so the realtime transport can use them without
 * importing a runtime implementation (ARCH-06). Runtime modules may import
 * either path; new code should import '@/contracts/command-config'.
 */
export * from '@/contracts/command-config';
