from mt import Model, model_for, sentences, without_added_dash


class Pieces:
    def encode(self, text, out_type=str):
        return ["▁" + word for word in text.split()]


def model(targets: set[str]) -> Model:
    built = object.__new__(Model)
    built.source = Pieces()
    built.targets = targets
    return built


def test_each_pair_goes_to_the_model_the_app_uses():
    assert model_for("en", "fr") == "en-itc"
    assert model_for("pt", "en") == "roa-en"
    assert model_for("fr", "pt") == "itc-multi"
    assert model_for("pt", "de") == "itc-multi"
    assert model_for("nl", "fr") == "gem-multi"
    assert model_for("en", "es") is None
    assert model_for("ru", "en") is None


def test_sentences_split_after_a_stop_before_a_capital_or_a_number():
    assert sentences("Bom dia. Tudo bem? 3 pessoas vieram.") == ["Bom dia.", "Tudo bem?", "3 pessoas vieram."]
    assert sentences("O Dr. silva chegou.") == ["O Dr. silva chegou."]
    assert sentences("  ") == []


def test_the_source_ends_with_the_end_token_and_starts_with_the_target_language_when_the_model_has_it():
    assert model({">>fra<<", ">>por<<"}).tokens("Bom dia", "fr") == [">>fra<<", "▁Bom", "▁dia", "</s>"]
    assert model(set()).tokens("Bom dia", "en") == ["▁Bom", "▁dia", "</s>"]


def test_a_dash_the_source_did_not_have_is_dropped():
    assert without_added_dash("Claro.", "- Oui, oui.") == "Oui, oui."
    assert without_added_dash("- Claro.", "- Bien sûr.") == "- Bien sûr."
    assert without_added_dash("-3 graus.", "-3 degrés.") == "-3 degrés."


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_"):
            test()
    print("ok")
