"""agent-comms server.mjs 确定性回归测试（零模型成本）。

直接以子进程拉起 MCP stdio 服务器，用隔离的 AGENT_COMMS_SPOOL_ROOT 临时目录，
逐条验证协议语义：令牌鉴权、节流、邮箱消费、按 worker 过滤、沉默摘要、
保留清理、孤儿 tmp 清理、名称校验、超长行防护。

运行: python tests/test_server.py
"""
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "plugin" / "agent-comms" / "mcp" / "server.mjs"


class Server:
    """一个 MCP stdio 服务器实例的同步客户端（请求-响应串行，无并发竞态）。

    读侧走后台线程 + 队列，每次取响应都带超时——服务器若失聪，测试报错而非挂死。
    """

    def __init__(self, spool_root, extra_env=None, timeout=30):
        env = {**os.environ, "AGENT_COMMS_SPOOL_ROOT": str(spool_root)}
        if extra_env:
            env.update(extra_env)
        self.timeout = timeout
        self._lines = queue.Queue()
        self.proc = subprocess.Popen(
            ["node", str(SERVER)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env, text=True, encoding="utf-8",
        )
        threading.Thread(target=self._read_loop, daemon=True).start()
        self._id = 0

    def _read_loop(self):
        for line in self.proc.stdout:
            self._lines.put(line)
        self._lines.put("")  # EOF 哨兵

    def _wait_response(self, timeout=None):
        try:
            line = self._lines.get(timeout=timeout or self.timeout)
        except queue.Empty:
            raise AssertionError(f"server 没有在 {timeout or self.timeout}s 内给出响应")
        if not line:
            raise AssertionError("server closed stdout unexpectedly")
        return json.loads(line)

    def request(self, method, params=None):
        self._id += 1
        req = {"jsonrpc": "2.0", "id": self._id, "method": method}
        if params is not None:
            req["params"] = params
        self.proc.stdin.write(json.dumps(req) + "\n")
        self.proc.stdin.flush()
        while True:
            msg = self._wait_response()
            if msg.get("id") == self._id:
                return msg

    def call(self, tool, expect_error=False, **args):
        msg = self.request("tools/call", {"name": tool, "arguments": args})
        result = msg["result"]
        is_err = bool(result.get("isError"))
        text = result["content"][0]["text"]
        if expect_error:
            assert is_err, f"{tool} 应报错却成功: {text}"
            return text
        assert not is_err, f"{tool} 应成功却报错: {text}"
        return json.loads(text)

    def send_raw(self, data):
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()
        finally:
            try:
                self.proc.stdout.close()
            except Exception:
                pass


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="agent-comms-test-"))
        self.spool = self.tmp / "spool"
        self.s = Server(self.spool)
        self.addCleanup(self.s.close)
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_initialize_and_tools_list(self):
        msg = self.s.request("initialize", {"protocolVersion": "2024-11-05"})
        self.assertEqual(msg["result"]["serverInfo"]["name"], "agent-comms")
        tl = self.s.request("tools/list")
        names = {t["name"] for t in tl["result"]["tools"]}
        self.assertEqual(names, {"open_channel", "report", "wait_worker_event", "read_events"})
        for t in tl["result"]["tools"]:
            if t["name"] != "open_channel":
                self.assertIn("token", t["inputSchema"]["required"])

    def test_open_channel_issues_unique_channel_and_token(self):
        a = self.s.call("open_channel", slug="feat-x")
        b = self.s.call("open_channel", slug="feat-x")
        self.assertNotEqual(a["channel"], b["channel"])
        self.assertNotEqual(a["token"], b["token"])
        self.assertRegex(a["channel"], r"^feat-x-[0-9a-f]{6}$")
        self.assertRegex(a["token"], r"^[0-9a-f]{32}$")
        tok_file = self.spool / a["channel"] / ".token"
        self.assertTrue(tok_file.exists())
        self.assertEqual(tok_file.read_text(encoding="utf-8").strip(), a["token"])

    def test_report_requires_matching_token(self):
        ch = self.s.call("open_channel", slug="t")
        base = dict(channel=ch["channel"], worker="w1", summary="hi")
        err = self.s.call("report", expect_error=True, **base)
        self.assertIn("token", err)
        err = self.s.call("report", expect_error=True, token="f" * 32, **base)
        self.assertIn("不匹配", err)
        ok = self.s.call("report", token=ch["token"], **base)
        self.assertTrue(ok["ok"])
        unread = self.spool / ch["channel"] / "unread"
        files = list(unread.glob("*.json"))
        self.assertEqual(len(files), 1)
        ev = json.loads(files[0].read_text(encoding="utf-8"))
        self.assertEqual(ev["worker"], "w1")
        self.assertEqual(ev["kind"], "milestone")

    def test_token_is_per_channel(self):
        a = self.s.call("open_channel", slug="a")
        b = self.s.call("open_channel", slug="b")
        self.s.call("report", channel=a["channel"], token=a["token"], worker="w", summary="x")
        self.s.call("report", channel=b["channel"], token=a["token"],
                    worker="w", summary="x", expect_error=True)
        self.s.call("wait_worker_event", channel=a["channel"], token=b["token"],
                    timeout_ms=1000, expect_error=True)

    def test_throttle_and_done_exempt(self):
        ch = self.s.call("open_channel", slug="th")
        tok, chn = ch["token"], ch["channel"]
        self.s.call("report", channel=chn, token=tok, worker="w", summary="m1")
        err = self.s.call("report", channel=chn, token=tok, worker="w", summary="m2",
                          expect_error=True)
        self.assertIn("节流", err)
        self.s.call("report", channel=chn, token=tok, worker="w", summary="d1", kind="done")

    def test_wait_drains_unread_and_timeout_summarizes(self):
        ch = self.s.call("open_channel", slug="w")
        tok, chn = ch["token"], ch["channel"]
        self.s.call("report", channel=chn, token=tok, worker="w1", summary="s1", kind="done")
        r = self.s.call("wait_worker_event", channel=chn, token=tok, timeout_ms=2000)
        self.assertEqual(r["status"], "events")
        self.assertEqual(len(r["events"]), 1)
        self.assertEqual(r["events"][0]["worker"], "w1")
        d = self.spool / chn
        self.assertEqual(list((d / "unread").glob("*.json")), [])
        self.assertEqual(len(list((d / "read").glob("*.json"))), 1)
        t0 = time.time()
        r2 = self.s.call("wait_worker_event", channel=chn, token=tok, timeout_ms=1100)
        self.assertGreaterEqual(time.time() - t0, 1.0)
        self.assertEqual(r2["status"], "timeout")
        self.assertIn("w1", r2["worker_last_event"])
        self.assertEqual(r2["worker_last_event"]["w1"]["kind"], "done")

    def test_wait_worker_filter_leaves_others_in_unread(self):
        ch = self.s.call("open_channel", slug="f")
        tok, chn = ch["token"], ch["channel"]
        for w in ("w1", "w2"):
            self.s.call("report", channel=chn, token=tok, worker=w, summary="s", kind="done")
        r = self.s.call("wait_worker_event", channel=chn, token=tok, worker="w1", timeout_ms=2000)
        self.assertEqual([e["worker"] for e in r["events"]], ["w1"])
        unread = list((self.spool / chn / "unread").glob("*.json"))
        self.assertEqual(len(unread), 1)  # w2 的事件不被消费

    def test_read_events_returns_consumed_history(self):
        ch = self.s.call("open_channel", slug="rd")
        tok, chn = ch["token"], ch["channel"]
        for i in range(3):
            self.s.call("report", channel=chn, token=tok, worker=f"w{i}", summary=f"s{i}", kind="done")
        r = self.s.call("read_events", channel=chn, token=tok)
        self.assertEqual(r["unread_count"], 3)
        self.assertEqual(r["events"], [])
        self.s.call("wait_worker_event", channel=chn, token=tok, timeout_ms=2000)
        r2 = self.s.call("read_events", channel=chn, token=tok)
        self.assertEqual([e["summary"] for e in r2["events"]], ["s0", "s1", "s2"])

    def test_name_validation_fail_closed(self):
        ch = self.s.call("open_channel", slug="v")
        tok, chn = ch["token"], ch["channel"]
        for bad in ("con", "aux", "a.", "has space", "x/y", ""):
            self.s.call("report", channel=bad, token=tok, worker="w", summary="s", expect_error=True)
            self.s.call("report", channel=chn, token=tok, worker=bad, summary="s", expect_error=True)
        self.s.call("report", channel=chn, token=tok, worker="w", summary="s",
                    kind="nope", expect_error=True)
        self.s.call("report", channel=chn, token=tok, worker="w",
                    summary="x" * 201, expect_error=True)
        err = self.s.call("open_channel", slug="bad slug!", expect_error=True)
        self.assertIn("slug", err)

    def test_unknown_tool_is_error(self):
        text = self.s.call("nope", expect_error=True)
        self.assertIn("未知工具", text)


