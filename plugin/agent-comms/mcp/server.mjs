// agent-comms MCP stdio server — 主/子代理实时互通插件核心
//
// 四个工具（协议细节见各 inputSchema.description，会随每次请求重发）：
//   open_channel      协调者开频道（slug+随机后缀，防多会话并发串台）
//   report            子代理例行汇报 → 写锚工件事件文件（原子写入，服务端节流）
//   wait_worker_event 协调者阻塞等"任意 worker"事件 + 超时摘要（沉默检测）
//   read_events       回看频道历史事件（断线补读）
//
// 存储语义（与 ZCode 内置会话邮箱同款）：spool/<channel>/unread/*.json，
// wait 抽干 unread（rename 到 read/）后返回——派发后、等待前到达的事件不丢失。
// 事件文件名 = 15 位零填充毫秒时间戳-随机后缀.json，字典序即时间序。
//
// v0.2.0：open_channel 防串台；report 服务端节流（非 done 每 worker ≥2s）；
//         wait 支持按 worker 过滤；超时摘要含各 worker 最后事件时间。
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const SPOOL_ROOT = process.env.AGENT_COMMS_SPOOL_ROOT
  || path.join(os.homedir(), '.zcode', 'agent-comms', 'spool');
const VERSION = '0.2.5';
const POLL_MS = 400;
const WAIT_DEFAULT_MS = 60000;
const WAIT_MAX_MS = 240000; // 必须小于 plugin.json 的 timeoutMs(600000)，留清理余量
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Windows 保留设备名与结尾点会致目录不可用/别名合并，一律拒绝
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const validName = (s) => NAME_RE.test(s) && !WIN_RESERVED_RE.test(s) && !s.endsWith('.');
const SLUG_RE = /^[A-Za-z0-9._-]{0,40}$/;
const KINDS = ['milestone', 'blocked', 'done'];
const THROTTLE_MS = 2000; // 同一 worker 两次非 done 汇报的最小间隔（服务端硬边界）

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 存储 ----------

const chDir = (ch, sub) => path.join(SPOOL_ROOT, ch, sub);
function ensureDirs(ch) {
  for (const sub of ['unread', 'read']) fs.mkdirSync(chDir(ch, sub), { recursive: true });
}
function listEventFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch { return []; }
}
function readEvent(dir, file) {
  try {
    const ev = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    return {
      worker: ev.worker, kind: ev.kind, summary: ev.summary,
      message: ev.message, at: ev.at, ts: ev.ts, file: file,
    };
  } catch { return null; }
}
function atomicWriteJson(file, obj) {
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}
function allEventFiles(ch) {
  return [
    ...listEventFiles(chDir(ch, 'unread')).map((f) => [chDir(ch, 'unread'), f]),
    ...listEventFiles(chDir(ch, 'read')).map((f) => [chDir(ch, 'read'), f]),
  ];
}
function workerLastEvents(ch) {
  const last = new Map(); // worker -> {kind, at, ts}
  for (const [dir, f] of allEventFiles(ch)) {
    const ev = readEvent(dir, f);
    if (!ev?.worker) continue;
    const prev = last.get(ev.worker);
    if (!prev || ev.ts > prev.ts) last.set(ev.worker, { kind: ev.kind, at: ev.at, ts: ev.ts });
  }
  return last;
}
function workersInChannel(ch) {
  return [...workerLastEvents(ch).keys()].sort();
}

// ---------- 参数校验 ----------

class ToolError extends Error {}
function checkChannel(p) {
  const ch = typeof p?.channel === 'string' ? p.channel.trim() : '';
  if (!validName(ch)) {
    throw new ToolError(`channel 必填，且只能含字母数字._-、非 Windows 保留名、不以点结尾（长度 1-64），收到: ${JSON.stringify(p?.channel)}`);
  }
  return ch;
}
function checkWorker(p) {
  const w = typeof p?.worker === 'string' ? p.worker.trim() : '';
  if (!validName(w)) {
    throw new ToolError(`worker 必填，且只能含字母数字._-、非 Windows 保留名、不以点结尾（长度 1-64），收到: ${JSON.stringify(p?.worker)}`);
  }
  return w;
}
function optionalWorker(p) {
  if (p?.worker === undefined || p?.worker === null || p?.worker === '') return undefined;
  return checkWorker(p);
}

// ---------- 工具实现 ----------

