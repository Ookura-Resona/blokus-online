/**
 * 极简 DOM / Canvas / WebSocket 桩。
 *
 * 目的：让 public/app.js 与 public/board.js 能在 Node 里被真正 import 并运行，
 * 从而在没有浏览器的环境下验证前端逻辑（元素绑定、消息处理、落子流程、结算）。
 *
 * 只实现前端实际用到的那部分 API：
 *   - getElementById / createElement / createTextNode
 *   - classList / dataset / style / hidden / textContent / innerHTML
 *   - append / remove / addEventListener / click
 *   - querySelector(All) 支持 .class、tag、[attr="v"] 及其组合
 *   - canvas.getContext('2d') 返回一堆空实现的方法
 *     （可选：装一个录制器，把绘制指令记下来给 tools/render-preview.js 重放）
 *   - WebSocket 用测试用的真实客户端接到真实服务器上
 */

import { connectWs } from './wsclient.js';

/* ------------------------------ 选择器 ------------------------------ */

/** 把选择器解析成 { tag, classes, attrs } */
function parseSelector(selector) {
  const classes = [];
  const attrs = [];
  let tag = null;
  let rest = selector.trim();
  const tagMatch = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tagMatch) {
    tag = tagMatch[0].toLowerCase();
    rest = rest.slice(tag.length);
  }
  const re = /\.([\w-]+)|\[([\w-]+)="([^"]*)"\]|\[([\w-]+)\]/g;
  let m;
  while ((m = re.exec(rest))) {
    if (m[1]) classes.push(m[1]);
    else if (m[2]) attrs.push([m[2], m[3]]);
    else if (m[4]) attrs.push([m[4], null]);
  }
  return { tag, classes, attrs };
}

function matches(node, sel) {
  if (node.nodeType !== 'element') return false;
  if (sel.tag && node.tagName.toLowerCase() !== sel.tag) return false;
  for (const c of sel.classes) if (!node.classList.contains(c)) return false;
  for (const [k, v] of sel.attrs) {
    const val = k.startsWith('data-')
      ? node.dataset[k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())]
      : node.getAttribute(k);
    if (v === null) {
      if (val === undefined || val === null) return false;
    } else if (String(val) !== v) return false;
  }
  return true;
}

/* ------------------------------ 节点 ------------------------------ */

let nodeSeq = 0;

class FakeClassList {
  constructor(node) {
    this.node = node;
    this.set = new Set();
  }
  add(...names) {
    for (const n of names) this.set.add(n);
    this.#sync();
  }
  remove(...names) {
    for (const n of names) this.set.delete(n);
    this.#sync();
  }
  contains(name) {
    return this.set.has(name);
  }
  toggle(name, force) {
    const want = force === undefined ? !this.set.has(name) : !!force;
    if (want) this.set.add(name);
    else this.set.delete(name);
    this.#sync();
    return want;
  }
  #sync() {
    this.node._className = [...this.set].join(' ');
  }
  get value() {
    return [...this.set].join(' ');
  }
}

class FakeNode {
  constructor(tagName = 'div') {
    this.nodeType = 'element';
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = {
      setProperty: (k, v) => {
        this.style[k] = v;
      },
      removeProperty: () => {},
    };
    this._className = '';
    this._text = '';
    this._listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.title = '';
    this.type = '';
    this.id = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.classList = new FakeClassList(this);
    nodeSeq += 1;
  }

  get className() {
    return this._className;
  }

  set className(v) {
    this._className = String(v ?? '');
    this.classList.set = new Set(this._className.split(/\s+/).filter(Boolean));
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }

  set textContent(v) {
    this.children = [];
    this._text = String(v ?? '');
  }

  get innerHTML() {
    return this._text;
  }

  set innerHTML(v) {
    this.children = [];
    this._text = String(v ?? '');
  }

  get childElementCount() {
    return this.children.length;
  }

