// Literal CINEMATIC_WAYPOINTS from the pinned original twin.html.
export interface OriginalTourStop { title:string; subtitle:string; titleEn:string; subtitleEn:string; tag:string; level:'L1'|'B1'; position:[number,number,number]; target:[number,number,number]; durationMs:number; holdMs:number }
export const ORIGINAL_TOUR_STOPS:readonly OriginalTourStop[] = [
  {
    "title": "300mm 晶圆洁净室宏观全景",
    "subtitle": "ISO Class 1/3 微环境洁净室全景与双环路天车 (AMHS OHT) 自动化物流导轨。",
    "titleEn": "300mm Cleanroom Grand Aerial Overview",
    "subtitleEn": "ISO Class 1 / Class 3 cleanroom with dual-loop AMHS OHT monorail logistics.",
    "tag": "WAYPOINT 1/5 • MACRO FAB",
    "level": "L1",
    "position": [
      70,
      50,
      75
    ],
    "target": [
      0,
      0,
      0
    ],
    "durationMs": 2200,
    "holdMs": 5000
  },
  {
    "title": "黄光微影区、风淋气闸与 589nm 琥珀安全核心",
    "subtitle": "抗UV幕墙风淋过渡气闸、除尘粘尘垫、步进光刻机与无尘服巡检工程师。",
    "titleEn": "Litho Bay 589nm Core & Amber Airlock",
    "subtitleEn": "Anti-UV airlock chamber, tacky mats, twin DUV/EUV scanners, and bunny suit operator.",
    "tag": "WAYPOINT 2/5 • LITHO BAY & AIRLOCK",
    "level": "L1",
    "position": [
      -20,
      3.8,
      12
    ],
    "target": [
      -25,
      1.8,
      -10
    ],
    "durationMs": 2000,
    "holdMs": 5000
  },
  {
    "title": "等离子刻蚀区与腔体辉光视窗",
    "subtitle": "ICP/RIE 高频等离子体放电辉光视窗、EFEM 机械手与 SEMI E87 状态指示塔灯。",
    "titleEn": "Etch Bay Plasma Glow & Wafer Transfer",
    "subtitleEn": "ICP/RIE high-frequency plasma glow windows, EFEM wafer robot, and SEMI E87 LEDs.",
    "tag": "WAYPOINT 3/5 • ETCH BAY",
    "level": "L1",
    "position": [
      8,
      4.8,
      -4
    ],
    "target": [
      -4,
      2.2,
      -15
    ],
    "durationMs": 2000,
    "holdMs": 5000
  },
  {
    "title": "AMHS OHT 天车垂直装卸示移动作",
    "subtitle": "天车悬挂导轨行进、垂直钢丝绳吊索下放 FOUP 至机台 Load Port 示移动作 (T1 传输假设即时)。",
    "titleEn": "AMHS OHT Overhead Track & Hoist Docking (Illustrative)",
    "subtitleEn": "Monorail cruising, vertical wire rope hoist lowering FOUP to machine Load Port (illustrative).",
    "tag": "WAYPOINT 4/5 • AMHS OHT (ILLUSTRATIVE)",
    "level": "L1",
    "position": [
      -6,
      5,
      -6
    ],
    "target": [
      0,
      4.2,
      -20
    ],
    "durationMs": 2000,
    "holdMs": 5000
  },
  {
    "title": "Subfab B1 动力基建与管道流向光效",
    "subtitle": "超纯水 (UPW)、冷却水 (PCW)、特气 (VMB) 综合管廊动态流向脉冲光效与干泵中枢。",
    "titleEn": "B1 Subfab Support Infra & Flowing Utility Piping",
    "subtitleEn": "Dynamic directional flow pulses across UPW, PCW, and VMB utility headers.",
    "tag": "WAYPOINT 5/5 • SUBFAB UTILITY & FLOW PIPING",
    "level": "B1",
    "position": [
      26,
      -4,
      20
    ],
    "target": [
      0,
      -2.6,
      -2
    ],
    "durationMs": 2200,
    "holdMs": 5000
  }
];
