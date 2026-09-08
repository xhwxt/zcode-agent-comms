// agent-comms MCP stdio server — 主/子代理实时互通插件核心
//
// 四个工具（协议细节见各 inputSchema.description，会随每次请求重发）：
//   open_channel      协调者开频道（slug+随机后缀，防多会话并发串台），签发频道令牌
//   report            子代理例行汇报 → 写锚工件事件文件（原子写入，服务端节流）
//   wait_worker_event 协调者阻塞等"任意 worker"事件 + 超时摘要（沉默检测）
//   read_events       回看频道历史事件（断线补读）
//
// 存储语义（与 ZCode 内置会话邮箱同款）：spool/<channel>/unread/*.json，
// wait 抽干 unread（rename 到 read/）后返回——派发后、等待前到达的事件不丢失。
// 事件文件名 = 15 位零填充毫秒时间戳-随机后缀.json，字典序即时间序。
//
// 投递语义声明：事件以"临时文件+同目录 rename"原子落盘（POSIX/Windows 均为
// 原子操作），但不做 fsync——宿主断电/进程崩溃可能丢最后一刻的事件。这是刻意的
// at-least-once 协调语义：关键终态另有内核完成通知与 RespondToCoordinator 双通道
// 兜底，不为极端场景引入 fsync 延迟。
//
// 安全模型：每频道一枚随机令牌（open_channel 签发，落 <channel>/.token），
// report/wait/read 都必须携带匹配令牌——防其它会话或无令牌代理读写本频道。
// 本机单用户前提下这是访问控制边界，不是加密边界。
//
// v0.2.0：open_channel 防串台；report 服务端节流（非 done 每 worker ≥2s）；
//         wait 支持按 worker 过滤；超时摘要含各 worker 最后事件时间。
// v0.2.7：每频道令牌鉴权；read/ 保留策略（AGENT_COMMS_READ_KEEP，默认 200，
//         超限删最旧）+ 孤儿 .tmp-* 清理；节流检查只解析最新尾部文件（不再
//         全量扫描）；wait 循环增量解析（每文件每次 wait 只解析一次）；stdin
//         行缓冲 1MB 上限（防超长行撑爆内存）；目录/文件 POSIX 权限收紧。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const SPOOL_ROOT = process.env.AGENT_COMMS_SPOOL_ROOT
  || path.join(os.homedir(), '.zcode', 'agent-comms', 'spool');
const VERSION = '0.2.7';
const POLL_MS = 400;
const WAIT_DEFAULT_MS = 60000;
const WAIT_MAX_MS = 240000; // 必须小于 plugin.json 的 timeoutMs(600000)，留清理余量
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Windows 保留设备名与结尾点会致目录不可用/别名合并，一律拒绝
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const validName = (s) => NAME_RE.test(s) && !WIN_RESERVED_RE.test(s) && !s.endsWith('.');
const SLUG_RE = /^[A-Za-z0-9._-]{0,40}$/;
const KINDS = ['milestone', 'blocked', 'done'];
const THROTTLE_MS = 2000;   // 同一 worker 两次非 done 汇报的最小间隔（服务端硬边界）
const THROTTLE_TAIL = 30;   // 节流检查只解析最新 30 个事件文件（按文件名字典序=时间序）
const LINE_MAX = 1024 * 1024; // 单行 JSON-RPC 输入上限 1MB
const TMP_MAX_AGE_MS = 60 * 60 * 1000; // 孤儿 .tmp-* 超过 1 小时即清理
// read/ 保留条数：环境变量可调（≥1），默认 200；防长生命周期频道无限增长
const READ_KEEP = (() => {
  const n = Number(process.env.AGENT_COMMS_READ_KEEP);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 200;
})();

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 存储 ----------