  get firstChild() {
    return this.children[0] ?? null;
  }

  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }

  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : undefined;
  }

  append(...nodes) {
    for (const n of nodes) {
      if (n === null || n === undefined) continue;
      const node = typeof n === 'string' ? new FakeText(n) : n;
      node.parentElement = this;
      this.children.push(node);
    }
  }

  appendChild(n) {
    this.append(n);
    return n;
  }

  remove() {
    if (!this.parentElement) return;
    const i = this.parentElement.children.indexOf(this);
    if (i >= 0) this.parentElement.children.splice(i, 1);
    this.parentElement = null;
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  /** 触发一次事件（同步） */
  fire(type, event = {}) {
    const ev = {
      type,
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
      ...event,
    };
    let node = this;
    while (node) {
      const list = node._listeners?.get(type);
      if (list) for (const fn of [...list]) fn.call(node, ev);
      node = node.parentElement;
    }
    return ev;
  }

  click() {
    return this.fire('click');
  }

  focus() {}
  select() {}

  closest(selector) {
    const sel = parseSelector(selector);
    let node = this;
    while (node) {
      if (matches(node, sel)) return node;
      node = node.parentElement;
    }
    return null;
  }

  #walk(out) {
    for (const c of this.children) {
      if (c.nodeType !== 'element') continue;
      out.push(c);
      c.#walk(out);
    }
    return out;
  }

  querySelectorAll(selector) {
    const sel = parseSelector(selector);
    return this.#walk([]).filter((n) => matches(n, sel));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, left: 0, top: 0, right: 380, bottom: 520, width: 380, height: 520 };
  }
}

class FakeText {
  constructor(text) {
    this.nodeType = 'text';
    this._text = String(text);
    this.parentElement = null;
    this.children = [];
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = String(v ?? '');
  }
}

/* ------------------------------ Canvas ------------------------------ */

const CTX_METHODS = [
  'setTransform', 'resetTransform', 'clearRect', 'fillRect', 'strokeRect', 'beginPath',
  'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'bezierCurveTo', 'quadraticCurveTo',
  'fill', 'stroke', 'save', 'restore', 'translate', 'scale', 'rotate', 'drawImage',
  'createLinearGradient', 'measureText', 'fillText', 'setLineDash', 'clip', 'rect', 'ellipse',
];

/** 录制器会额外记录这些样式属性的变化（它们的值会附在每条指令上） */
const CTX_STYLE_PROPS = ['fillStyle', 'strokeStyle', 'lineWidth', 'globalAlpha', 'lineJoin', 'lineCap'];

