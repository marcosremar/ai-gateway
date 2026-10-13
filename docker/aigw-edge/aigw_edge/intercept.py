import functools
import re
import unicodedata

PUNCTUATION = re.compile(r"[-,!?.;:'\"()«»]")


@functools.lru_cache(maxsize=4096)
def normalise(text: str) -> str:
    bare = "".join(ch for ch in unicodedata.normalize("NFD", text.lower()) if unicodedata.category(ch) != "Mn")
    return " ".join(PUNCTUATION.sub(" ", bare).split())


def phrases(rule: dict, key: str) -> list[str]:
    return [f" {normalise(p)} " for p in rule.get(key) or [] if isinstance(p, str) and normalise(p)]


def match_rule(rules, text: str) -> dict | None:
    said = f" {normalise(text)} "
    for rule in rules if isinstance(rules, list) and said.strip() else []:
        if not isinstance(rule, dict) or (rule.get("question") and "?" not in text):
            continue
        if said in phrases(rule, "whole") or any(phrase in said for phrase in phrases(rule, "contains")):
            return rule
    return None