class RetentionTests(unittest.TestCase):
    def test_read_retention_and_tmp_orphan_cleanup(self):
        tmp = Path(tempfile.mkdtemp(prefix="agent-comms-ret-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        s = Server(tmp / "spool", extra_env={"AGENT_COMMS_READ_KEEP": "3"})
        self.addCleanup(s.close)
        ch = s.call("open_channel", slug="r")
        tok, chn = ch["token"], ch["channel"]
        for i in range(5):
            s.call("report", channel=chn, token=tok, worker=f"w{i}", summary="s", kind="done")
        s.call("wait_worker_event", channel=chn, token=tok, timeout_ms=2000)  # 5 条进 read/
        read_dir = tmp / "spool" / chn / "read"
        self.assertEqual(len(list(read_dir.glob("*.json"))), 5)
        old_tmp = read_dir / "0000000000000000-00000000.json.tmp-deadbeef"
        old_tmp.write_text("{}", encoding="utf-8")
        os.utime(old_tmp, (time.time() - 7200, time.time() - 7200))
        new_tmp = read_dir / "0000000000000001-00000000.json.tmp-cafebabe"
        new_tmp.write_text("{}", encoding="utf-8")
        r = s.call("wait_worker_event", channel=chn, token=tok, timeout_ms=1100)  # 超时触发清理
        self.assertEqual(r["status"], "timeout")
        remaining = sorted(p.name for p in read_dir.glob("*.json"))
        self.assertEqual(len(remaining), 3)  # 只留最新 3 条
        self.assertFalse(old_tmp.exists())
        self.assertTrue(new_tmp.exists())


class LineCapTests(unittest.TestCase):
    def test_oversized_line_does_not_kill_server(self):
        tmp = Path(tempfile.mkdtemp(prefix="agent-comms-line-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        s = Server(tmp / "spool")
        self.addCleanup(s.close)
        # 一条完整的超长行（带换行符）：服务端应截断整行，并从下一个换行起恢复解析
        s.send_raw("x" * (1024 * 1024 + 4096) + "\n")
        s.send_raw(json.dumps({"jsonrpc": "2.0", "id": 99,
                               "method": "initialize", "params": {}}) + "\n")
        deadline = time.time() + 15
        got = None
        while time.time() < deadline:
            try:
                msg = s._wait_response(timeout=max(0.1, deadline - time.time()))
            except AssertionError:
                break
            if msg.get("id") == 99:
                got = msg
                break
        self.assertIsNotNone(got, "server should discard the oversized line and answer initialize")
        self.assertIn("serverInfo", got["result"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
