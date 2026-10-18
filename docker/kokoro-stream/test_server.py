import asyncio
import json
import os
import re
import sys
import threading
from pathlib import Path

import numpy as np
import pytest

import server
from normalize import ordinal, words

CASES = Path(__file__).with_name("tts_normalize_cases.tsv")


def test_a_long_first_sentence_starts_with_its_first_clause():
    text = "El equipo de ventas superó el objetivo en un doce por ciento, sobre todo gracias a los nuevos clientes en Europa. Gracias."
    assert server.pieces(text) == [
        "El equipo de ventas superó el objetivo en un doce por ciento,",
        "sobre todo gracias a los nuevos clientes en Europa.",
        "Gracias.",
    ]


def test_short_sentences_stay_whole():
    assert server.pieces("Hola a todos, empecemos. ¿Alguna pregunta?") == ["Hola a todos, empecemos.", "¿Alguna pregunta?"]


def test_the_first_piece_starts_20_ms_before_the_voice():
    silence, voice = np.zeros(4800, dtype=np.float32), np.full(2400, 0.1, dtype=np.float32)
    trimmed = server.from_voice(np.concatenate([silence, voice]))
    assert server.ONSET_MARGIN_SAMPLES <= np.flatnonzero(trimmed)[0] <= server.ONSET_MARGIN_SAMPLES + 120


def test_silence_alone_is_kept():
    silence = np.zeros(1000, dtype=np.float32)
    assert len(server.from_voice(silence)) == 1000


def test_pause_tags_split_the_text_and_keep_their_length():
    assert server.segments("Bom dia. [pause:400] Vamos começar.") == [("Bom dia. ", 400), (" Vamos começar.", 0)]


def test_emphasis_marks_are_removed_and_their_words_kept():
    assert server.without_emphasis("Foi *incrível*, de verdade!") == ("Foi incrível, de verdade!", ["incrível"])


def with_numbers_in_words(expected: str, voice: str) -> str:
    language = server.NUMBER_LANGUAGES.get(voice)
    if not language:
        return expected
    expected = re.sub(r"(\d+)([ºª])", lambda m: ordinal(int(m[1]), m[2] == "ª", language), expected)
    return re.sub(r"\d+", lambda m: words(int(m[0]), language), expected)


def test_numbers_and_abbreviations_are_spoken_per_language():
    voices = {language: letter for letter, language in server.LANGUAGES.items()}
    for line in CASES.read_text(encoding="utf-8").splitlines()[1:]:
        lang, text, expected, *only = line.split("\t")
        if only == ["rust"]:
            continue
        voice = voices[lang]
        assert server.spoken(text, voice) == with_numbers_in_words(expected, voice), text


class Session:
    def __init__(self, provider: str):
        self.provider = provider

    def get_providers(self) -> list[str]:
        return [self.provider, "CPUExecutionProvider"]


class Request:
    headers: dict = {}

    def __init__(self, body: dict):
        self.body = body

    async def json(self) -> dict:
        return self.body


@pytest.fixture
def loaded(monkeypatch):
    stub = server.Engine(front=Session("CUDAExecutionProvider"), generator=Session("CPUExecutionProvider"), opening=Session("CUDAExecutionProvider"), vocab={}, voices={"pf_dora": None})
    monkeypatch.setattr(server, "engine", stub)
    monkeypatch.setattr(server, "slots", threading.BoundedSemaphore(8))


def test_a_bad_request_is_refused_before_any_audio_is_streamed(loaded):
    for body, code in [
        ({"input": "Olá.", "voice": "pf_dora", "speed": "fast"}, "invalid_speed"),
        ({"input": "Olá.", "voice": "pf_dora", "speed": 10}, "invalid_speed"),
        ({"input": "Olá.", "voice": "pf_dora", "speed": 0.1}, "invalid_speed"),
        ({"input": "Código 1" + "0" * 40 + ".", "voice": "pf_dora"}, "invalid_input"),
        ({"input": " ", "voice": "pf_dora"}, "invalid_input"),
        ({"input": "Olá.", "voice": "xx_nobody"}, "invalid_voice"),
    ]:
        response = asyncio.run(server.speech(Request(body)))
        assert response.status_code == 400 and json.loads(response.body)["error"]["code"] == code, body
    for speed in [None, 0.25, 1.5, 4]:
        response = asyncio.run(server.speech(Request({"input": "Às 21h.", "voice": "pf_dora", "speed": speed})))
        assert response.status_code == 200 and response.media_type.startswith("audio/pcm"), speed


def test_health_names_the_onnx_provider_each_session_runs_on(loaded, monkeypatch):
    monkeypatch.setattr(server, "MODEL_REVISION", "8bc34e5")
    assert server.health() == {
        "status": "ok",
        "voices": ["pf_dora"],
        "providers": {"front": "CUDAExecutionProvider", "generator": "CPUExecutionProvider", "opening": "CUDAExecutionProvider"},
        "revision": "8bc34e5",
    }


def test_the_last_word_of_a_phrase_is_longer_and_a_question_rises():
    chars = list("bom dia, tudo bem?")
    rate, semitones = server.controls(chars, [])
    assert rate[1 + chars.index("d")] == server.PHRASE_END_RATE
    assert rate[1 + chars.index("t")] == 1.0
    last = 1 + len(chars) - 2
    assert semitones[last] == server.QUESTION_RISE_SEMITONES and semitones[1 + chars.index("b")] == 0
    assert rate[0] == rate[-1] == 1.0


def test_an_emphasized_word_is_found_even_with_other_stress_marks():
    chars = list("foi ˌiŋkɾˈivew, de")
    rate, semitones = server.controls(chars, ["iŋkɾˈivew"])
    start = 1 + chars.index("ˌ") + 1
    assert rate[start] == server.EMPHASIS_RATE and semitones[start] == server.EMPHASIS_SEMITONES
    assert semitones[1] == 0


def test_stressed_e_and_o_follow_the_dictionary_and_the_word_before():
    for text, espeak, fixed in [
        ("hoje o fogo", "ˈɔʒy ʊ fˈɔɡʊ", "ˈoʒy ʊ fˈoɡʊ"),
        ("o jogo", "ʊ ʒˈɔɡʊ", "ʊ ʒˈoɡʊ"),
        ("eu jogo", "eʊ ʒˈoɡʊ", "eʊ ʒˈɔɡʊ"),
        ("um cafezinho para a vovozinha", "ũŋ kˌafezˈiɲʊ pˌaɾæ a vˌovozˈiɲæ", "ũŋ kˌafɛzˈiɲʊ pˌaɾæ a vˌovɔzˈiɲæ"),
        ("pela moeda", "pˈelæ mˌoˈedæ", "pˈelæ mˌoˈɛdæ"),
        ("bom", "bˈõ", "bˈõ"),
    ]:
        assert server.fix_vowels(text, espeak) == fixed, text


def test_providers_are_a_comma_separated_list_and_cpu_by_default():
    assert server.providers("CUDAExecutionProvider, CPUExecutionProvider") == ["CUDAExecutionProvider", "CPUExecutionProvider"]
    if "KOKORO_PROVIDERS" not in os.environ:
        assert server.PROVIDERS == ["CPUExecutionProvider"]


@pytest.mark.skipif(sys.platform == "darwin" and not os.environ.get("ESPEAK_DATA"), reason="espeakng-loader's macOS build ignores its data path: set ESPEAK_DATA and ESPEAK_LIBRARY")
def test_espeak_phonemizes_every_language():
    for voice, text in server.WARM_UP.items():
        assert any(mark in server.phonemize(text, voice) for mark in server.STRESS), voice
