"""headless CLI 运行器：供本插件的功能测试使用。

凭证读取逻辑源自 zcode-open-bridge（运行时读 ~/.zcode/v2/config.json，
不存储任何密钥）。前提：~/.zcode/cli/config.json 已含 provider + model.main
（配方见 docs/子代理沟通-开发方案-2026-09-08.md §3.4）。

用法: python tests/headless_run.py "<单行 prompt>" [--cwd DIR] [--json]
"""
import json
import os
import subprocess
import sys
from pathlib import Path

ZCODE_CJS = r"D:\ZCode\resources\glm\zcode.cjs"
V2_CONFIG = Path.home() / ".zcode" / "v2" / "config.json"
DEFAULT_WORKDIR = Path.home() / ".zcode" / "workspace" / "default" / "tmp" / "p0-workdir"


def load_api_key():
    cfg = json.loads(V2_CONFIG.read_text(encoding="utf-8"))
    p = cfg.get("provider", {}).get("builtin:bigmodel-coding-plan")
    if not p or not (p.get("options", {}) or {}).get("apiKey"):
        raise SystemExit("builtin:bigmodel-coding-plan provider has no apiKey")
    return p["options"]["apiKey"]


def run(prompt, workdir=None, as_json=True, timeout=540):
    env = {**os.environ, "ANTHROPIC_API_KEY": load_api_key()}
    cmd = ["node", ZCODE_CJS, "--cwd", str(workdir or DEFAULT_WORKDIR)]
    if as_json:
        cmd.append("--json")
    cmd += ["--prompt", prompt]
    r = subprocess.run(cmd, env=env, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout)
    return r


def main():
    args = sys.argv[1:]
    prompt = args[0]
    workdir = None
    if "--cwd" in args:
        workdir = args[args.index("--cwd") + 1]
    r = run(prompt, workdir=workdir)
    out = (r.stdout or "") + (("\n[stderr]\n" + r.stderr) if (r.stderr or "").strip() else "")
    print(out[-8000:] if len(out) > 8000 else out)
    print(f"\n[exit={r.returncode}]")
    sys.exit(r.returncode)


if __name__ == "__main__":
    main()
