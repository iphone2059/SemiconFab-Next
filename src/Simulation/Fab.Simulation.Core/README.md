# Fab.Simulation.Core

纯 C# 整数微秒事件队列与固定 SplitMix64 v1。队列排序键冻结为 `(time_us, semantic_priority, enqueue_sequence)`，禁止重用入队序号；执行日志序号由 Runtime 独立分配。

Seed 派生 v1：先写 UInt64 master seed（little endian），再依次写 UTF-8 字段 `synthetic-fifo-seed-v1`、小写 D 格式 FAB UUID、`equipment-1`、`service`。各字符串前写 Int32 little endian 字节长度；SHA-256 的前 8 字节按 little endian 读取为初始 RNG state。无随机进程哈希、RunId、真实时间或其它 FAB 输入。

SplitMix64 每次加工启动推进一次。单 FAB 的 RNG state 与事件队列可随检查点恢复。固定向量覆盖 seed 0 的前两个输出和 FAB 派生流；仅在当前 .NET 11 Windows 环境执行了测试，尚未进行跨操作系统执行验收。
