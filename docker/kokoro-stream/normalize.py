import re

from num2words import num2words

NUM_LANG = {"pt": "pt_BR", "es": "es", "fr": "fr", "it": "it", "en": "en"}
MONTHS = {
    "pt": ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"],
    "es": ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
    "fr": ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
    "it": ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"],
    "en": ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
}
ABBREVIATIONS = {
    "pt": {"Dr.": "doutor", "Dra.": "doutora", "Sr.": "senhor", "Sra.": "senhora", "Prof.": "professor", "etc.": "et cetera"},
    "es": {"Dr.": "doctor", "Dra.": "doctora", "Sr.": "señor", "Sra.": "señora", "Prof.": "profesor", "etc.": "etcétera"},
    "fr": {"M.": "monsieur", "Mme": "madame", "Dr": "docteur", "Pr": "professeur", "etc.": "et cetera"},
    "it": {"Dott.": "dottor", "Sig.": "signor", "Sig.ra": "signora", "Prof.": "professor", "ecc.": "eccetera"},
    "en": {"Dr.": "doctor", "Mr.": "mister", "Mrs.": "missus", "Prof.": "professor", "etc.": "et cetera"},
}
CURRENCY = {
    "R$": {"pt": ("real", "reais", "centavo", "centavos", "e")},
    "€": {"es": ("euro", "euros", "céntimo", "céntimos", "con"), "fr": ("euro", "euros", "centime", "centimes", "et"), "it": ("euro", "euro", "centesimo", "centesimi", "e"), "pt": ("euro", "euros", "centavo", "centavos", "e")},
    "$": {"en": ("dollar", "dollars", "cent", "cents", "and")},
}
HOUR_WORD = {"pt": "horas", "es": "", "fr": "heures", "it": "", "en": ""}


def words(n: int, lang: str) -> str:
    return num2words(n, lang=NUM_LANG[lang])


def money(units: int, cents: int, names: tuple, lang: str) -> str:
    one, many, cent, cents_name, joiner = names
    spoken = f"{words(units, lang)} {one if units == 1 else many}"
    if cents:
        spoken += f" {joiner} {words(cents, lang)} {cent if cents == 1 else cents_name}"
    return spoken


def time_of_day(hours: int, minutes: int, lang: str, meridiem: str = "") -> str:
    if lang == "en":
        spoken = words(hours, lang) + (f" {words(minutes, lang)}" if minutes else "")
        return spoken + (f" {' '.join(meridiem.replace('.', '').lower())}" if meridiem else "")
    hour_word = HOUR_WORD[lang]
    spoken = f"{words(hours, lang)} {hour_word}".strip()
    if minutes:
        spoken += f" {'e' if lang in ('pt', 'it') else 'y' if lang == 'es' else ''} {words(minutes, lang)}".replace("  ", " ")
    return spoken


def date(day: int, month: int, year: int, lang: str) -> str:
    name = MONTHS[lang][month - 1]
    if lang == "en":
        return f"{name} {num2words(day, lang='en', to='ordinal')}, {words(year, lang)}"
    if lang == "fr":
        return f"{words(day, lang)} {name} {words(year, lang)}"
    joiner = " de " if lang in ("pt", "es") else " "
    return f"{words(day, lang)}{joiner}{name}{joiner}{words(year, lang)}"


def normalize(text: str, lang: str) -> str:
    for short, spoken in ABBREVIATIONS[lang].items():
        text = re.sub(rf"(?<!\w){re.escape(short)}(?=\s|$)", spoken, text)
    for symbol, by_lang in CURRENCY.items():
        names = by_lang.get(lang)
        if not names:
            continue
        before = rf"{re.escape(symbol)}\s?(\d+)(?:[.,](\d{{2}}))?"
        after = rf"(\d+)(?:[.,](\d{{2}}))?\s?{re.escape(symbol)}"
        text = re.sub(before, lambda m: money(int(m[1]), int(m[2] or 0), names, lang), text)
        text = re.sub(after, lambda m: money(int(m[1]), int(m[2] or 0), names, lang), text)
    if lang == "en":
        text = re.sub(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b", lambda m: date(int(m[2]), int(m[1]), int(m[3]), lang), text)
    else:
        text = re.sub(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b", lambda m: date(int(m[1]), int(m[2]), int(m[3]), lang), text)
    text = re.sub(r"\b(\d{1,2})[h:](\d{2})(?:\s?([ap]\.?m\.?))?", lambda m: time_of_day(int(m[1]), int(m[2]), lang, m[3] or ""), text)
    text = re.sub(r"\b(\d+)[,.](\d+)\s?%", lambda m: f"{words(int(m[1]), lang)} {'point' if lang == 'en' else 'vírgula' if lang == 'pt' else 'coma' if lang == 'es' else 'virgule' if lang == 'fr' else 'virgola'} {words(int(m[2]), lang)} {'percent' if lang == 'en' else 'por cento' if lang in ('pt', 'es') else 'pour cent' if lang == 'fr' else 'per cento'}", text)
    text = re.sub(r"\b(\d+)\s?%", lambda m: f"{words(int(m[1]), lang)} {'percent' if lang == 'en' else 'por cento' if lang in ('pt', 'es') else 'pour cent' if lang == 'fr' else 'per cento'}", text)
    return re.sub(r"\d+", lambda m: words(int(m[0]), lang), text)
