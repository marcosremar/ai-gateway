import numpy as np

import server


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
