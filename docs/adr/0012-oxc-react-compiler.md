# ADR-0012 — Rust/Oxc React Compiler 接入

- Status: Accepted (2026-10-29)，experimental 构建期优化
- Related: [ADR-0011](0011-effect4-runtime-architecture.md)（运行时架构不变）
- 证据：[Task 7 验收](../architecture/evidence/effect4-task7-react-compiler.md)

## Decision

- 使用 `@vitejs/plugin-react@6.1.2` 的 `compiler` 选项驱动 **Rust/Oxc** `oxc-transform-react@0.156.0`；
  `target: '19' | compilationMode: 'infer' | reportDiagnostics: true`。
- 不安装/不使用 Babel React Compiler（`babel-plugin-react-compiler`、`@rolldown/plugin-babel`、`@babel/core`）。
- React 19 从 `react/compiler-runtime` 取 runtime；不安装 `react-compiler-runtime`。
- 新增 Oxlint React correctness 门禁；违规必须改代码，不允许整批 suppress。
- 转换是否实际发生由 `tests/architecture/oxc-react-compiler.test.ts` 直接 transform fixture 证明，Vite 配置字符串不作为唯一证据。
- 现有手写 memoization 不强制删除；后续按测量逐处处理。

## Known risks / validation

- Oxc compiler 仍为 experimental；构建可恢复诊断表示部分函数被跳过。
- 实测 0.156.0 对组件内 BigInt/reduce 有误编译，已通过组件外 helper 规避并记录。
- 可变 Registry 读取会被 compiler memoize，已为 telemetry/runtime registry 引入 external-store/version 读取。
- plugin 6.1.2 的 peer 元数据为 `^0.152.0`，与 0.156.0 不匹配；通过显式 pnpm peer rule + Windows binding/构建/测试/浏览器验证接受该偏差。
- bundle gzip +5.37%；渲染 p95/p99 无退化；e2e React commit 数略降；不以 Oxc 编译速度宣传运行时收益。
