// agent-comms MCP stdio server — 主/子代理实时互通插件核心
//
// 三个工具（协议细节见各 inputSchema.description，会随每次请求重发）：
//   report            子代理例行汇报 → 写锚工件事件文件（原子写入）
//   wait_worker_event 协调者阻塞等"任意 worker"事件 + 超时摘要（沉默检测）
//   read_events       回看频道历史事件（断线补读）
//
// 存储语义（与 ZCode 内置会话邮箱同款）：spool/<channel>/unread/*.json，
// wait 抽干 unread（rename 到 read/）后返回——派发后、等待前到达的事件不丢失。
// 事件文件名 = 15 位零填充毫秒时间戳-随机后缀.json，字典序即时间序。
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const SPOOL_ROOT = process.env.AGENT_COMMS_SPOOL_ROOT
  || path.join(os.homedir(), '.zcode', 'agent-comms', 'spool');
const POLL_MS = 400;
const WAIT_DEFAULT_MS = 60000;
const WAIT_MAX_MS = 240000; // 必须小于 plugin.json 的 timeoutMs(600000)，留清理余量
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KINDS = ['milestone', 'blocked', 'done'];

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
function workersInChannel(ch) {
  const s = new Set();
  for (const sub of ['unread', 'read']) {
    for (const f of listEventFiles(chDir(ch, sub))) {
      const ev = readEvent(chDir(ch, sub), f);
      if (ev?.worker) s.add(ev.worker);
    }
  }
  return [...s].sort();
}

// ---------- 参数校验 ----------

class ToolError extends Error {}
function checkChannel(p) {
  const ch = typeof p?.channel === 'string' ? p.channel.trim() : '';
  if (!NAME_RE.test(ch)) {
    throw new ToolError(`channel 必填，且只能含字母数字._-（长度 1-64），收到: ${JSON.stringify(p?.channel)}`);
  }
  return ch;
}
function checkWorker(p) {
  const w = typeof p?.worker === 'string' ? p.worker.trim() : '';
  if (!NAME_RE.test(w)) {
    throw new ToolError(`worker 必填，且只能含字母数字._-（长度 1-64），收到: ${JSON.stringify(p?.worker)}`);
  }
  return w;
}

// ---------- 工具实现 ----------

function doReport(p) {
  const ch = checkChannel(p);
  const worker = checkWorker(p);
  const summary = typeof p.summary === 'string' ? p.summary.trim() : '';
  if (!summary) throw new ToolError('summary 必填（≤200 字的事件摘要）');
  if (summary.length > 200) throw new ToolError(`summary 超长（${summary.length} > 200 字），请压缩`);
  const kind = KINDS.includes(p.kind) ? p.kind : 'milestone';
  const message = typeof p.message === 'string' ? p.message.slice(0, 20000) : undefined;

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
  const req = Number(p?.timeout_ms);
  const timeoutMs = Math.max(1000, Math.min(WAIT_MAX_MS, Number.isFinite(req) ? req : WAIT_DEFAULT_MS));
  ensureDirs(ch);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  for (;;) {
    const unreadDir = chDir(ch, 'unread');
    const files = listEventFiles(unreadDir);
    if (files.length > 0) {
      const events = [];
      for (const f of files) {
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
        };
      }
    }
    if (Date.now() >= deadline) {
      return {
        status: 'timeout', timed_out: true, waited_ms: Date.now() - startedAt, events: [],
        workers_in_channel: workersInChannel(ch),
        hint: '沉默检测：等待期内无任何 worker 新事件。对照 workers_in_channel 判断谁没动静；若已超出预期完成时间，可 SendMessage 质询该 worker，或确认其是否已结束/中断。',
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
    name: 'report',
    description: '【worker 用】例行汇报：把里程碑/进度/结果写成锚工件事件落盘，供协调者用 wait_worker_event 聚合等待。节流规则：两次 report 之间至少间隔 5 个工具调用；summary ≤200 字。紧急事项（验收标准要变/继续做会产生无效功/不可逆操作/外部阻塞超期）不要用本工具，直接调 RespondToCoordinator。任务结束必须 report 一次 kind="done"。',
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
    description: '【协调者用】阻塞等待任意 worker 的新事件（里程碑/blocked/done），有事件立即返回事件数组；超时返回沉默摘要。派发后应尽快调用本工具形成"等待-处理"循环：单次最长 240000ms，没等齐所有 worker 就再次调用。返回的 events 已从频道"抽走"（下次不重复返回），历史可用 read_events 回看。',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'comms 频道，与派发时写给 worker 的一致' },
        timeout_ms: { type: 'number', description: '本次最长阻塞毫秒数，默认 60000，上限 240000；到点返回沉默摘要，可循环再调' },
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
      serverInfo: { name: 'agent-comms', version: '0.1.0' },
    } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    (async () => {
      try {
        let result;
        if (name === 'report') result = doReport(args);
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
process.stderr.write(`[agent-comms] stdio MCP server started, spool=${SPOOL_ROOT}\n`);
