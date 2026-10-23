# 18 — 工程类型、接口、协议和事务实现示例

> 以下是**接口设计示例而非完整可编译解决方案**。实际实现时需要补齐 Strong ID 类型、序列化器、异常语义、NuGet、生成代码与测试；字段命名以 `contracts/` 目录的版本化参考契约为准，该 proto 尚未覆盖全部生产事件与 RPC。

## 1. 标识、单位和虚拟时间

```csharp
// Foundation/Fab.Ids/Example.cs
public readonly record struct SiteId(Guid Value);
public readonly record struct FabId(Guid Value);
public readonly record struct RunId(Guid Value);
public readonly record struct EquipmentId(Guid Value);
public readonly record struct ScenarioVersionId(Guid Value);

public readonly record struct SimTime(long Microseconds)
    : IComparable<SimTime>
{
    public int CompareTo(SimTime other) => Microseconds.CompareTo(other.Microseconds);
}

public enum SiteSimulationMode
{
    Independent = 1,
    SharedCapacity = 2,
    CoupledFlowReserved = 3 // 不开放首版功能
}
```

不要在 `SimTime` 上直接使用本地时区/`DateTime.Now`；不同单位需要专用 ValueObject，例如 `UpwLitresPerMinute` 与 `ElectricPowerKilowatts`，杜绝裸 `double` 互加。

## 2. 确定性事件排序与调度接口

```csharp
public readonly record struct EventKey(
    long SimTimeUs, ushort SemanticPriority, ulong EnqueueSequence)
    : IComparable<EventKey>
{
    public int CompareTo(EventKey other)
    {
        int c = SimTimeUs.CompareTo(other.SimTimeUs);
        if (c != 0) return c;
        c = SemanticPriority.CompareTo(other.SemanticPriority);
        return c != 0 ? c : EnqueueSequence.CompareTo(other.EnqueueSequence);
    }
}

public readonly record struct ScheduledEvent(
    EventKey Key, FabId FabId, ushort Kind, ReadOnlyMemory<byte> Payload);

public interface IDeterministicScheduler
{
    SimTime Now { get; }
    void Schedule(SimTime time, ushort priority,
        FabId owner, ushort kind, ReadOnlyMemory<byte> payload);
    bool TryStepOne();
    void RunUntil(SimTime inclusiveTime);
}
```

具体队列可使用堆实现；PriorityQueue 的稳定性不能凭空假定，必须把 EnqueueSequence 包含进 Priority Key。它只由权威执行器确定性分配，与事件处理后 EventLog 的连续 `sequence` 不同；初始化按稳定 FAB/实体 ID 枚举，子事件先按冻结规则排序再入队。同时间的新子事件禁止回到已关闭的更早语义优先级阶段，不能以网络/线程到达顺序或“队列暂空”判定仲裁批次已齐。对序号溢出、负仿真时间、过去事件作显式错误处理。Payload 正式实现使用版本化值对象/union；二进制 memory 仅为边界序列化示意。

## 3. 强隔离的 FAB Partition

```csharp
public sealed record FabRuntimeConfig(
    SiteId SiteId,
    RunId RunId,
    FabId FabId,
    string TemplateSha256,
    string RouteSha256,
    ulong Seed,
    SiteSimulationMode Mode);

public interface IFabStatePartition
{
    FabId FabId { get; }
    SimTime Clock { get; }
    string ComputeDeterministicStateHash();
    FabCheckpoint ExportCheckpoint();
}
```

成员 Partition 以冻结模板创建，**绝不**共享可变 Equipment/Lot 对象、队列、随机流。读取模板可共享不可变数据；写时复制或实例化完整运行状态。Independent 每 FAB 自持时钟/队列；SharedCapacity 的 FAB Partition 共享 Coordinator 的权威时间线和队列，不能按这个接口私自调度独立时钟。Seed 为 UInt64，派生字段含稳定 FAB/实体/领域标识，规范字节编码与长度前缀；RunId、LeaseEpoch、线程 ID、墙钟不参与派生或语义哈希。

## 4. SiteResource 授予请求（容量单位固定）

