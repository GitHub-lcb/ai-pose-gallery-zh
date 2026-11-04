# -*- coding: utf-8 -*-
"""从 nvzhuang 的 data-anime.js 生成 data/costume-anime.json（原始日文/英文格式）。

用法（仓库根目录）: python scripts/import_anime_costumes.py [--source <nvzhuang路径>]
"""
import argparse
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
DEFAULT_SOURCE = os.path.join(ROOT, "..", "nvzhuang", "data-anime.js")


def parse_data_js(path: str) -> tuple[dict, list[dict]]:
    text = open(path, encoding="utf-8").read()
    meta_match = re.search(r"const META_ANIME = (\{.*?\});", text, re.S)
    data_match = re.search(r"const D_ANIME = (\[.*?\]);", text, re.S)
    if not meta_match or not data_match:
        raise SystemExit(f"无法解析数据文件: {path}")
    return json.loads(meta_match.group(1)), json.loads(data_match.group(1))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=DEFAULT_SOURCE, help="nvzhuang/data-anime.js 路径")
    args = parser.parse_args()

    meta, records = parse_data_js(args.source)
    out = []
    for item in records:
        cid = item["id"]
        out.append(
            {
                "id": cid,
                "カテゴリ": item["カテゴリ"],
                "キーワード": item["キーワード"],
                "サムネ": f"thumbs/costume-anime/{cid}.webp",
                "画像": f"img/costume-anime/{cid}.webp",
                "原寸": item.get("原寸", ""),
            }
        )
    out.sort(key=lambda x: (x["id"].split("-")[0], x["id"]))
    meta_out = {
        "total": len(out),
        "cats": meta["cats"],
        "counts": meta["counts"],
        "source": "ai-costume-anime-gallery.pages.dev",
    }
    with open(os.path.join(DATA, "costume-anime.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    with open(os.path.join(DATA, "costume-anime-meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta_out, f, ensure_ascii=False, indent=2)
    print(f"OK 动漫服装原始数据: {len(out)} 条 -> data/costume-anime.json")
    print("分类数量:", meta["counts"])


if __name__ == "__main__":
    main()
