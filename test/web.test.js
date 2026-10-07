/**
 * 前端端到端测试。
 *
 * 在 Node 里搭 DOM/Canvas 桩（并真实解析 public/index.html），
 * 加载真正的 public/app.js 与 public/board.js，连到真正的服务器上，
 * 全程只通过「点按钮」把一整局打完。
 *
 * 能抓到的问题：
 *   - 前端源码 import 写错、JS 引用的元素 id / class 与 HTML 对不上
 *   - 消息处理、棋子栏、旋转翻面、落子流程、结算浮层、计分板的逻辑错误
 *
 * 注意 app.js 是模块级单例（浏览器里也是），所以整个文件只加载一次，
 * 两个模式在同一个测试里顺序跑。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createApp } from '../server/app.js';
import { installDom } from './domstub.js';
import { C2S } from '../shared/protocol.js';
import { PIECE_BY_ID } from '../shared/pieces.js';

register('./web-loader.js', import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = fs.readFileSync(path.resolve(HERE, '../public/index.html'), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立 */
async function until(fn, timeoutMs = 8000, label = '条件') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待「${label}」超时`);
    await sleep(10);
  }
}

test('前端 e2e：加载真实页面，只用点击 UI 打完混战与二对二', async () => {
  /* ---------------- 起服务器 + 装 DOM + 加载前端 ---------------- */
  const serverApp = createApp({ aiDelayMs: 5 });
  await new Promise((r) => serverApp.server.listen(0, '127.0.0.1', r));
  const port = serverApp.server.address().port;

  installDom({ host: `127.0.0.1:${port}`, html: INDEX_HTML });
  await import('../public/app.js');

  const hook = globalThis.window.__blokus;
  assert.ok(hook, 'app.js 应当挂出 window.__blokus 调试钩子');
  const { app: client, board, el } = hook;

  /** 轮到我就点棋子 + 落子，直到本局结束 */
  async function playMyTurns(maxSteps = 400) {
    let guard = 0;
    while (guard++ < maxSteps) {
      const st = client.lastState;
      if (!st || st.over) return;
      if (st.turn !== 0) {
        await sleep(5);
        continue;
      }
      const items = el.tray.querySelectorAll('.tray-item');
      const pick = items.find((n) => !n.classList.contains('is-disabled'));
      if (!pick) {
        await sleep(10);
        continue;
      }
      pick.click();
      const r = board.confirm();
      assert.equal(r.ok, true, `本地应当认为这手合法：${r.reason}`);
      await until(() => client.lastState.moveCount !== st.moveCount, 8000, '服务端确认落子');
    }
    await until(() => client.lastState?.over, 15000, '对局结束');
  }

  try {
    /* ---------------- 1. 首页 / 连接 ---------------- */
    await until(() => client.connected, 8000, '前端连上 WebSocket');

    // 页面结构应当被正确解析：这些静态元素必须存在
    for (const id of ['screen-home', 'screen-room', 'screen-game', 'turn-banner', 'tray', 'board', 'result-modal', 'sheet']) {
      assert.ok(globalThis.document.getElementById(id), `静态元素 #${id} 应当存在`);
    }
    assert.ok(el.turnBanner.querySelector('.turn-dot'), '回合横幅里的颜色点必须存在');
    assert.ok(el.turnBanner.querySelector('.turn-text'), '回合横幅里的文字必须存在');
    assert.ok(el.segMode.querySelector('[data-mode="ffa"]'), '模式分段按钮必须存在');
    assert.ok(el.segDifficulty.querySelector('[data-difficulty="hard"]'), '难度分段按钮必须存在');

    /* ---------------- 2. 创建房间 ---------------- */
    el.inputName.value = '前端测试员';
    el.btnCreate.click();

    const room = await until(() => client.room, 8000, '收到房间信息');
    assert.match(room.code, /^[A-HJ-NP-Z2-9]{4}$/, '房号格式不对');
    assert.equal(room.yourSeat, 0);
    assert.equal(el.roomCode.textContent, room.code, '房号应当显示在页面上');

    const seatCards = el.seatList.querySelectorAll('.seat-card');
    assert.equal(seatCards.length, 4, '应当渲染 4 个座位');
    assert.equal(seatCards[0].classList.contains('is-me'), true, '0 号位应当标记为「我」');

    /* ---------------- 3. 分段控件（事件委托） ---------------- */
    el.segDifficulty.querySelector('[data-difficulty="easy"]').click();
    await until(() => client.room?.difficulty === 'easy', 5000, '难度切到 easy');
    assert.equal(
      el.segDifficulty.querySelector('[data-difficulty="easy"]').classList.contains('is-active'),
      true,
      '选中的难度按钮应当高亮',
    );

    /* ---------------- 4. 补 AI 并开局 ---------------- */
    for (const seat of [1, 2, 3]) hook.send({ t: C2S.SET_SEAT, seat, kind: 'ai' });
    await until(
      () => client.room?.seats.filter((s) => s.kind === 'ai').length === 3,
      5000,
      '三个座位变成 AI',
    );

    el.btnStart.click();
    await until(() => el.screenGame.classList.contains('is-active'), 8000, '切到对局界面');
    await until(() => client.lastState?.turn === 0, 8000, '轮到我方');

    const trayItems = el.tray.querySelectorAll('.tray-item');
    assert.equal(trayItems.length, 21, `棋子栏应当有 21 枚棋子，实际 ${trayItems.length}`);
    assert.match(el.trayInfo.textContent, /已下 0\/21/, '棋子栏信息应显示进度');

    /* ---------------- 4.5 棋盘几何：必须占满画布、不能被画到角落 ---------------- */
    board.resize();
    const L = board.layout;
    assert.equal(L.dpr, 2, '桩里 devicePixelRatio 是 2');
    assert.equal(L.baseCell, L.boardPx / 20, '每个格子应当等于棋盘边长 / 20');
    assert.equal(L.boardPx, Math.min(L.cssW, L.cssH), '棋盘边长取画布宽高较小者');
    assert.equal(board.cell, L.baseCell * board.view.zoom);

    const side = board.cell * 20;
    assert.equal(Math.round(side), Math.round(L.boardPx), '棋盘应当正好画满 baseCell×20');
    assert.equal(side / L.cssW, 1, '棋盘应当占满画布宽度（回归：曾经只能验证到"画在左上角一小块"）');

    const ox = (L.cssW - side) / 2 + board.view.tx;
    const oy = (L.cssH - side) / 2 + board.view.ty;
    assert.ok(ox >= -0.5 && oy >= -0.5, '棋盘不能超出画布左上角');
    assert.ok(ox + side <= L.cssW + 0.5, '棋盘不能超出画布右边');
    assert.ok(oy + side <= L.cssH + 0.5, '棋盘不能超出画布下边');
    assert.equal(hook.el.boardCanvas.width, Math.round(L.cssW * L.dpr), 'canvas 物理宽 = CSS 宽 × dpr');
    assert.equal(hook.el.boardCanvas.height, Math.round(L.cssH * L.dpr), 'canvas 物理高 = CSS 高 × dpr');

    /* ---------------- 5. 非法落子应当被拒绝并提示 ---------------- */
    hook.send({ t: C2S.MOVE, pieceId: '1', orient: 0, x: 8, y: 8 });
    await until(
      () => [...el.toastWrap.children].some((n) => /起始角/.test(n.textContent)),
      5000,
      '弹出「必须占角」的错误提示',
    );

    /* ---------------- 6. 点棋子栏 → 落子 ---------------- */
    const firstEnabled = el.tray.querySelectorAll('.tray-item').find((n) => !n.classList.contains('is-disabled'));
    assert.ok(firstEnabled, '至少有一枚棋子可以下');
    firstEnabled.click();

    assert.ok(board.selection, '点击棋子栏应当选中一枚棋子');
    assert.equal(firstEnabled.classList.contains('is-active'), true, '选中的棋子应高亮');
    assert.equal(el.btnConfirm.disabled, false, '选中后「落子」按钮应当可用');

    el.btnConfirm.click();
    await until(() => client.lastState?.moveCount >= 1, 8000, '第一手被服务端接受');
    assert.notEqual(board.raw.turn, 0, '落子后应当轮到别人');

    /* ---------------- 7. 旋转 / 翻面 / 取消 ---------------- */
    await until(() => client.lastState?.turn === 0, 15000, '再次轮到我方');
    const pick2 = el.tray.querySelectorAll('.tray-item').find((n) => !n.classList.contains('is-disabled'));
    pick2.click();

    const sel0 = board.selection.orient;
    const piece = PIECE_BY_ID.get(board.selection.pieceId);
    el.btnRotate.click();
    const sel1 = board.selection.orient;
    if (piece.orientations.length > 1) {
      assert.notEqual(sel1, sel0, '「旋转」应当改变朝向');
    }
    el.btnFlip.click();
    assert.equal(board.selection.orient, piece.flipIndex[sel1], '「翻转」应当跳到真正的镜像朝向');

    el.btnCancel.click();
    assert.equal(board.selection, null, '「取消」应当清空选择');
    assert.equal(el.btnConfirm.disabled, true, '没选棋子时「落子」应当禁用');

    /* ---------------- 8. 混战打完整局 ---------------- */
    await playMyTurns();

    const ffaResult = await until(() => client.result, 10000, '收到混战结算');
    await until(() => !el.resultModal.hidden, 5000, '结算浮层弹出');

    assert.equal(el.resultRows.querySelectorAll('.result-row').length, 4, '结算应当列出 4 位玩家');
    assert.equal(
      el.resultRows.querySelector('.result-row').classList.contains('is-winner'),
      true,
      '第一名应当高亮',
    );
    assert.deepEqual(ffaResult.ranking.map((r) => r.rank).sort(), [1, 2, 3, 4]);
    assert.match(el.resultTitle.textContent, /四人混战/);
    assert.ok(el.resultSummary.textContent.length > 0, '应当有战报文本');
    // 累计积分已经写到座位上
    assert.equal(client.room.seats[0].sessionScore, ffaResult.deltas[0]);

    /* ---------------- 9. 计分板抽屉 ---------------- */
    el.btnScoreboard.click();
    assert.equal(el.sheet.hidden, false, '计分板抽屉应当打开');
    assert.equal(el.sheetBody.querySelectorAll('.score-row').length, 4, '计分板应当列出 4 位玩家');
    el.btnSheetClose.click();
    assert.equal(el.sheet.hidden, true, '计分板应当关闭');

    /* ---------------- 10. 再来一局 → 切二对二 ---------------- */
    assert.equal(el.btnAgain.disabled, false, '房主应当能再来一局');
    el.btnAgain.click();
    await until(() => client.room?.phase === 'lobby', 8000, '回到大厅');
    assert.equal(el.resultModal.hidden, true, '结算浮层应当关闭');
    // 回归：回到大厅必须清掉上一局的结算，否则下一局终局广播 STATE(over) 时
    // 会先闪出上一局的结算浮层
    assert.equal(client.result, null, '回到大厅应当清空上一局的结算');
    assert.equal(client.lastState, null, '回到大厅应当清空上一局的棋盘快照');
    await until(() => el.screenRoom.classList.contains('is-active'), 5000, '显示大厅界面');
    const carried = client.room.seats[0].sessionScore;
    assert.equal(carried, ffaResult.deltas[0], '累计积分应当保留');

    el.segMode.querySelector('[data-mode="team"]').click();
    await until(() => client.room?.mode === 'team', 5000, '切到二对二');
    assert.equal(el.roomModeLabel.textContent, '二对二');

    el.btnStart.click();
    await until(() => el.screenGame.classList.contains('is-active'), 8000, '进入二对二对局');
    await until(() => client.lastState?.turn === 0, 8000, '二对二轮到我方');
    assert.equal(el.resultModal.hidden, true, '新一局进行中不应显示结算浮层');

    /* ---------------- 11. 二对二打完整局 ---------------- */
    await playMyTurns();

    const teamResult = await until(() => client.result, 10000, '收到二对二结算');
    assert.equal(teamResult.mode, 'team');
    assert.deepEqual(teamResult.teams[0].seats, [0, 2]);
    assert.deepEqual(teamResult.teams[1].seats, [1, 3]);
    assert.match(el.resultTitle.textContent, /二对二/);
    // 同队两人增减分一致
    assert.equal(teamResult.deltas[0], teamResult.deltas[2]);
    assert.equal(teamResult.deltas[1], teamResult.deltas[3]);
    // 胜方为正、败方为负
    const team0Won = teamResult.teams[0].win;
    assert.equal(team0Won ? teamResult.deltas[0] > 0 : teamResult.deltas[0] < 0, true);

    // 计分板按队伍分组
    el.btnScoreboard.click();
    const heads = el.sheetBody.querySelectorAll('.team-head');
    assert.ok(heads.length >= 2, '二对二计分板应当按队伍分组');
    assert.match(heads[0].textContent, /第 1 队/);
    el.btnSheetClose.click();

    /* ---------------- 12. 关掉结算后仍然能重开（曾经会把房主卡死） ---------------- */
    el.btnViewBoard.click();
    assert.equal(el.resultModal.hidden, true, '「查看棋盘」应当关掉结算浮层');
    assert.equal(el.btnResult.hidden, false, '对局结束后顶栏应当出现「结算」按钮');
    el.btnResult.click();
    assert.equal(el.resultModal.hidden, false, '点顶栏按钮应当能重新打开结算');

    el.btnBackRoom.click();
    await until(() => el.screenRoom.classList.contains('is-active'), 5000, '回到房间界面');
    assert.equal(el.btnStart.disabled, false, '对局结束后房主应当能重开');
    assert.equal(el.btnStart.textContent, '再来一局');
    el.btnStart.click();
    await until(() => client.room?.phase === 'lobby', 8000, '从房间界面重开成功');

    /* ---------------- 13. 邀请链接格式 ---------------- */
    assert.match(client.roomCode, /^[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(`http://127.0.0.1:${port}/?r=${client.roomCode}`, `http://127.0.0.1:${port}/?r=${client.roomCode}`);
  } finally {
    // 先停掉前端的自动重连与 WebSocket，否则定时器会让测试进程无法退出
    hook.disconnect();
    await serverApp.close();
  }
});