```csharp
public readonly record struct SiteResourceId(Guid Value);
public readonly record struct DemandId(Guid Value);
public readonly record struct AllocationId(Guid Value);

public sealed record CapacityDemand(
    SiteId SiteId, RunId RunId,
    SiteResourceId ResourceId, FabId FabId, DemandId DemandId,
    long SimTimeUs, long AmountInBaseUnit, long? DurationUs,
    int Priority);

public sealed record CapacityGrant(
    SiteId SiteId, RunId RunId, SiteResourceId ResourceId, FabId FabId,
    AllocationId AllocationId, DemandId DemandId,
    long GrantedInBaseUnit, long ValidFromUs, long? ValidUntilUs,
    ulong GrantVersion);

public sealed record CapacityRelease(
    SiteId SiteId, RunId RunId, SiteResourceId ResourceId, FabId FabId,
    AllocationId AllocationId, ulong ExpectedGrantVersion, long SimTimeUs);

public interface ISiteResourceAuthority
{
    IReadOnlyList<CapacityGrant> ArbitrateBatch(
        long simTimeUs, IReadOnlyList<CapacityDemand> requests);
    void Release(CapacityRelease request);
}
```

`AmountInBaseUnit` 的单位来自冻结 ResourceDefinition，量为正数。DurationUs 非空时必须为正且时间加法检查溢出，有效区间为 `[from,until)`；DurationUs/ValidUntilUs 为空表示持续占用至显式 Release/Revoke，不能以默认 0 表示持续占用。proto 的 valid_until_sim_time_us 同样使用 optional 表达缺失。按阶段收齐同时间请求后依冻结业务 Priority 与稳定 FAB/Demand 标识仲裁；若选 FIFO，使用确定性权威入队序号。DemandId 必须从因果身份稳定派生，不使用随机 GUID/网络到达序。重复 demand_id 内容相同为重试、内容不同拒绝；Release 校验完整范围和 GrantVersion，从 ledger 读取释放量，重复释放无额外副作用。

GrantVersion 是可重放模型状态；Worker `LeaseEpoch` 属控制传输/提交元数据，二者不能互换。换租约保留有效 Grant/Allocation 的身份、版本和容量占用，只替换发布权；RPC/目录提交另行校验当前 execution 的 LeaseEpoch。若资源包含流率+积分约束，须计算时间区间占用；这些预算不跨不同 Run 共享。

## 5. Worker Job Lease（伪 SQL）

```sql
BEGIN;
WITH chosen AS (
  SELECT id
  FROM simulation.run_executions
  WHERE status = 'QUEUED'
    AND site_id = @authorized_site_id
    AND id = ANY(@authorized_execution_ids)
  ORDER BY created_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE simulation.run_executions r
SET status = 'CLAIMED', lease_owner = @worker,
    lease_epoch = r.lease_epoch + 1,
    lease_until_utc = clock_timestamp() + @lease_interval,
    state_version = r.state_version + 1,
    heartbeat_at = clock_timestamp()
FROM chosen
WHERE r.id = chosen.id
RETURNING r.id, r.site_id, r.run_id, r.fab_id, r.lease_epoch;
COMMIT;
```

参数均由服务器从已授权执行范围及受控租约配置生成，不能由 Worker 自行声明；示例是工程 schema 名，种子使用 `simulation_run_executions`。Independent 每 `(site,run,fab)` 一项执行、SharedCapacity 每 `(site,run)` 一项，Run 记录本身没有独占租约。只有 Claim 提交成功才启动执行；示例不演示过期恢复，恢复路径先验证可用 Checkpoint、递增原执行 epoch 后重领。

运行中的 Heartbeat/Checkpoint/Finish 必须锁定执行记录，检查 owner、epoch、未过期租约、成员范围及状态版本，目录写入与状态 CAS 同事务，零受影响行视为失租；仅把 epoch 写入文件不构成 fencing。对象先传不可变临时/内容寻址 Key，提交失败不得对外可见。共享 Checkpoint 原子包含全部 FAB/ResourceLedger；独立执行互不占用租约。此处不包含完整生产存储过程、授权和恢复实现。