/** 把 '24px' / 24 解析成数字，失败返回 0 */
function parseCssPx(v) {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * 创建一个「录制型」2D context 录制器。
 *
 * 默认什么都没发生：只有把它传给 installDom({ recorder }) 之后，
 * 之后新建的每个 canvas 的 2D context 才会被包一层，
 * 把每次绘制调用记成 { op, args, transform, fillStyle, strokeStyle, lineWidth, globalAlpha }，
 * 交给 tools/raster.js 重放成 PNG。
 *
 * 记录是**可选**的：不传 recorder 时走的还是原来的空实现，行为与性能完全不变。
 */
export function create2DRecorder() {
  const canvases = new Map();
  let seq = 0;

  /** 把 canvas 的当前尺寸刷进记录 */
  function capture(record, canvas) {
    record.width = canvas.width ?? 0;
    record.height = canvas.height ?? 0;
    record.cssWidth = parseCssPx(canvas.style?.width);
    record.cssHeight = parseCssPx(canvas.style?.height);
    return record;
  }

  /** 给一个真实（或桩）的 2D context 装上录制包装 */
  function instrument(ctx, canvas, record) {
    const backing = {};
    for (const k of CTX_STYLE_PROPS) {
      const initial = ctx[k];
      backing[k] = initial === undefined ? (k === 'lineWidth' ? 1 : k === 'globalAlpha' ? 1 : '') : initial;
      Object.defineProperty(ctx, k, {
        configurable: true,
        enumerable: true,
        get: () => backing[k],
        set: (v) => {
          backing[k] = v;
        },
      });
    }

    const push = (op, args, transform) => {
      record.commands.push({
        op,
        args,
        transform,
        fillStyle: backing.fillStyle,
        strokeStyle: backing.strokeStyle,
        lineWidth: backing.lineWidth,
        globalAlpha: backing.globalAlpha,
        lineJoin: backing.lineJoin,
        lineCap: backing.lineCap,
      });
      if (op === 'clearRect' && args[0] === 0 && args[1] === 0) {
        // 视作一帧的开始（清屏），重放时从这里切最后一帧
        record.frameStart = record.commands.length - 1;
      }
    };

    const wrap = (name) => {
      const orig = ctx[name];
      ctx[name] = (...args) => {
        let transform = canvas._lastTransform ?? [1, 0, 0, 1, 0, 0];
        if (name === 'setTransform') {
          transform = args.slice(0, 6);
          canvas._lastTransform = transform;
        } else if (name === 'resetTransform') {
          transform = [1, 0, 0, 1, 0, 0];
          canvas._lastTransform = null;
        }
        push(name, args, transform);
        if (typeof orig === 'function') return orig.apply(ctx, args);
        // 某个方法桩里没有：补一个 no-op，免得前端直接抛异常
        if (name === 'measureText') return { width: 10 };
        if (name === 'createLinearGradient' || name === 'createRadialGradient') {
          return { addColorStop() {} };
        }
        return undefined;
      };
    };

    for (const name of CTX_METHODS) wrap(name);
    // 录制起始状态，保证重放的第一条指令就有完整上下文
    push('SET', [], [1, 0, 0, 1, 0, 0]);
    return ctx;
  }

  return {
    active: true,
    /** 由 FakeCanvas 构造时调用，登记一个 canvas 并建一份空记录 */
    canvasCreated(canvas) {
      const id = ++seq;
      canvas._id = id;
      const record = {
        id,
        tag: 'canvas',
        width: 0,
        height: 0,
        cssWidth: 0,
        cssHeight: 0,
        frameStart: 0,
        instrumented: false,
        commands: [],
      };
      canvases.set(id, { canvas, record });
      return record;
    },
    /** 给 context 装录制包装（由 FakeCanvas.getContext 调用） */
    instrument,
    /** 由 FakeCanvas.getContext 调用；同一个 canvas 只建一份记录 */
    getContext(canvas) {
      const entry = canvases.get(canvas._id);
      if (!entry) return null;
      const { record } = entry;
      if (!record.instrumented) {
        record.instrumented = true;
        capture(record, canvas);
      }
      return record;
    },
    /**
     * 把 canvas 的当前宽高/CSS 尺寸刷进记录，并返回该记录。
     * 前端常见的写法是先 getContext 再 resize 画布（board.resize()），
     * 所以重放前需要再刷一次，否则拿到的是 resize 之前的 0x0。
     */
    capture(canvas) {
      const entry = canvases.get(canvas._id);
      if (!entry) return null;
      capture(entry.record, canvas);
      return entry.record;
    },
    /** 录制到的所有 canvas（按创建顺序） */
    list() {
      return [...canvases.values()].map((e) => e.record);
    },
    get(id) {
      return canvases.get(id)?.record ?? null;
    },
    clear() {
      canvases.clear();
    },
    /** 视作录制开关：关掉之后新建的 canvas 不再包录制层 */
    setActive(on) {
      this.active = !!on;
    },
  };
}

class FakeCanvas extends FakeNode {
  constructor(recorder = null) {
    super('canvas');
    this.width = 0;
    this.height = 0;
    this._recorder = recorder;
    this._id = 0;
    this._lastTransform = null;
    if (recorder?.canvasCreated) recorder.canvasCreated(this);
    const ctx = {};
    for (const m of CTX_METHODS) ctx[m] = () => (m === 'measureText' ? { width: 10 } : undefined);
    ctx.createLinearGradient = () => ({ addColorStop() {} });
    ctx.fillStyle = '';
    ctx.strokeStyle = '';
    ctx.lineWidth = 1;
    ctx.globalAlpha = 1;
    ctx.font = '';
    this._ctx = ctx;
  }
  getContext() {
    const record = this._recorder?.getContext?.(this);
    if (record && !this._ctx.__instrumented) {
      this._ctx.__instrumented = true;
      this._recorder.instrument(this._ctx, this, record);
    }
    return this._ctx;
  }
  setPointerCapture() {}
  releasePointerCapture() {}
}

/* ------------------------------ 极简 HTML 解析 ------------------------------ */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** 找到标签的结束 '>'，跳过引号里的内容 */
function findTagEnd(html, from) {
  let quote = null;
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function applyAttr(node, name, value) {
  const lower = name.toLowerCase();
  // 属性表始终记一份，否则 [id="x"] 这类选择器会匹配不到
  node.setAttribute(lower, value);
  if (lower === 'id') node.id = value;
  else if (lower === 'class') node.className = value;
  else if (lower.startsWith('data-')) {
    const key = lower.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    node.dataset[key] = value;
  } else if (lower === 'hidden') node.hidden = true;
  else if (lower === 'disabled') node.disabled = true;
  else if (lower === 'value') node.value = value;
  else if (lower === 'checked') node.checked = true;
  else if (lower === 'type') node.type = value;
}

/**
 * 把 index.html 装进 document.body。
 * 用真实的 HTML 而不是手搭 DOM，才能顺带验证 JS 里引用的 id / class
 * 与页面结构确实对得上。
 */
export function loadHtml(document, html) {
  const root = document.body;
  const stack = [root];

  const appendText = (text) => {
    const t = text.trim();
    if (t) stack[stack.length - 1].append(document.createTextNode(t));
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      appendText(html.slice(i));
      break;
    }
    if (lt > i) appendText(html.slice(i, lt));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt)) {
      const end = html.indexOf('>', lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    const gt = findTagEnd(html, lt);
    if (gt === -1) break;
    const inner = html.slice(lt + 1, gt);

    if (inner.startsWith('/')) {
      const tag = inner.slice(1).trim().toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tagName.toLowerCase() === tag) {
          stack.length = k;
          break;
        }
      }
      i = gt + 1;
      continue;
    }

    const selfClose = inner.trimEnd().endsWith('/');
    const body = selfClose ? inner.trimEnd().slice(0, -1) : inner;
    const tagMatch = /^([a-zA-Z][\w-]*)/.exec(body);
    if (!tagMatch) {
      i = gt + 1;
      continue;
    }
    const tag = tagMatch[1].toLowerCase();
    const node = document.createElement(tag);

    const attrRe = /([\w:.-]+)(?:\s*=\s*"([^"]*)")?/g;
    let m;
    while ((m = attrRe.exec(body.slice(tagMatch[1].length)))) {
      applyAttr(node, m[1], m[2] ?? '');
    }

    stack[stack.length - 1].append(node);
    if (!selfClose && !VOID_TAGS.has(tag)) stack.push(node);
    i = gt + 1;
  }

  return root;
}