function doOpenChannel(p) {
  let slug = typeof p?.slug === 'string' ? p.slug.trim() : '';
  if (!SLUG_RE.test(slug)) {
    throw new ToolError(`slug 只能含字母数字._-且 ≤40 字符（可省略），收到: ${JSON.stringify(p?.slug)}`);
  }
  if (!slug) slug = 'ch';
  const ch = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
  ensureDirs(ch);
  return {
    channel: ch, spool: path.join(SPOOL_ROOT, ch),
    note: '把此频道名写进每个派发 prompt 的「comms 频道」行；wait/read 用同名。',
  };
}

function doReport(p) {
  const ch = checkChannel(p);
  const worker = checkWorker(p);
  const summary = typeof p.summary === 'string' ? p.summary.trim() : '';
  if (!summary) throw new ToolError('summary 必填（≤200 字的事件摘要）');
  if (summary.length > 200) throw new ToolError(`summary 超长（${summary.length} > 200 字），请压缩`);
  let kind = 'milestone';
  if (p?.kind !== undefined && p.kind !== '') {
    if (!KINDS.includes(p.kind)) {
      throw new ToolError(`kind 只能是 ${KINDS.join('/')} 之一（缺省为 milestone），收到: ${JSON.stringify(p.kind)}`);
    }
    kind = p.kind;
  }
  const message = typeof p.message === 'string' ? p.message.slice(0, 20000) : undefined;

  if (kind !== 'done') {
    const last = workerLastEvents(ch).get(worker);
    if (last && Date.now() - last.ts < THROTTLE_MS) {
      throw new ToolError(
        `节流：worker ${worker} 距上次汇报不足 ${THROTTLE_MS / 1000} 秒。请把要点合并成一条再报，或等取得实质进展后再报（kind="done" 不受此限）。`,
      );
    }
  }

  ensureDirs(ch);
  const now = Date.now();
  const ev = { version: 1, channel: ch, worker, kind, summary, at: new Date(now).toISOString(), ts: now };
  if (message !== undefined) ev.message = message;
  const file = `${String(now).padStart(15, '0')}-${crypto.randomBytes(4).toString('hex')}.json`;
  atomicWriteJson(path.join(chDir(ch, 'unread'), file), ev);
  return { ok: true, channel: ch, worker, kind, at: ev.at, file };
}

async function doWait(p) {
  const ch = checkChannel(p);
  const onlyWorker = optionalWorker(p);
  const req = Number(p?.timeout_ms);
  const timeoutMs = Math.max(1000, Math.min(WAIT_MAX_MS, Number.isFinite(req) ? req : WAIT_DEFAULT_MS));
  ensureDirs(ch);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  for (;;) {
    const unreadDir = chDir(ch, 'unread');
    const files = listEventFiles(unreadDir);
    const matching = [];
    for (const f of files) {
      if (onlyWorker === undefined) { matching.push([f, null]); continue; }
      const ev = readEvent(unreadDir, f);
      if (ev?.worker === onlyWorker) matching.push([f, ev]);
    }
    if (matching.length > 0) {
      const events = [];
      for (const [f] of matching) {
        try {
          fs.renameSync(path.join(unreadDir, f), path.join(chDir(ch, 'read'), f));
          const ev = readEvent(chDir(ch, 'read'), f);
          if (ev) events.push(ev);
        } catch { /* 写入方竞争等下一轮 poll 收 */ }
      }
      if (events.length > 0) {
        return {
          status: 'events', timed_out: false, waited_ms: Date.now() - startedAt,
          events, workers_in_channel: workersInChannel(ch),
          ...(onlyWorker !== undefined ? { filtered: `仅返回 worker=${onlyWorker} 的事件，其它 worker 事件仍在 unread` } : {}),
        };
      }
    }
    if (Date.now() >= deadline) {
      const lastEvents = workerLastEvents(ch);
      const worker_last_event = {};
      for (const [w, v] of [...lastEvents.entries()].sort()) {
        worker_last_event[w] = { kind: v.kind, at: v.at, age_ms: Date.now() - v.ts };
      }
      return {
        status: 'timeout', timed_out: true, waited_ms: Date.now() - startedAt, events: [],
        workers_in_channel: workersInChannel(ch), worker_last_event,
        hint: '沉默检测：等待期内无任何 worker 新事件。对照 worker_last_event 的 age_ms 判断谁最久没动静；对超期无响应的 worker 可 SendMessage 质询（如「报告当前进度与阻塞点」），或用转录核实配方查其实际工具调用；确认其是否已结束/中断。',
      };
    }
    await sleep(POLL_MS);
  }
}

