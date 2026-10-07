/**
 * 客户端 ↔ 服务端消息协议。
 * 服务端与浏览器共用本文件，避免两边字符串写错。
 */

/** 客户端 → 服务端 */
export const C2S = {
  /** { playerId, name } —— 连上后第一件事 */
  HELLO: 'hello',
  /** { mode, difficulty } 创建房间并成为房主 */
  CREATE_ROOM: 'createRoom',
  /** { code } 用房号加入 */
  JOIN_ROOM: 'joinRoom',
  /** {} 离开房间 */
  LEAVE_ROOM: 'leaveRoom',
  /** { seat } 坐到一个空位（人）*/
  TAKE_SEAT: 'takeSeat',
  /** { seat } 离开自己的座位（回到旁观）*/
  LEAVE_SEAT: 'leaveSeat',
  /** { seat, kind } 房主设置座位为 'ai' 或 'open' */
  SET_SEAT: 'setSeat',
  /** { mode } 房主切换 四人混战 / 二对二 */
  SET_MODE: 'setMode',
  /** { difficulty } 房主切换 AI 难度 */
  SET_DIFFICULTY: 'setDifficulty',
  /** { ready } 准备 */
  SET_READY: 'setReady',
  /** {} 房主开局 */
  START: 'start',
  /** { pieceId, orient, x, y } */
  MOVE: 'move',
  /** {} 主动弃权 */
  PASS: 'pass',
  /** {} 房主重开一局（保留累计积分）*/
  REMATCH: 'rematch',
  /** { text } */
  CHAT: 'chat',
  /** {} 应用层心跳 */
  PING: 'ping',
};

/** 服务端 → 客户端 */
export const S2C = {
  /** { you: { playerId, name } } */
  WELCOME: 'welcome',
  /** 房间大厅信息（每个连接拿到的是各自的视角，含 yourSeat）*/
  ROOM: 'room',
  /** 对局快照 */
  STATE: 'state',
  /** 本局结算 */
  RESULT: 'result',
  /** { message } */
  ERROR: 'error',
  /** { seat, name, text, at } */
  CHAT: 'chat',
  /** { at } */
  PONG: 'pong',
  /** { seat, pieceId, auto } 最近一手（用于提示）*/
  MOVE_MADE: 'moveMade',
};
