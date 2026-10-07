/**
 * 全局常量：棋盘规格、座位/颜色、阵营划分、记分默认值。
 * 本文件同时被 Node 服务端和浏览器前端加载（纯 ESM，无任何 Node 专有 API）。
 */

/** 棋盘边长（标准 Blokus 为 20×20） */
export const BOARD_SIZE = 20;

/** 棋盘格子总数 */
export const CELLS = BOARD_SIZE * BOARD_SIZE;

/** 座位数（固定四人） */
export const SEAT_COUNT = 4;

/** 每个座位的固定颜色标识（索引即座位号） */
export const SEAT_COLORS = ['blue', 'yellow', 'red', 'green'];

/** 颜色的中文名，用于界面与战报 */
export const SEAT_LABELS = ['蓝方', '黄方', '红方', '绿方'];

/** 界面用的十六进制主色 */
export const SEAT_HEX = ['#3b82f6', '#eab308', '#ef4444', '#22c55e'];

/** 深色描边，用于棋盘绘制 */
export const SEAT_HEX_DARK = ['#1d4ed8', '#a16207', '#b91c1c', '#15803d'];

/**
 * 每个座位的起始角（必须被该玩家的第一枚棋子覆盖）。
 * 顺序 0→1→2→3 为：左上 → 左下 → 右下 → 右上，
 * 在「y 轴向下」的屏幕坐标系中是**逆时针**，符合规则要求的逆时针轮转。
 */
export const SEAT_CORNERS = [
  [0, 0],
  [0, BOARD_SIZE - 1],
  [BOARD_SIZE - 1, BOARD_SIZE - 1],
  [BOARD_SIZE - 1, 0],
];

/**
 * 二对二阵营划分：对角的玩家两两一方。
 * 座位 0(左上) 与 2(右下) 为阵营 0；座位 1(左下) 与 3(右上) 为阵营 1。
 */
export const TEAM_OF_SEAT = [0, 1, 0, 1];

/** 四个方向的边邻偏移 */
export const EDGE_OFFSETS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** 四个方向的对角偏移 */
export const DIAG_OFFSETS = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** 对局模式 */
export const MODE_FFA = 'ffa';
export const MODE_TEAM = 'team';

/** AI 难度 */
export const DIFFICULTY_EASY = 'easy';
export const DIFFICULTY_NORMAL = 'normal';
export const DIFFICULTY_HARD = 'hard';

/**
 * 默认积分规则。
 * base 为基础分；下面各项都是「基础分 1 时」的增减量。
 */
export const DEFAULT_SCORING = {
  /** 基础分（仅用于展示：最终积分 = base + delta） */
  base: 1,

  /** 四人混战：名次 1..4 对应的增减分（题目：+3 / +1 / 0 / -2） */
  ffaRankDelta: [3, 1, 0, -2],

  /** 二对二：胜方每人 / 败方每人的增减分（题目：+2 / -1） */
  teamWinDelta: 2,
  teamLoseDelta: -1,

  /** 统治力奖励：头名（或胜方）领先幅度达到阈值时额外加分 */
  domination: {
    enabled: true,
    /**
     * 四人混战阈值。注意：混战是贴身肉搏，实测（tools/sim.js，100 局 AI 自对局）
     * 头名领先第二名的幅度 p50=4、p90=9、最大仅 12 格。若沿用 20 格，
     * 这条奖励 100 局触发 0 次，等于死规则。取 10 格 ≈ 8% 触发率，
     * 与二对二 20 格阈值（实测 ≈10% 触发率）的稀有度基本对齐。
     */
    ffaGap: 10,
    /** 二对二阈值。实测胜方领先 p50=8、p90=20、最大 28 格，20 格 ≈ 10% 触发率。 */
    teamGap: 20,
    /** 触发的额外分（胜方每人 / 混战头名） */
    points: 1,
  },

  /** 全清奖励：把 21 块全部下完（剩余 0 块）时额外加分 */
  fullClear: {
    enabled: true,
    points: 1,
  },
};

/** 一局的总块数（21 块 / 89 格），用于校验 */
export const PIECES_PER_PLAYER = 21;
export const SQUARES_PER_PLAYER = 89;