function doRead(p) {
  const ch = checkChannel(p);
  ensureDirs(ch);
  const req = Number(p?.limit);
  const limit = Math.max(1, Math.min(200, Number.isFinite(req) ? req : 50));
  const readDir = chDir(ch, 'read');
  const events = listEventFiles(readDir).slice(-limit)
    .map((f) => readEvent(readDir, f)).filter(Boolean);
  return { channel: ch, unread_count: listEventFiles(chDir(ch, 'unread')).length, events };
}

// ---------- 工具清单（description 会随每请求重发，承担协议说明职责） ----------

const TOOLS = [
  {
    name: 'open_channel',
    description: '【协调者用】开一个新 comms 频道：返回带随机后缀的频道名。每次派发任务批次前必须先调用本工具，把返回的频道名写进每个 worker 派发 prompt 的「comms 频道」行——随机后缀保证多个主会话并发时频道不会串台。',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '可选的任务标识前缀（字母数字._-，≤40 字符），如 fix-login' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'report',
    description: '【worker 用】例行汇报：把里程碑/进度/结果写成锚工件事件落盘，供协调者用 wait_worker_event 聚合等待。节流规则：两次 report 之间至少间隔 5 个工具调用，服务端对非 done 汇报强制 2 秒最小间隔（违者报错）；summary ≤200 字。紧急事项（验收标准要变/继续做会产生无效功/不可逆操作/外部阻塞超期）不要用本工具，直接调 RespondToCoordinator。任务结束必须 report 一次 kind="done"。',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'comms 频道，取自任务描述中「comms 频道」的值' },
        worker: { type: 'string', description: 'worker 名，取自任务描述中「worker 名」的值，未给则用你的 agentId' },
        kind: { type: 'string', enum: KINDS, description: 'milestone=里程碑；blocked=受阻需协调者注意（非紧急）；done=任务完成（结束时必发）' },
        summary: { type: 'string', description: '≤200 字的事件摘要（协调者主要读这个）' },
        message: { type: 'string', description: '可选，≤20000 字的详情/产出全文' },
      },
      required: ['channel', 'worker', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_worker_event',
    description: '【协调者用】阻塞等待任意 worker 的新事件（里程碑/blocked/done），有事件立即返回事件数组；超时返回沉默摘要（含各 worker 最后事件时间）。派发后应尽快调用本工具形成"等待-处理"循环：单次最长 240000ms，没等齐所有 worker 就再次调用。返回的 events 已从频道"抽走"（下次不重复返回），历史可用 read_events 回看。可传 worker 只等指定 worker（其它 worker 事件留在频道内不被消费）。',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'comms 频道，与派发时写给 worker 的一致' },
        timeout_ms: { type: 'number', description: '本次最长阻塞毫秒数，默认 60000，上限 240000；到点返回沉默摘要，可循环再调' },
        worker: { type: 'string', description: '可选，只等该 worker 的事件' },
      },
      required: ['channel'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_events',
    description: '【协调者用】回看频道内已被 wait 消费过的历史事件（最新在末尾），用于断线补读与复盘；不影响 unread。',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'comms 频道' },
        limit: { type: 'number', description: '最多返回条数，默认 50，上限 200' },
      },
      required: ['channel'],
      additionalProperties: false,
    },
  },
];

// ---------- JSON-RPC over stdio ----------

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // notification

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'agent-comms', version: VERSION },
    } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    (async () => {
      try {
        let result;
        if (name === 'open_channel') result = doOpenChannel(args);
        else if (name === 'report') result = doReport(args);
        else if (name === 'wait_worker_event') result = await doWait(args);
        else if (name === 'read_events') result = doRead(args);
        else {
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `未知工具: ${name}，可用: ${TOOLS.map((x) => x.name).join(', ')}` }], isError: true } });
          return;
        }
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] } });
      } catch (e) {
        const text = e instanceof ToolError ? e.message : `server error: ${e?.message ?? e}`;
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } });
      }
    })();
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } });
  }
});
process.stdin.on('end', () => process.exit(0));
process.stderr.write(`[agent-comms] stdio MCP server v${VERSION} started, spool=${SPOOL_ROOT}\n`);
