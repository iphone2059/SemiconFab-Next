# Local class names and shared Radix dialogs

User decision: implement the small clsx-style utility locally in TypeScript,
without a clsx dependency; adopt @radix-ui/react-dialog for modal behavior.
Base: 62ad5af. Keep existing CSS, data identities, translations and GPU behavior.

1. Add failing classNames tests for falsy inputs, numeric/string tokens, nested
   readonly arrays and truthy object keys. Implement a small typed traversal based
   on clsx 2.1.1 semantics; retain attribution and its MIT notice in public assets.
   Adopt it for compound conditional classes, not every trivial ternary.
2. Add failing shared-modal tests for accessible title, close, focus return,
   keyboard trapping and nested Escape isolation. Install pinned Radix Dialog
   using the project's pinned pnpm entry; keep lockfiles consistent.
3. Implement one controlled Modal wrapper with Radix Portal/Overlay/Content and
   Title. Preserve existing element classes and parent-owned state. Migrate the
   Twin information dialogs, YMS and catalog detail dialog. Delete the obsolete
   focus-trap helper. Keep non-modal onboarding outside the abstraction.
4. Run typecheck, full Vitest, build and architecture checks. Check real-browser
   focus/Tab/Escape/backdrop behavior, theme/layout and GPU viewport isolation.
   Record actual bundle deltas and get independent read-only review.

Review focus: no trigger element on URL-opened dialogs; trigger removed before
close; only topmost modal handles Escape; portals preserve theme variables;
outside pointer handling must not select/move the 3D scene; long modal content
still scrolls. Do not add another state store, UI theme system or 3D dependency.

## Verification (2026-10-28)

- `scripts/verify.ps1` exit 0: contract/architecture/migration checks, 8 Python
  tool tests, 13 render-perf unit tests, 3 .NET projects built with 177/177
  tests, frozen pnpm install, `tsc --noEmit` 0, Vitest 88 files / 503 tests and
  `vite build` 0.
- Headless Chrome CDP probes: catalog detail dialog 12/12; Twin WebGPU
  architecture dialog 15/15 (GPU keeps rendering behind the modal, Escape and
  overlay dismiss preserve the selection and camera pose). Raw artifacts live
  under `.local/ui-primitives-20261028/`.
- Bundle: +38,336 B raw / +10,459 B gzip across built assets; the Radix tree is
  grouped into the existing `react` chunk by `manualChunks(id.includes('react'))`.

See `ui-primitives-2026-10-28.json`.

## Update (2026-10-28): native <dialog>

产品决定不保留 Radix：同一 `Modal` seam 已改为原生 `<dialog>` 实现，删除
`@radix-ui/react-dialog` 及 24 个传递依赖，并用 `::backdrop`、自身 Tab
循环、滚动锁与焦点恢复补齐交互。验证与包体数据见
`native-dialog-2026-10-28.json`；本文件此前记录的 Radix 方案已被取代。
后续清理（`dc37794`）：生产代码移除 showModal/属性兜底与手写焦点恢复，只调用原生
`showModal()/close()`；jsdom 缺少的 dialog 契约改由测试专用
`tests/support/native-dialog.ts` 提供，不进入构建产物。

See `native-dialog-2026-10-28.json`.