const chDir = (ch, sub) => path.join(SPOOL_ROOT, ch, sub);
function ensureDirs(ch) {
  for (const sub of ['unread', 'read']) {
    fs.mkdirSync(chDir(ch, sub), { recursive: true, mode: 0o700 });
  }
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
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function allEventFiles(ch) {
  return [
    ...listEventFiles(chDir(ch, 'unread')).map((f) => [chDir(ch, 'unread'), f]),
    ...listEventFiles(chDir(ch, 'read')).map((f) => [chDir(ch, 'read'), f]),
  ];
}
function workerLastEvents(ch, cache) {
  const last = new Map(); // worker -> {kind, at, ts}
  for (const [dir, f] of allEventFiles(ch)) {
    let ev;
    if (cache) {
      if (cache.has(f)) ev = cache.get(f);
      else { ev = readEvent(dir, f); cache.set(f, ev); }
    } else {
      ev = readEvent(dir, f);
    }
    if (!ev?.worker) continue;
    const prev = last.get(ev.worker);
    if (!prev || ev.ts > prev.ts) last.set(ev.worker, { kind: ev.kind, at: ev.at, ts: ev.ts });
  }
  return last;
}
function workersInChannel(ch, cache) {
  return [...workerLastEvents(ch, cache).keys()].sort();
}
// 节流检查用：只解析最新尾部文件，找该 worker 最近一次事件
function lastEventForWorker(ch, worker) {
  const files = [
    ...listEventFiles(chDir(ch, 'unread')).map((f) => [chDir(ch, 'unread'), f]),
    ...listEventFiles(chDir(ch, 'read')).map((f) => [chDir(ch, 'read'), f]),
  ].sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, THROTTLE_TAIL); // 最新在前
  for (const [dir, f] of files) {
    const ev = readEvent(dir, f);
    if (ev?.worker === worker) return ev;
  }
  return null;
}
// read/ 保留最新 READ_KEEP 条 + 清理超过 1 小时的孤儿 .tmp-*（原子写残留）
function pruneChannel(ch) {
  const readDir = chDir(ch, 'read');
  const files = listEventFiles(readDir);
  for (const f of files.slice(0, Math.max(0, files.length - READ_KEEP))) {
    try { fs.unlinkSync(path.join(readDir, f)); } catch { /* 竞争留给下轮 */ }
  }
  const now = Date.now();
  for (const sub of ['unread', 'read']) {
    const dir = chDir(ch, sub);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (!f.includes('.tmp-')) continue;
      try {
        const st = fs.statSync(path.join(dir, f));
        if (now - st.mtimeMs > TMP_MAX_AGE_MS) fs.unlinkSync(path.join(dir, f));
      } catch { /* 竞争留给下轮 */ }
    }
  }
}

// ---------- 频道令牌 ----------

