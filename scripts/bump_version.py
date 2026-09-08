"""统一 bump 插件版本号（4 处落点，任一未恰好命中 1 处即中止不落盘）：

  1. plugin/agent-comms/.zcode-plugin/plugin.json   "version" 字段
  2. marketplace.json                                "version" 字段
  3. plugin/agent-comms/mcp/server.mjs               VERSION 常量
  4. README.md                                       Status 行的 vX.Y.Z.

用法:
  python scripts/bump_version.py 0.2.8   # 把全部落点改为 0.2.8
  python scripts/bump_version.py 0.2.7   # 目标与当前一致时幂等通过（用于校验一致性）
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

TARGETS = [
    ("plugin/agent-comms/.zcode-plugin/plugin.json",
     r'"version":\s*"[^"]+"', '"version": "{ver}"', "plugin.json"),
    ("marketplace.json",
     r'"version":\s*"[^"]+"', '"version": "{ver}"', "marketplace.json"),
    ("plugin/agent-comms/mcp/server.mjs",
     r"const VERSION = '[^']+'", "const VERSION = '{ver}'", "server.mjs"),
    ("README.md",
     r"v\d+\.\d+\.\d+\.", "v{ver}.", "README.md"),
]


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r"\d+\.\d+\.\d+", sys.argv[1]):
        sys.exit(__doc__)
    ver = sys.argv[1]
    updates = []
    for rel, pattern, tmpl, label in TARGETS:
        path = ROOT / rel
        text = path.read_text(encoding="utf-8")
        new, n = re.subn(pattern, tmpl.format(ver=ver), text)
        if n != 1:
            sys.exit(f"[bump] {label}: 模式命中 {n} 处（应为 1），中止不落盘")
        if new != text:
            path.write_text(new, encoding="utf-8")
            updates.append(label)
    if updates:
        print(f"[bump] 已更新: {', '.join(updates)}")
    print(f"[bump] 全部 4 处落点现为 {ver}")


if __name__ == "__main__":
    main()
