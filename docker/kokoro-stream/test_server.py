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


class FakePocketModel:
    sample_rate = 24_000

    def __init__(self, lang: str):
        self.lang = lang
        self.spoken: list[tuple[str, str]] = []
        self.prompts: list[str] = []

    def get_state_for_audio_prompt(self, voice: str) -> dict:
        self.prompts.append(voice)
        return {"voice": voice}

    def generate_audio_stream(self, state: dict, text: str, stop=None):
        self.spoken.append((state["voice"], text))
        yield np.full(2400, 0.5, dtype=np.float32)
        yield np.zeros(1200, dtype=np.float32)


@pytest.fixture
def pocket(monkeypatch):
    models: dict[str, FakePocketModel] = {}

    def loader(lang: str) -> FakePocketModel:
        models[lang] = FakePocketModel(lang)
        return models[lang]

    engine = server.pocket_engine.Pocket(enabled=True, loader=loader, wait_s=0.05)
    monkeypatch.setattr(server, "pocket", engine)
    return engine, models


def speak_pocket(body: dict):
    return asyncio.run(server.speech(Request({"model": "pocket", **body})))


def loaded_language(engine, lang: str) -> None:
    engine.model(lang)
    for _ in range(200):
        if engine.status.get(lang) == "loaded":
            return
        threading.Event().wait(0.01)
    raise AssertionError(engine.health())


async def collect(response) -> bytes:
    return b"".join([chunk async for chunk in response.body_iterator])


def test_pocket_is_refused_while_off_and_kokoro_keeps_its_requests(monkeypatch):
    monkeypatch.setattr(server, "pocket", server.pocket_engine.Pocket(enabled=False, loader=lambda lang: None))
    response = speak_pocket({"input": "Olá.", "voice": "rafael", "language": "pt"})
    assert response.status_code == 400 and json.loads(response.body)["error"]["code"] == "invalid_model"


def test_a_pocket_language_loads_in_the_background_and_its_first_request_is_told_so(pocket):
    engine, models = pocket
    response = speak_pocket({"input": "Olá.", "voice": "rafael", "language": "Portuguese"})
    assert response.status_code == 503 and json.loads(response.body)["error"]["code"] == "loading"
    loaded_language(engine, "pt")
    assert models["pt"].spoken == [("estelle", "Olá.")], "warmed up with the language's default voice"
    response = speak_pocket({"input": "Bom *dia*,[pause:300] tudo bem?", "voice": "rafael", "language": "pt-BR", "response_format": "wav"})
    assert response.status_code == 200 and response.media_type == "audio/wav;rate=24000"
    audio = asyncio.run(collect(response))
    assert audio[:4] == b"RIFF" and len(audio) == 44 + 2 * 3600
    assert models["pt"].spoken[-1] == ("rafael", "Bom dia, tudo bem?")
    assert engine.locks["pt"].acquire(blocking=False), "the language is free again after the sentence"


def test_pocket_without_a_language_speaks_the_voice_language(pocket):
    engine, models = pocket
    loaded_language(engine, "es")
    response = speak_pocket({"input": "Hola.", "voice": "lola"})
    assert response.status_code == 200 and response.media_type == "audio/pcm;rate=24000"
    assert len(asyncio.run(collect(response))) == 2 * 3600


def test_a_bad_pocket_request_is_refused_before_any_audio(pocket):
    for body, code in [
        ({"input": "Olá.", "voice": "Ryan", "language": "pt"}, "invalid_voice"),
        ({"input": "Olá.", "voice": "rafael", "language": "Klingon"}, "invalid_language"),
        ({"input": "Olá.", "voice": "rafael", "language": "ja"}, "invalid_language"),
        ({"input": " ", "voice": "rafael"}, "invalid_input"),
        ({"input": "Olá.", "voice": "rafael", "response_format": "mp3"}, "invalid_response_format"),
        ({"input": "Olá.", "voice": "rafael", "speed": 9}, "invalid_speed"),
    ]:
        response = speak_pocket(body)
        assert response.status_code == 400 and json.loads(response.body)["error"]["code"] == code, body


def test_one_sentence_at_a_time_per_language(pocket):
    engine, _ = pocket
    loaded_language(engine, "fr")
    assert engine.acquire("fr")
    response = speak_pocket({"input": "Bonjour.", "voice": "estelle", "language": "fr"})
    assert response.status_code == 503 and json.loads(response.body)["error"]["code"] == "busy"
    engine.release("fr")


def test_health_reports_pocket_only_when_it_is_on(loaded, pocket):
    engine, _ = pocket
    loaded_language(engine, "en")
    assert server.health()["pocket"]["languages"]["en"] == "loaded"
    assert server.health()["pocket"]["languages"]["de"] == "not_loaded"


def test_pocket_language_names_and_codes():
    assert [server.pocket_engine.language_code(v) for v in ["Portuguese", "pt-BR", "pt_br", "FR", "dutch"]] == ["pt", "pt", "pt", "fr", "nl"]
    assert [server.pocket_engine.language_code(v) for v in [None, "", "ja", "Japanese", 3]] == [None, None, None, None, None]
    assert server.pocket_engine.codes("pt, fr ,xx,") == ["pt", "fr"]