const tokenFile = (ch) => path.join(SPOOL_ROOT, ch, '.token');
function issueToken(ch) {
  const tok = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(tokenFile(ch), tok + '\n', { mode: 0o600 });
  return tok;
}
function tokenMatches(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function checkToken(ch, p) {
  const tok = typeof p?.token === 'string' ? p.token.trim() : '';
  if (!tok) {
    throw new ToolError('token 必填：open_channel 返回的 comms 令牌（写在派发 prompt 的「comms 令牌」行）');
  }
  let expect = '';
  try { expect = fs.readFileSync(tokenFile(ch), 'utf8').trim(); } catch { }
  if (!expect || !tokenMatches(tok, expect)) {
    throw new ToolError(`token 不匹配（频道 ${ch}）：请使用该频道 open_channel 返回的令牌原文，不要自行编造`);
  }
  return tok;
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
  const token = issueToken(ch);
  pruneChannel(ch);
  return {
    channel: ch, token, spool: path.join(SPOOL_ROOT, ch),
    note: '把「comms 频道」「worker 名」「comms 令牌」三行写进每个派发 prompt；report/wait/read 都要带令牌。',
  };
}

function doReport(p) {
  const ch = checkChannel(p);
  checkToken(ch, p);
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
    const last = lastEventForWorker(ch, worker);
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
  pruneChannel(ch);
  return { ok: true, channel: ch, worker, kind, at: ev.at, file };
}

async function doWait(p) {
  const ch = checkChannel(p);
  checkToken(ch, p);
  const onlyWorker = optionalWorker(p);
  const req = Number(p?.timeout_ms);
  const timeoutMs = Math.max(1000, Math.min(WAIT_MAX_MS, Number.isFinite(req) ? req : WAIT_DEFAULT_MS));
  ensureDirs(ch);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const seen = new Map(); // 已解析过的 unread 事件文件（增量解析，避免每轮 poll 全量重读）

  for (;;) {
    const unreadDir = chDir(ch, 'unread');
    const matching = [];
    for (const f of listEventFiles(unreadDir)) {
      if (!seen.has(f)) seen.set(f, readEvent(unreadDir, f));
      const ev = seen.get(f);
      if (onlyWorker === undefined) matching.push([f, ev]);
      else if (ev?.worker === onlyWorker) matching.push([f, ev]);
    }
    if (matching.length > 0) {
      const events = [];
      for (const [f, ev] of matching) {
        try {
          fs.renameSync(path.join(unreadDir, f), path.join(chDir(ch, 'read'), f));
          const moved = ev ?? readEvent(chDir(ch, 'read'), f);
          if (moved) events.push(moved);
        } catch { /* 写入方竞争等下一轮 poll 收 */ }
      }
      if (events.length > 0) {
        return {
          status: 'events', timed_out: false, waited_ms: Date.now() - startedAt,
          events, workers_in_channel: workersInChannel(ch, seen),
          ...(onlyWorker !== undefined ? { filtered: `仅返回 worker=${onlyWorker} 的事件，其它 worker 事件仍在 unread` } : {}),
        };
      }
    }
    if (Date.now() >= deadline) {
      pruneChannel(ch);
      const lastEvents = workerLastEvents(ch, seen);
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
  checkToken(ch, p);
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
    description: '【协调者用】开一个新 comms 频道：返回带随机后缀的频道名与频道令牌。每次派发任务批次前必须先调用本工具，把返回的频道名、令牌连同 worker 名写进每个派发 prompt 的「comms 频道」「comms 令牌」行——随机后缀保证多个主会话并发时频道不会串台，令牌保证其它会话或无令牌的代理动不了本频道。',
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
    description: '【worker 用】例行汇报：把里程碑/进度/结果写成锚工件事件落盘，供协调者用 wait_worker_event 聚合等待。channel/worker/token 三参取自任务描述开头的「comms 频道」「worker 名」「comms 令牌」三行（令牌不匹配服务端会拒绝）。节流规则：两次 report 之间至少间隔 5 个工具调用，服务端对非 done 汇报强制 2 秒最小间隔（违者报错）；summary ≤200 字。紧急事项（验收标准要变/继续做会产生无效功/不可逆操作/外部阻塞超期）不要用本工具，直接调 RespondToCoordinator。任务结束必须 report 一次 kind="done"。',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'comms 频道，取自任务描述中「comms 频道」的值' },
        worker: { type: 'string', description: 'worker 名，取自任务描述中「worker 名」的值，未给则用你的 agentId' },
        token: { type: 'string', description: 'comms 令牌，取自任务描述中「comms 令牌」的值（open_channel 签发，与频道一一对应）' },
        kind: { type: 'string', enum: KINDS, description: 'milestone=里程碑；blocked=受阻需协调者注意（非紧急）；done=任务完成（结束时必发）' },
        summary: { type: 'string', description: '≤200 字的事件摘要（协调者主要读这个）' },
        message: { type: 'string', description: '可选，≤20000 字的详情/产出全文' },
      },
      required: ['channel', 'worker', 'token', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_worker_event',
    description: '【协调者用】阻塞等待任意 worker 的新事件（里程碑/blocked/done），有事件立即返回事件数组；超时返回沉默摘要（含各 worker 最后事件时间）。需携带 open_channel 返回的 token。派发后应尽快调用本工具形成"等待-处理"循环：单次最长 240000ms，没等齐所有 worker 就再次调用。返回的 events 已从频道"抽走"（下次不重复返回），历史可用 read_events 回看。可传 worker 只等指定 worker（其它 worker 事件留在频道内不被消费）。',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'comms 频道，与派发时写给 worker 的一致' },
        token: { type: 'string', description: 'comms 令牌，open_channel 返回值里的 token' },
        timeout_ms: { type: 'number', description: '本次最长阻塞毫秒数，默认 60000，上限 240000；到点返回沉默摘要，可循环再调' },
        worker: { type: 'string', description: '可选，只等该 worker 的事件' },
      },
      required: ['channel', 'token'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_events',
    description: '【协调者用】回看频道内已被 wait 消费过的历史事件（最新在末尾），用于断线补读与复盘；不影响 unread。需携带 open_channel 返回的 token。read/ 只保留最新 200 条（AGENT_COMMS_READ_KEEP 可调），更早的自动清理。',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'comms 频道' },
        token: { type: 'string', description: 'comms 令牌，open_channel 返回值里的 token' },
        limit: { type: 'number', description: '最多返回条数，默认 50，上限 200' },
      },
      required: ['channel', 'token'],
      additionalProperties: false,
    },
  },
];

// ---------- JSON-RPC over stdio（1MB 行上限，防超长输入撑爆内存） ----------

function handleLine(line) {
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
}

let buf = Buffer.alloc(0);
let discarding = false; // 超长行截断后置位：按行框持续丢弃直到下一个换行，再恢复解析
process.stdin.on('data', (chunk) => {
  buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
  for (;;) {
    const nl = buf.indexOf(0x0a);
    if (nl < 0) {
      if (buf.length > LINE_MAX) {
        process.stderr.write(`[agent-comms] 丢弃超长无换行输入（>${LINE_MAX} 字节）——畸形输入防护，自下一个换行起恢复\n`);
        buf = Buffer.alloc(0);
        discarding = true;
      }
      break;
    }
    const line = buf.slice(0, nl).toString('utf8');
    buf = buf.slice(nl + 1);
    if (discarding) {
      discarding = false;
      continue;
    }
    handleLine(line);
  }
});
process.stdin.on('end', () => process.exit(0));
process.stderr.write(`[agent-comms] stdio MCP server v${VERSION} started, spool=${SPOOL_ROOT}\n`);
