# Task 0：生产源码文件归属与目标路径清单

- 生成时间：2026-10-29（Asia/Singapore）
- 基线：`4fc8a94`（远端 main）；工作树 `.local/worktrees/effect4-flat`
- 范围：`web_app/src` 全部 196 个 TypeScript/TSX 文件
- 说明：迁移动作列标明该文件在 Task 1 的移动/改写/删除动作；后续任务列注明临时文件（Query/Zustand）将在哪一任务删除或拆分。

| # | 当前路径 | Task 1 目标路径 | 目标模块 | 迁移动作/后续任务 |
|---|---|---|---|---|
| 1 | `web_app/src/api/cache/equipment-status-bridge.ts` | `api/equipment-status.resource.ts` | api | split: gate -> realtime/equipment-status.gate.ts; snapshot atom -> api/equipment-status.resource.ts; REST/SSE coordination -> runtime/ |
| 2 | `web_app/src/api/mutations/commands.mutations.ts` | `api/commands.mutation.ts` | api | move |
| 3 | `web_app/src/api/mutations/runs.mutations.ts` | `api/runs.mutation.ts` | api | move |
| 4 | `web_app/src/api/queries/catalog.queries.ts` | `api/catalog.resource.ts` | api | move: becomes resource atom in Task 5 |
| 5 | `web_app/src/api/queries/equipment.queries.ts` | `api/equipment.resource.ts` | api | move: becomes resource atom in Task 5 |
| 6 | `web_app/src/api/queries/queryClient.ts` | `api/query-client.ts` | api | move-temp: removed in Task 5 |
| 7 | `web_app/src/api/queries/queryKeys.ts` | `api/query-keys.ts` | api | move-temp: removed in Task 5 |
| 8 | `web_app/src/api/queries/research.queries.ts` | `api/research.resource.ts` | api | move: becomes resource atom in Task 5 |
| 9 | `web_app/src/api/queries/runs.queries.ts` | `api/runs.resource.ts` | api | move: becomes resource atom in Task 5 |
| 10 | `web_app/src/api/queries/sites.queries.ts` | `api/sites.resource.ts` | api | move: becomes resource atom in Task 5 |
| 11 | `web_app/src/api/queries/wafer.queries.ts` | `api/wafer.resource.ts` | api | move: becomes resource atom in Task 5 |
| 12 | `web_app/src/api/schemas/catalog.schema.ts` | `api/catalog.schema.ts` | api | move: Effect Schema in Task 3 |
| 13 | `web_app/src/api/schemas/command.schema.ts` | `api/command.schema.ts` | api | move: Effect Schema in Task 3 |
| 14 | `web_app/src/api/schemas/runs.schema.ts` | `api/runs.schema.ts` | api | move: Effect Schema in Task 3 |
| 15 | `web_app/src/api/transport/HttpCommandGateway.ts` | `api/http-command-gateway.ts` | api | move |
| 16 | `web_app/src/api/transport/http.ts` | `api/http.transport.ts` | api | move |
| 17 | `web_app/src/app/providers/AppProviders.tsx` | `app/app-providers.tsx` | app | move |
| 18 | `web_app/src/app/providers/QueryProvider.tsx` | `app/query-provider.tsx` | app | move-temp: removed in Task 5 |
| 19 | `web_app/src/app/providers/RuntimeBootstrap.tsx` | `app/runtime-bootstrap.tsx` | app | move |
| 20 | `web_app/src/app/providers/RuntimeProvider.tsx` | `app/runtime-provider.tsx` | app | move |
| 21 | `web_app/src/app/providers/TelemetryProvider.tsx` | `app/telemetry-provider.tsx` | app | move |
| 22 | `web_app/src/app/router/route-data.ts` | `routes/route-data.ts` | routes | move |
| 23 | `web_app/src/app/router/routeTree.gen.ts` | （删除） | routes | delete: replaced by code route tree |
| 24 | `web_app/src/app/router/router.tsx` | `routes/router.tsx` | routes | move |
| 25 | `web_app/src/app/router/routes/__root.tsx` | `routes/root.route.tsx` | routes | rewrite: file route -> code route |
| 26 | `web_app/src/app/router/routes/equipment.tsx` | `routes/equipment.route.tsx` | routes | rewrite: file route -> code route |
| 27 | `web_app/src/app/router/routes/equipment/compare.tsx` | `routes/equipment-compare.route.tsx` | routes | rewrite: file route -> code route |
| 28 | `web_app/src/app/router/routes/equipment/index.tsx` | `routes/equipment-index.route.tsx` | routes | rewrite: file route -> code route |
| 29 | `web_app/src/app/router/routes/fabs/$fabId/3d.tsx` | `routes/fab-3d.route.tsx` | routes | rewrite: file route -> code route |
| 30 | `web_app/src/app/router/routes/index.tsx` | `routes/home.route.tsx` | routes | rewrite: file route -> code route |
| 31 | `web_app/src/app/router/search.ts` | `routes/route-search.ts` | routes | move |
| 32 | `web_app/src/app/router/url-mapping.ts` | `routes/route-url-mapping.ts` | routes | move |
| 33 | `web_app/src/application/contracts/CommandEvents.ts` | `contracts/command-events.contract.ts` | contracts | move |
| 34 | `web_app/src/application/contracts/CommandGateway.ts` | `contracts/command-gateway.contract.ts` | contracts | move |
| 35 | `web_app/src/application/contracts/CommandWorkflow.ts` | `contracts/command-workflow.contract.ts` | contracts | move |
| 36 | `web_app/src/application/coordination/CommandCorrelationRegistry.ts` | `runtime/command-correlation-registry.ts` | runtime | move |
| 37 | `web_app/src/application/coordination/CommandEventBridge.ts` | `runtime/command-event-bridge.ts` | runtime | move |
| 38 | `web_app/src/application/coordination/CommandEventRecovery.ts` | `runtime/command-event-recovery.ts` | runtime | move |
| 39 | `web_app/src/application/coordination/ScopeGate.ts` | `runtime/scope-gate.ts` | runtime | move |
| 40 | `web_app/src/application/ports/scene.ts` | `contracts/scene.port.ts` | contracts | move |
| 41 | `web_app/src/components/class-names.ts` | `components/class-names.ts` | components | move |
| 42 | `web_app/src/components/error-boundary.tsx` | `components/error-boundary.tsx` | components | move |
| 43 | `web_app/src/components/modal.tsx` | `components/modal.tsx` | components | move |
| 44 | `web_app/src/components/original-icons-data.ts` | `components/original-icons-data.ts` | components | move |
| 45 | `web_app/src/components/original-icons.tsx` | `components/original-icons.tsx` | components | move |
| 46 | `web_app/src/contracts.ts` | `contracts/app-contracts.ts` | contracts | split: shared DTO barrel split into contracts/*.contract.ts |
| 47 | `web_app/src/domain/amhs/amhs-timeline.ts` | `domain/amhs-amhs-timeline.ts` | domain | move: domain flat |
| 48 | `web_app/src/domain/equipment/tool-state-projection.ts` | `domain/equipment-tool-state-projection.ts` | domain | move: domain flat |
| 49 | `web_app/src/domain/fab/cleanroom-pressure.ts` | `domain/fab-cleanroom-pressure.ts` | domain | move: domain flat |
| 50 | `web_app/src/domain/fab/fab-layout.ts` | `domain/fab-layout.ts.ts` | domain | move: domain flat |
| 51 | `web_app/src/domain/fab/fab-yield.ts` | `domain/fab-yield.ts.ts` | domain | move: domain flat |
| 52 | `web_app/src/domain/fab/layout-identities.ts` | `domain/fab-layout-identities.ts` | domain | move: domain flat |
| 53 | `web_app/src/domain/fab/original-twin-data.ts` | `domain/original-twin-data.ts.ts` | domain | move: domain flat |
| 54 | `web_app/src/domain/fab/process-control.ts` | `domain/fab-process-control.ts` | domain | move: domain flat |
| 55 | `web_app/src/domain/fab/twin-spatial.ts` | `domain/fab-twin-spatial.ts` | domain | move: domain flat |
| 56 | `web_app/src/domain/math/round.ts` | `domain/math-round.ts` | domain | move: domain flat |
| 57 | `web_app/src/domain/math/vec3.ts` | `domain/math-vec3.ts` | domain | move: domain flat |
| 58 | `web_app/src/domain/personnel/personnel-timeline.ts` | `domain/personnel-personnel-timeline.ts` | domain | move: domain flat |
| 59 | `web_app/src/domain/simulation/original-tour.ts` | `domain/simulation-original-tour.ts` | domain | move: domain flat |
| 60 | `web_app/src/domain/simulation/research-replay.ts` | `domain/simulation-research-replay.ts` | domain | move: domain flat |
| 61 | `web_app/src/domain/simulation/scenario.ts` | `domain/simulation-scenario.ts` | domain | move: domain flat |
| 62 | `web_app/src/domain/simulation/tour-scenario.ts` | `domain/simulation-tour-scenario.ts` | domain | move: domain flat |
| 63 | `web_app/src/domain/simulation/tour-timeline.ts` | `domain/simulation-tour-timeline.ts` | domain | move: domain flat |
| 64 | `web_app/src/domain/simulation/twin-equipment.ts` | `domain/simulation-twin-equipment.ts` | domain | move: domain flat |
| 65 | `web_app/src/domain/wafer/wafer-map.ts` | `domain/wafer-wafer-map.ts` | domain | move: domain flat |
| 66 | `web_app/src/domain/wafer/wafer-route.ts` | `domain/wafer-wafer-route.ts` | domain | move: domain flat |
| 67 | `web_app/src/domain/wafer/wafer-scenario.ts` | `domain/wafer-wafer-scenario.ts` | domain | move: domain flat |
| 68 | `web_app/src/domain/wafer/wafer-timeline.ts` | `domain/wafer-wafer-timeline.ts` | domain | move: domain flat |
| 69 | `web_app/src/features/catalog/catalog-data.ts` | `catalog/catalog-data.ts` | catalog | move: feature flat |
| 70 | `web_app/src/features/catalog/catalog-page.tsx` | `catalog/catalog-page.tsx` | catalog | move: feature flat |
| 71 | `web_app/src/features/catalog/components/catalog-comparison.tsx` | `catalog/catalog-comparison.tsx` | catalog | move: feature flat |
| 72 | `web_app/src/features/catalog/components/catalog-detail.tsx` | `catalog/catalog-detail.tsx` | catalog | move: feature flat |
| 73 | `web_app/src/features/catalog/components/catalog-fields.tsx` | `catalog/catalog-fields.tsx` | catalog | move: feature flat |
| 74 | `web_app/src/features/catalog/components/catalog-filters.tsx` | `catalog/catalog-filters.tsx` | catalog | move: feature flat |
| 75 | `web_app/src/features/catalog/components/catalog-footer.tsx` | `catalog/catalog-footer.tsx` | catalog | move: feature flat |
| 76 | `web_app/src/features/catalog/components/catalog-header.tsx` | `catalog/catalog-header.tsx` | catalog | move: feature flat |
| 77 | `web_app/src/features/catalog/components/catalog-table.tsx` | `catalog/catalog-table.tsx` | catalog | move: feature flat |
| 78 | `web_app/src/features/catalog/components/catalog-toolbar.tsx` | `catalog/catalog-toolbar.tsx` | catalog | move: feature flat |
| 79 | `web_app/src/features/catalog/components/external-link.tsx` | `catalog/external-link.tsx` | catalog | move: feature flat |
| 80 | `web_app/src/features/catalog/controllers/use-catalog-data.ts` | `catalog/use-catalog-data.ts` | catalog | move: feature flat |
| 81 | `web_app/src/features/catalog/controllers/use-catalog-import.ts` | `catalog/use-catalog-import.ts` | catalog | move: feature flat |
| 82 | `web_app/src/features/catalog/controllers/use-catalog-route-state.ts` | `catalog/use-catalog-route-state.ts` | catalog | move: feature flat |
| 83 | `web_app/src/features/catalog/export/catalog-export.ts` | `catalog/catalog-export.ts` | catalog | move: feature flat |
| 84 | `web_app/src/features/catalog/export/download-lifecycle.ts` | `catalog/download-lifecycle.ts` | catalog | move: feature flat |
| 85 | `web_app/src/features/catalog/export/use-catalog-downloads.ts` | `catalog/use-catalog-downloads.ts` | catalog | move: feature flat |
| 86 | `web_app/src/features/catalog/labels.ts` | `catalog/catalog-labels.ts` | catalog | move: feature flat |
| 87 | `web_app/src/features/catalog/search.ts` | `catalog/catalog-search.ts` | catalog | move: feature flat |
| 88 | `web_app/src/features/catalog/state/catalogStore.ts` | `catalog/catalog-store.ts` | catalog | move: feature flat |
| 89 | `web_app/src/features/catalog/types.ts` | `catalog/catalog-types.ts` | catalog | move: feature flat |
| 90 | `web_app/src/features/twin/controllers/use-research-playback.ts` | `twin/use-research-playback.ts` | twin | move: feature flat |
| 91 | `web_app/src/features/twin/controllers/use-tour-controller.ts` | `twin/use-tour-controller.ts` | twin | move: feature flat |
| 92 | `web_app/src/features/twin/controllers/use-twin-actions.ts` | `twin/use-twin-actions.ts` | twin | move: feature flat |
| 93 | `web_app/src/features/twin/controllers/use-twin-demo-clock.ts` | `twin/use-twin-demo-clock.ts` | twin | move: feature flat |
| 94 | `web_app/src/features/twin/controllers/use-twin-keyboard.ts` | `twin/use-twin-keyboard.ts` | twin | move: feature flat |
| 95 | `web_app/src/features/twin/controllers/use-twin-process-projection.ts` | `twin/use-twin-process-projection.ts` | twin | move: feature flat |
| 96 | `web_app/src/features/twin/controllers/use-twin-route-state.ts` | `twin/use-twin-route-state.ts` | twin | move: feature flat |
| 97 | `web_app/src/features/twin/controllers/use-twin-scene-sync.ts` | `twin/use-twin-scene-sync.ts` | twin | move: feature flat |
| 98 | `web_app/src/features/twin/controllers/use-twin-slices.ts` | `twin/use-twin-slices.ts` | twin | move: feature flat |
| 99 | `web_app/src/features/twin/controllers/use-wafer-playback.ts` | `twin/use-wafer-playback.ts` | twin | move: feature flat |
| 100 | `web_app/src/features/twin/equipment-status-pipeline.tsx` | `twin/twin-equipment-status-pipeline.tsx` | twin | move: feature flat |
| 101 | `web_app/src/features/twin/fab-viewer.tsx` | `twin/twin-viewer.tsx` | twin | move: feature flat |
| 102 | `web_app/src/features/twin/state/twin-state.ts` | `twin/twin-state.ts` | twin | move: feature flat |
| 103 | `web_app/src/features/twin/state/twinDemoStore.ts` | `twin/twin-demo.atom.ts` | twin | move: feature flat |
| 104 | `web_app/src/features/twin/state/twinPageStore.ts` | `twin/twin-page.atom.ts` | twin | move: feature flat |
| 105 | `web_app/src/features/twin/state/twinUiStore.ts` | `twin/twin-ui.atom.ts` | twin | move: feature flat |
| 106 | `web_app/src/features/twin/tool-state-merge.ts` | `twin/tool-state-merge.ts` | twin | move: feature flat |
| 107 | `web_app/src/features/twin/twin-amhs-hud.tsx` | `twin/twin-amhs-hud.tsx` | twin | move: feature flat |
| 108 | `web_app/src/features/twin/twin-dialogs.tsx` | `twin/twin-dialogs.tsx` | twin | move: feature flat |
| 109 | `web_app/src/features/twin/twin-elevation.tsx` | `twin/twin-elevation.tsx` | twin | move: feature flat |
| 110 | `web_app/src/features/twin/twin-i18n.tsx` | `twin/twin-i18n.tsx` | twin | move: feature flat |
| 111 | `web_app/src/features/twin/twin-inspector.tsx` | `twin/twin-inspector.tsx` | twin | move: feature flat |
| 112 | `web_app/src/features/twin/twin-page-data.ts` | `twin/twin-page-data.ts` | twin | move: feature flat |
| 113 | `web_app/src/features/twin/twin-page.tsx` | `twin/twin-page.tsx` | twin | move: feature flat |
| 114 | `web_app/src/features/twin/twin-search.ts` | `twin/twin-search.ts` | twin | move: feature flat |
| 115 | `web_app/src/features/twin/twin-sidebar.tsx` | `twin/twin-sidebar.tsx` | twin | move: feature flat |
| 116 | `web_app/src/features/twin/twin-tour-hud.tsx` | `twin/twin-tour-hud.tsx` | twin | move: feature flat |
| 117 | `web_app/src/features/twin/twin-translations.ts` | `twin/twin-translations.ts` | twin | move: feature flat |
| 118 | `web_app/src/features/twin/twin-wafer-hud.tsx` | `twin/twin-wafer-hud.tsx` | twin | move: feature flat |
| 119 | `web_app/src/features/twin/twin-yms.tsx` | `twin/twin-yms.tsx` | twin | move: feature flat |
| 120 | `web_app/src/features/twin/wafer-session.ts` | `twin/twin-wafer-session.ts` | twin | move: feature flat |
| 121 | `web_app/src/features/workbench/command-console.tsx` | `workbench/command-console.tsx` | workbench | move: feature flat |
| 122 | `web_app/src/features/workbench/components/completion-bar.tsx` | `workbench/completion-bar.tsx` | workbench | move: feature flat |
| 123 | `web_app/src/features/workbench/components/fab-overview.tsx` | `workbench/fab-overview.tsx` | workbench | move: feature flat |
| 124 | `web_app/src/features/workbench/components/metric.tsx` | `workbench/metric.tsx` | workbench | move: feature flat |
| 125 | `web_app/src/features/workbench/components/panel.tsx` | `workbench/panel.tsx` | workbench | move: feature flat |
| 126 | `web_app/src/features/workbench/components/run-form.tsx` | `workbench/run-form.tsx` | workbench | move: feature flat |
| 127 | `web_app/src/features/workbench/components/run-history.tsx` | `workbench/run-history.tsx` | workbench | move: feature flat |
| 128 | `web_app/src/features/workbench/components/status-pill.tsx` | `workbench/status-pill.tsx` | workbench | move: feature flat |
| 129 | `web_app/src/features/workbench/components/workbench-metrics.tsx` | `workbench/workbench-metrics.tsx` | workbench | move: feature flat |
| 130 | `web_app/src/features/workbench/controllers/use-command-console.ts` | `workbench/use-command-console.ts` | workbench | move: feature flat |
| 131 | `web_app/src/features/workbench/controllers/use-run-submission.ts` | `workbench/use-run-submission.ts` | workbench | move: feature flat |
| 132 | `web_app/src/features/workbench/error-message.ts` | `workbench/error-message.ts` | workbench | move: feature flat |
| 133 | `web_app/src/features/workbench/format.ts` | `workbench/workbench-format.ts` | workbench | move: feature flat |
| 134 | `web_app/src/features/workbench/state/workbenchStore.ts` | `workbench/workbench.atom.ts` | workbench | move: feature flat |
| 135 | `web_app/src/features/workbench/workbench.tsx` | `workbench/workbench.tsx` | workbench | move: feature flat |
| 136 | `web_app/src/generated/contracts.generated.ts` | `generated/contracts.generated.ts` | generated | move: update generated-artifacts.json |
| 137 | `web_app/src/generated/static-structure-packed.ts` | `generated/static-structure-packed.generated.ts` | generated | move: update generated-artifacts.json |
| 138 | `web_app/src/generated/twin-translations.generated.ts` | `generated/twin-translations.generated.ts` | generated | move: update generated-artifacts.json |
| 139 | `web_app/src/localization/language.ts` | `localization/language.ts` | localization | move |
| 140 | `web_app/src/main.tsx` | `main.tsx` | app | move |
| 141 | `web_app/src/realtime/buffers/FrameRingBuffer.ts` | `realtime/frame-ring-buffer.ts` | realtime | move |
| 142 | `web_app/src/realtime/equipment-status/gate.ts` | `realtime/equipment-status.gate.ts` | realtime | move |
| 143 | `web_app/src/realtime/equipment-status/index.ts` | （删除） | realtime | delete: barrel forbidden |
| 144 | `web_app/src/realtime/equipment-status/protocol.ts` | `realtime/equipment-status.protocol.ts` | realtime | move |
| 145 | `web_app/src/realtime/equipment-status/stream.ts` | `realtime/equipment-status.transport.ts` | realtime | move |
| 146 | `web_app/src/realtime/protocol/MessageDecoder.ts` | `realtime/message-decoder.ts` | realtime | move |
| 147 | `web_app/src/realtime/telemetry/FabTelemetryRegistry.ts` | `realtime/telemetry-registry.ts` | realtime | move |
| 148 | `web_app/src/realtime/telemetry/TelemetryRuntime.ts` | `realtime/telemetry-runtime.ts` | realtime | move |
| 149 | `web_app/src/realtime/transport/SseCommandEventSource.ts` | `realtime/command-event-source.transport.ts` | realtime | move |
| 150 | `web_app/src/realtime/workers/createTelemetryWorker.ts` | `realtime/telemetry-worker-factory.ts` | realtime | move |
| 151 | `web_app/src/realtime/workers/telemetryWorker.logic.ts` | `realtime/telemetry-worker.logic.ts` | realtime | move |
| 152 | `web_app/src/realtime/workers/telemetryWorker.ts` | `realtime/telemetry.worker.ts` | realtime | move |
| 153 | `web_app/src/rendering/contracts/static-structure-data.ts` | `rendering/static-structure-data.contract.ts` | rendering | move |
| 154 | `web_app/src/rendering/lite-backend.ts` | `rendering/lite-backend.ts` | rendering | move |
| 155 | `web_app/src/rendering/lite/airflow-texture.ts` | `rendering/lite-airflow-texture.ts` | rendering | move: rendering flat |
| 156 | `web_app/src/rendering/lite/amhs-stats.ts` | `rendering/lite-amhs-stats.ts` | rendering | move: rendering flat |
| 157 | `web_app/src/rendering/lite/camera.ts` | `rendering/lite-camera.ts` | rendering | move: rendering flat |
| 158 | `web_app/src/rendering/lite/cut-plane.ts` | `rendering/lite-cut-plane.ts` | rendering | move: rendering flat |
| 159 | `web_app/src/rendering/lite/effects-xray-state.ts` | `rendering/lite-effects-xray-state.ts` | rendering | move: rendering flat |
| 160 | `web_app/src/rendering/lite/effects/cut.ts` | `rendering/lite-effects-cut.ts` | rendering | move: rendering flat |
| 161 | `web_app/src/rendering/lite/effects/index.ts` | （删除） | rendering | delete: barrel forbidden |
| 162 | `web_app/src/rendering/lite/effects/wafer.ts` | `rendering/lite-effects-wafer.ts` | rendering | move: rendering flat |
| 163 | `web_app/src/rendering/lite/effects/xray-shaders.ts` | `rendering/lite-effects-xray-shaders.ts` | rendering | move: rendering flat |
| 164 | `web_app/src/rendering/lite/effects/xray.ts` | `rendering/lite-effects-xray.ts` | rendering | move: rendering flat |
| 165 | `web_app/src/rendering/lite/environment-roof-data.ts` | `rendering/lite-environment-roof-data.ts` | rendering | move: rendering flat |
| 166 | `web_app/src/rendering/lite/environment.ts` | `rendering/lite-environment.ts` | rendering | move: rendering flat |
| 167 | `web_app/src/rendering/lite/geometry/facility-layout.ts` | `rendering/lite-geometry-facility-layout.ts` | rendering | move: rendering flat |
| 168 | `web_app/src/rendering/lite/geometry/facility.ts` | `rendering/lite-geometry-facility.ts` | rendering | move: rendering flat |
| 169 | `web_app/src/rendering/lite/geometry/original-exploded-link-data.ts` | `rendering/lite-geometry-original-exploded-link-data.ts` | rendering | move: rendering flat |
| 170 | `web_app/src/rendering/lite/geometry/original-tool-parts.ts` | `rendering/lite-geometry-original-tool-parts.ts` | rendering | move: rendering flat |
| 171 | `web_app/src/rendering/lite/geometry/static-structure.ts` | `rendering/lite-geometry-static-structure.ts` | rendering | move: rendering flat |
| 172 | `web_app/src/rendering/lite/geometry/tool-families.ts` | `rendering/lite-geometry-tool-families.ts` | rendering | move: rendering flat |
| 173 | `web_app/src/rendering/lite/lighting.ts` | `rendering/lite-lighting.ts` | rendering | move: rendering flat |
| 174 | `web_app/src/rendering/lite/motion.ts` | `rendering/lite-motion.ts` | rendering | move: rendering flat |
| 175 | `web_app/src/rendering/lite/next-coordinate-frame.ts` | `rendering/lite-next-coordinate-frame.ts` | rendering | move: rendering flat |
| 176 | `web_app/src/rendering/lite/overlay-billboards.ts` | `rendering/lite-overlay-billboards.ts` | rendering | move: rendering flat |
| 177 | `web_app/src/rendering/lite/runtime.ts` | `rendering/lite-runtime.ts` | rendering | move: rendering flat |
| 178 | `web_app/src/rendering/lite/selection.ts` | `rendering/lite-selection.ts` | rendering | move: rendering flat |
| 179 | `web_app/src/rendering/lite/shadows/native-lite-shadow.ts` | `rendering/lite-shadows-native-lite-shadow.ts` | rendering | move: rendering flat |
| 180 | `web_app/src/rendering/lite/source-orbit-input.ts` | `rendering/lite-source-orbit-input.ts` | rendering | move: rendering flat |
| 181 | `web_app/src/rendering/lite/tool-states.ts` | `rendering/lite-tool-states.ts` | rendering | move: rendering flat |
| 182 | `web_app/src/rendering/lite/world.ts` | `rendering/lite-world.ts` | rendering | move: rendering flat |
| 183 | `web_app/src/runtime/FabLifecycleCoordinator.ts` | `runtime/fab-lifecycle-coordinator.ts` | runtime | move: runtime flat |
| 184 | `web_app/src/runtime/FabRuntime.ts` | `runtime/fab-runtime.ts` | runtime | move: runtime flat |
| 185 | `web_app/src/runtime/FabRuntimeFactory.ts` | `runtime/fab-runtime-factory.ts` | runtime | move: runtime flat |
| 186 | `web_app/src/runtime/FabRuntimeRegistry.ts` | `runtime/fab-runtime-registry.ts` | runtime | move: runtime flat |
| 187 | `web_app/src/runtime/commandSources.ts` | `runtime/command-sources.ts` | runtime | move: runtime flat |
| 188 | `web_app/src/runtime/commands/CommandReconciler.ts` | `runtime/command-reconciler.ts` | runtime | move: runtime flat |
| 189 | `web_app/src/runtime/commands/XStateCommandWorkflowAdapter.ts` | `runtime/xstate-command-workflow-adapter.ts` | runtime | move: runtime flat |
| 190 | `web_app/src/runtime/commands/equipmentCommand.logic.ts` | `runtime/equipment-command.logic.ts` | runtime | move: runtime flat |
| 191 | `web_app/src/runtime/commands/equipmentCommand.machine.ts` | `runtime/equipment-command.machine.ts` | runtime | move: runtime flat |
| 192 | `web_app/src/shared/scheduling/coalesced-dispatcher.ts` | `lib/coalesced-dispatcher.ts` | lib | move |
| 193 | `web_app/src/state/createSliceStore.ts` | （删除） | state | delete in Task 4: Zustand factory |
| 194 | `web_app/src/state/localeStore.ts` | `state/locale.atom.ts` | state | move: Atom in Task 4 |
| 195 | `web_app/src/state/preferences.ts` | `state/preferences.atom.ts` | state | move: Atom in Task 4 |
| 196 | `web_app/src/state/runtimeStore.ts` | （拆分） | app/twin/rendering | split in Task 4: app lifecycle + twin projection + rendering lifecycle |

## 统计

- 文件总数：196
- Task 1 移动/改名为：191
- 删除（生成路由树/barrel/Zustand 工厂）：4
- 拆分（runtimeStore、equipment-status-bridge、contracts）：1
- 未映射：0