def test_an_idle_pocket_language_is_unloaded_and_loads_again_on_its_next_request(monkeypatch):
    now = [1000.0]
    models: dict[str, FakePocketModel] = {}

    def loader(lang: str) -> FakePocketModel:
        models[lang] = FakePocketModel(lang)
        return models[lang]

    engine = server.pocket_engine.Pocket(enabled=True, loader=loader, wait_s=0.05, idle_unload_s=900, clock=lambda: now[0])
    monkeypatch.setattr(server, "pocket", engine)
    loaded_language(engine, "pt")
    loaded_language(engine, "fr")
    now[0] += 600
    response = speak_pocket({"input": "Olá.", "voice": "rafael", "language": "pt"})
    asyncio.run(collect(response))
    now[0] += 400
    assert engine.unload_idle() == ["fr"], "pt spoke 400 s ago, fr has been idle 1000 s"
    assert engine.health()["languages"]["fr"] == "unloaded" and "fr" not in engine.models
    assert not [k for k in engine.states if k[0] == "fr"], "its voice states are dropped too"
    assert engine.acquire("pt")
    now[0] += 2000
    assert engine.unload_idle() == [], "a language speaking a sentence is never unloaded"
    engine.release("pt")
    now[0] += 2000
    assert engine.unload_idle() == ["pt"]
    response = speak_pocket({"input": "Bonjour.", "voice": "estelle", "language": "fr"})
    assert response.status_code == 503 and json.loads(response.body)["error"]["code"] == "loading"
    loaded_language(engine, "fr")
    assert engine.health()["languages"]["fr"] == "loaded"
    never = server.pocket_engine.Pocket(enabled=True, loader=loader, idle_unload_s=0, clock=lambda: now[0])
    loaded_language(never, "es")
    now[0] += 10**6
    assert never.unload_idle() == [] and "es" in never.models


ERINOME = {"pt": ("erinome", "hf://me/erinome/erinome_6l.yaml@84dc", "hf://me/erinome/erinome_6l_voice.safetensors@84dc")}


def test_a_custom_pocket_model_speaks_its_language_with_its_own_voice_whatever_voice_is_asked(monkeypatch):
    models: dict[str, FakePocketModel] = {}

    def loader(lang: str) -> FakePocketModel:
        models[lang] = FakePocketModel(lang)
        return models[lang]

    engine = server.pocket_engine.Pocket(enabled=True, loader=loader, wait_s=0.05, custom=ERINOME)
    monkeypatch.setattr(server, "pocket", engine)
    loaded_language(engine, "pt")
    loaded_language(engine, "fr")
    voice_file = ERINOME["pt"][2]
    assert models["pt"].spoken == [(voice_file, "Olá.")], "warmed up with its own voice"
    for voice in ["rafael", "estelle", "erinome"]:
        response = speak_pocket({"input": "São 8h30.", "voice": voice, "language": "pt-BR"})
        assert response.status_code == 200, voice
        asyncio.run(collect(response))
        assert models["pt"].spoken[-1] == (voice_file, "São oito horas e trinta."), "numbers written out first"
    asyncio.run(collect(speak_pocket({"input": "Bom dia.", "voice": "erinome"})))
    assert models["pt"].spoken[-1] == (voice_file, "Bom dia."), "its voice says its language"
    asyncio.run(collect(speak_pocket({"input": "Bonjour.", "voice": "estelle", "language": "fr"})))
    assert models["fr"].spoken[-1] == ("estelle", "Bonjour."), "the other languages keep the predefined voices"
    assert set(engine.states) == {("pt", "erinome"), ("fr", "estelle")} and models["pt"].prompts == [voice_file]
    assert engine.health()["custom"] == {"pt": "erinome"}
    plain = server.pocket_engine.Pocket(enabled=True, loader=loader)
    assert "erinome" not in plain.voices() and "custom" not in plain.health()


def test_pocket_custom_comes_from_the_env_and_is_loaded_and_baked_from_its_config(monkeypatch):
    spec = "pt erinome hf://me/erinome/erinome_6l.yaml@84dc hf://me/erinome/erinome_6l_voice.safetensors@84dc"
    custom_models = server.pocket_engine.custom_models
    assert custom_models(spec) == ERINOME and custom_models(f" Portuguese {spec[3:]} ,") == ERINOME
    assert custom_models("") == {}
    for bad in ["pt erinome erinome_6l.yaml", "ja voice a.yaml b.safetensors"]:
        with pytest.raises(ValueError):
            custom_models(bad)
    loaded: list[FakePocketModel] = []

    def load_language(lang, threads, quantize, device="cpu", config=None):
        loaded.append(FakePocketModel(f"{lang} {config}"))
        return loaded[-1]

    monkeypatch.setattr(server.pocket_engine, "load_language", load_language)
    engine = server.pocket_engine.Pocket.from_env({"POCKET_TTS": "1", "POCKET_CUSTOM": spec})
    engine.loader("pt")
    engine.loader("fr")
    assert [m.lang for m in loaded] == [f"pt {ERINOME['pt'][1]}", "fr None"]
    assert server.pocket_engine.Pocket.from_env({"POCKET_TTS": "1"}).custom == {}
    loaded.clear()
    server.pocket_engine.bake(["pt"], ERINOME)
    assert [(m.lang, m.prompts) for m in loaded] == [("pt None", ["rafael", "estelle"]), (f"pt {ERINOME['pt'][1]}", [ERINOME["pt"][2]])]