Checkpoint 的权威水位不得超过完整连续且已持久化的 EventLog 前缀；可以同事务提交对应日志目录，不得只写快照后跳过日志缺口。租约恢复不重置权威 EventSeq，不改动模型 GrantVersion。

## 6. Protobuf 契约治理（示意）

直接从 `contracts/fab_events.proto` 的 `semiconfab.next.v1` 生成，禁止在此再定义 fab.realtime.v1/DeltaRange 作为第二份契约：

| 类型/字段 | 固定语义 |
|---|---|
| `EventEnvelope.sequence` | 执行范围内连续权威 EventSeq；不是 EnqueueSequence |
| `StateSnapshot.last_applied_sequence` | 一致权威边界；展示快照不含完整 RNG/Queue |
| `StateSnapshot.stream_id / stream_sequence` | 新订阅标识与初始展示序号 0 |
| `StateDeltaBatch.sequence_start/end` | v1 同值，每原子批一个展示序号 |
| `ClientAck.highest_contiguous_stream_sequence` | 完整应用后的连续展示序号，仅流控 |
| `SharedCapacityAllocation.granted_amount_in_base_unit` | 冻结资源单位的整数；旧浮点编号保留 |
| `SharedCapacityAllocation.grant_version / lease_epoch` | 模型授权版本 / 控制发布租约，分开校验 |

新增字段不复用已有编号；字段省略/未知 enum 不等于有效业务输入。投影丢包须新流重同步，不能拿权威稀疏序号判断展示缺口。当前原型只支持完整单帧快照，生产帧/实体/队列上限需冻结；未定义的分片、订阅握手和管理 RPC 不得暗称已实现。

`Fab.Contracts.Adapters` 是独立边界映射工程，可引用 Domain 与生成 Contracts；Contracts 不引用 Domain，Domain 不引用生成 Contracts，Host 组合适配器。原型不是生产实现或完整可编译 SDK。

## 7. TS 页面与 3D Scene Facade 边界

```ts
export type FabEntityKey = Readonly<{
  siteId: string;
  runId: string;
  fabId: string;
  entityId: string;
}>;

export interface VisualEquipmentDelta {
  readonly key: FabEntityKey;
  readonly stateCode: number;
  readonly simTimeUs: bigint;
  readonly entityVersion: bigint;
}

export interface FabSceneFacade {
  initialize(canvas: HTMLCanvasElement): Promise<void>;
  loadFab(scope: Pick<FabEntityKey, 'siteId' | 'runId' | 'fabId'>,
    sceneVersion: string): Promise<void>;
  applyEquipmentDeltas(batch: readonly VisualEquipmentDelta[]): void;
  dispose(): Promise<void>;
}
```

当 JSON 与 TS 交互时，`bigint` 不会被原生 JSON.stringify 序列化；需要 Protobuf BigInt 运行时或经过验证的 string/int64 映射策略。适配层验证 stream_id、投影连续性、完整实体键及版本后才调用 Facade；Site 流中内层实体必须携带 fab_id。React 不持有 Babylon Mesh 或场景对象。

## 8. WebGPU-only 初始化与失败策略

```ts
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';

export async function createWebGpuEngine(
  canvas: HTMLCanvasElement,
): Promise<WebGPUEngine> {
  if (!window.isSecureContext || !navigator.gpu) {
    throw new Error('WEBGPU_UNAVAILABLE');
  }
  const engine = new WebGPUEngine(canvas, { antialias: true });
  await engine.initAsync();
  return engine;
}
```

具体 import/options 必须随锁定 Babylon.js 版本经 TypeScript 编译测试核对，不要静默创建通用 Babylon `Engine`；运行期 Device Lost、Dispose、重建都必须写在正式实现。

## 9. 关键接口门禁

接口变更时检查：
1. 存量 Run 能否在原 schema 下 Replay；
2. TS/.NET/C++ 三语言序列化一致性；
3. 是否破坏 FAB 范围隔离或数据类型单位；
4. 是否把可丢弃的视图事件误用成权威事件；
5. 是否添加新的后端网络/数据库调用到 DES 热路径；
6. 是否让真实 OT Adapter 绕过安全模式校验。
