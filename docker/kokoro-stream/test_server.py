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


def test_pause_tags_split_the_text_and_keep_their_length():
    assert server.segments("Bom dia. [pause:400] Vamos começar.") == [("Bom dia. ", 400), (" Vamos começar.", 0)]


def test_emphasis_marks_are_removed_and_their_words_kept():
    assert server.without_emphasis("Foi *incrível*, de verdade!") == ("Foi incrível, de verdade!", ["incrível"])


def test_numbers_and_abbreviations_are_spoken_per_language():
    assert server.spoken("O Dr. Silva paga R$ 10,50.", "pf_dora") == "O doutor Silva paga dez reais e cinquenta centavos."
    assert server.spoken("नमस्ते 5", "hf_alpha") == "नमस्ते 5"


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