/* ------------------------------ 安装 ------------------------------ */

/**
 * 安装全局桩。
 * @param {{host:string, search?:string, html?:string, recorder?:object}} opts
 *   recorder —— 可选。传 create2DRecorder() 的返回值时，
 *   之后新建的 canvas 会走「录制型」context；不传则完全走原来的空实现。
 */
export function installDom(opts) {
  const { host, search = '', html = '', recorder = null } = opts;

  const document = {
    nodeType: 'document',
    _listeners: new Map(),
    body: new FakeNode('body'),
    visibilityState: 'visible',
    getElementById(id) {
      const found = document.body.querySelectorAll(`[id="${id}"]`)[0];
      return found ?? null;
    },
    createElement(tag) {
      return tag === 'canvas' ? new FakeCanvas(recorder) : new FakeNode(tag);
    },
    createTextNode(text) {
      return new FakeText(text);
    },
    addEventListener(type, fn) {
      if (!document._listeners.has(type)) document._listeners.set(type, []);
      document._listeners.get(type).push(fn);
    },
    removeEventListener() {},
    querySelectorAll(sel) {
      return document.body.querySelectorAll(sel);
    },
    querySelector(sel) {
      return document.body.querySelector(sel);
    },
    execCommand: () => true,
  };

  if (html) loadHtml(document, html);

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };

  const location = {
    protocol: 'http:',
    host,
    hostname: host.split(':')[0],
    port: host.split(':')[1] ?? '',
    origin: `http://${host}`,
    pathname: '/',
    search,
    href: `http://${host}/${search}`,
  };

  const window = {
    _listeners: new Map(),
    devicePixelRatio: 2,
    scrollTo() {},
    addEventListener(type, fn) {
      if (!window._listeners.has(type)) window._listeners.set(type, []);
      window._listeners.get(type).push(fn);
    },
    removeEventListener() {},
    location,
    localStorage,
    document,
    fire(type) {
      for (const fn of window._listeners.get(type) ?? []) fn({ type });
    },
  };

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this._listeners = new Map();
      this._ws = null;

      const u = new URL(url);
      connectWs(Number(u.port), { host: u.hostname, path: u.pathname })
        .then((ws) => {
          this._ws = ws;
          this.readyState = FakeWebSocket.OPEN;
          this.#emit('open', {});
          this.#readLoop(ws);
        })
        .catch((err) => {
          this.readyState = FakeWebSocket.CLOSED;
          this.#emit('error', { message: String(err?.message ?? err) });
          this.#emit('close', { code: 1006 });
        });
    }

    async #readLoop(ws) {
      for (;;) {
        let text;
        try {
          text = await ws.nextText(120_000);
        } catch {
          this.readyState = FakeWebSocket.CLOSED;
          this.#emit('close', { code: 1006 });
          return;
        }
        this.#emit('message', { data: text });
      }
    }

    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }

    removeEventListener() {}

    #emit(type, ev) {
      for (const fn of this._listeners.get(type) ?? []) fn(ev);
    }

    send(data) {
      if (this.readyState !== FakeWebSocket.OPEN) throw new Error('WebSocket 还没连上');
      this._ws.send(data);
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this._ws?.close();
    }
  }

  const g = globalThis;
  // Node 18+ 已经把 navigator / crypto / WebSocket 定义成只读全局量，
  // 直接赋值会抛「has only a getter」，必须用 defineProperty 覆盖。
  const setGlobal = (name, value) => {
    try {
      g[name] = value;
    } catch {
      /* 只读，走下面 */
    }
    if (g[name] !== value) {
      Object.defineProperty(g, name, { value, configurable: true, writable: true });
    }
  };

  setGlobal('document', document);
  setGlobal('window', window);
  setGlobal('localStorage', localStorage);
  setGlobal('location', location);
  setGlobal('navigator', { userAgent: 'node-domstub', clipboard: undefined });
  setGlobal('WebSocket', FakeWebSocket);
  setGlobal('devicePixelRatio', 2);
  setGlobal('requestAnimationFrame', (fn) => setTimeout(() => fn(performance.now()), 0));
  setGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
  setGlobal('history', { replaceState() {} });
  setGlobal('prompt', () => {});
  setGlobal('alert', () => {});
  if (!g.crypto) setGlobal('crypto', {});

  return { document, window, localStorage, FakeWebSocket, FakeNode, FakeCanvas, recorder };
}
