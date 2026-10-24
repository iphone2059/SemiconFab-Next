// Parametric canvas drawing ported from SemiconFab twin.html b3666132.
// PolyForm Noncommercial 1.0.0; see docs/migration/twin-parity/attribution.md.
export function renderAirflowHeatmapCanvas(canvas: HTMLCanvasElement, timeSec = 0) {
  canvas.width = 1024;
  canvas.height = 768;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Cannot create pressure-field texture");
  ctx.clearRect(0, 0, 1024, 768);

  // 坐标映射: X: [-47, 47] -> [0, 1024], Z: [-35, 35] -> [0, 768]
  const mapX = (x: number) => ((x + 47) / 94) * 1024;
  const mapZ = (z: number) => ((z + 35) / 70) * 768;

  // 1. 底层压差场色阶云图 (Pressure Gradient Scalar Cloud)
  // (A) 黄光区 +30 Pa 琥珀暖金高压核心区
  const lithoGrad = ctx.createRadialGradient(
    mapX(-30),
    mapZ(-12),
    40,
    mapX(-30),
    mapZ(-12),
    340,
  );
  lithoGrad.addColorStop(0.0, "rgba(245, 158, 11, 0.40)"); // +30.2 Pa 饱和琥珀金
  lithoGrad.addColorStop(0.65, "rgba(251, 191, 36, 0.28)");
  lithoGrad.addColorStop(0.95, "rgba(217, 119, 6, 0.12)");
  lithoGrad.addColorStop(1.0, "rgba(245, 158, 11, 0.0)");

  ctx.fillStyle = lithoGrad;
  ctx.beginPath();
  ctx.roundRect(
    mapX(-45),
    mapZ(-33),
    mapX(-16.5) - mapX(-45),
    mapZ(4.5) - mapZ(-33),
    16,
  );
  ctx.fill();

  // (B) 主工艺 Bay +15 Pa 洁净冰蓝均压场
  const mainBayGrad = ctx.createLinearGradient(
    mapX(-14),
    mapZ(-30),
    mapX(42),
    mapZ(30),
  );
  mainBayGrad.addColorStop(0.0, "rgba(14, 165, 233, 0.22)");
  mainBayGrad.addColorStop(0.5, "rgba(56, 189, 248, 0.18)");
  mainBayGrad.addColorStop(1.0, "rgba(2, 132, 199, 0.15)");

  ctx.fillStyle = mainBayGrad;
  ctx.beginPath();
  ctx.roundRect(
    mapX(-14),
    mapZ(-33),
    mapX(45) - mapX(-14),
    mapZ(32) - mapZ(-33),
    16,
  );
  ctx.fill();

  // (C) 风淋气闸过渡区高剪切压差梯度带 (Airlock Pressure Cascade Barrier: +30 Pa -> +15 Pa)
  const airlockGrad = ctx.createLinearGradient(
    mapX(-16.5),
    mapZ(1.0),
    mapX(-16.5),
    mapZ(5.0),
  );
  airlockGrad.addColorStop(0.0, "rgba(245, 158, 11, 0.55)"); // +30 Pa
  airlockGrad.addColorStop(0.5, "rgba(249, 115, 22, 0.50)"); // +22.5 Pa 强喷射
  airlockGrad.addColorStop(1.0, "rgba(14, 165, 233, 0.40)"); // +15 Pa

  ctx.fillStyle = airlockGrad;
  ctx.fillRect(
    mapX(-18.5),
    mapZ(1.0),
    mapX(-14.5) - mapX(-18.5),
    mapZ(5.0) - mapZ(1.0),
  );

  // 2. 绘制等压线 (Isobar Contour Lines)
  ctx.lineWidth = 1.5;
  ctx.setLineDash([8, 6]);

  // +30 Pa 等压线 (Litho Isobar)
  ctx.strokeStyle = "#f59e0b";
  ctx.beginPath();
  ctx.roundRect(
    mapX(-44),
    mapZ(-31),
    mapX(-17.5) - mapX(-44),
    mapZ(2.5) - mapZ(-31),
    12,
  );
  ctx.stroke();

  // +15 Pa 等压线 (Main Bay Isobar)
  ctx.strokeStyle = "#38bdf8";
  ctx.beginPath();
  ctx.roundRect(
    mapX(-13.5),
    mapZ(-31),
    mapX(43) - mapX(-13.5),
    mapZ(30) - mapZ(-31),
    12,
  );
  ctx.stroke();

  // 3. 动态流线与流动箭头矢量 (Streamlines & Velocity Vector Field)
  ctx.setLineDash([]);
  const flowOffset = (timeSec * 45) % 80;

  // 气闸门口强劲外溢气幕流线 (Outward Purge Streamlines)
  for (let s = -2; s <= 2; s++) {
    const sx = -16.5 + s * 0.45;
    const startX = mapX(sx);
    const startZ = mapZ(0.5);
    const endZ = mapZ(6.5);

    ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.moveTo(startX, startZ);
    ctx.lineTo(startX + s * 12, endZ);
    ctx.stroke();

    // 沿流线流动的亮点/箭头
    const pulseZ =
      startZ + ((flowOffset + (s + 2) * 16) % (endZ - startZ));
    ctx.fillStyle = "#fef08a";
    ctx.beginPath();
    ctx.arc(
      startX + s * 12 * ((pulseZ - startZ) / (endZ - startZ)),
      pulseZ,
      3.5,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }

  // 4. 等压线与流场工程标注文字 (Isobar Telemetry Readout Placards)
  ctx.font =
    'bold 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
  ctx.fillStyle = "#fef08a";
  ctx.fillText(
    "+30.2 Pa · LITHO 589nm CORE (ISO CLASS 1)",
    mapX(-42),
    mapZ(-28),
  );

  ctx.fillStyle = "#bae6fd";
  ctx.fillText(
    "+15.1 Pa · MAIN PROCESS BAY (ISO CLASS 3)",
    mapX(-10),
    mapZ(-28),
  );

  ctx.fillStyle = "#f97316";
  ctx.font =
    'bold 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
  ctx.fillText("ΔP = +15 Pa CASCADE PURGE >>>", mapX(-21), mapZ(3.2));
}
