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
    "pt": {"Dr.": "doutor", "Dra.": "doutora", "Sr.": "senhor", "Sra.": "senhora", "Prof.": "professor", "etc.": "et cetera", "Av.": "avenida", "nº": "número", "pág.": "página"},
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
    return num2words(n, lang=NUM_LANG[lang]).replace(",", "")


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


DECIMAL_WORD = {"pt": "vírgula", "es": "coma", "fr": "virgule", "it": "virgola", "en": "point"}
PERCENT_WORD = {"pt": "por cento", "es": "por ciento", "fr": "pour cent", "it": "per cento", "en": "percent"}
UNITS = {
    "pt": {"km/h": ("quilômetro por hora", "quilômetros por hora"), "km": ("quilômetro", "quilômetros"), "kg": ("quilo", "quilos"), "mg": ("miligrama", "miligramas"), "ml": ("mililitro", "mililitros"), "cm": ("centímetro", "centímetros"), "mm": ("milímetro", "milímetros"), "min": ("minuto", "minutos"), "°C": ("grau", "graus"), "ºC": ("grau", "graus"), "g": ("grama", "gramas"), "m": ("metro", "metros"), "L": ("litro", "litros")},
    "es": {"km/h": ("kilómetro por hora", "kilómetros por hora"), "km": ("kilómetro", "kilómetros"), "kg": ("kilo", "kilos"), "mg": ("miligramo", "miligramos"), "ml": ("mililitro", "mililitros"), "cm": ("centímetro", "centímetros"), "mm": ("milímetro", "milímetros"), "min": ("minuto", "minutos"), "°C": ("grado", "grados"), "ºC": ("grado", "grados"), "g": ("gramo", "gramos"), "m": ("metro", "metros"), "L": ("litro", "litros")},
    "fr": {"km/h": ("kilomètre heure", "kilomètres heure"), "km": ("kilomètre", "kilomètres"), "kg": ("kilo", "kilos"), "mg": ("milligramme", "milligrammes"), "ml": ("millilitre", "millilitres"), "cm": ("centimètre", "centimètres"), "mm": ("millimètre", "millimètres"), "min": ("minute", "minutes"), "°C": ("degré", "degrés"), "g": ("gramme", "grammes"), "m": ("mètre", "mètres"), "L": ("litre", "litres")},
    "it": {"km/h": ("chilometro orario", "chilometri orari"), "km": ("chilometro", "chilometri"), "kg": ("chilo", "chili"), "mg": ("milligrammo", "milligrammi"), "ml": ("millilitro", "millilitri"), "cm": ("centimetro", "centimetri"), "mm": ("millimetro", "millimetri"), "min": ("minuto", "minuti"), "°C": ("grado", "gradi"), "g": ("grammo", "grammi"), "m": ("metro", "metri"), "L": ("litro", "litri")},
    "en": {"km/h": ("kilometer per hour", "kilometers per hour"), "km": ("kilometer", "kilometers"), "kg": ("kilo", "kilos"), "mg": ("milligram", "milligrams"), "ml": ("milliliter", "milliliters"), "cm": ("centimeter", "centimeters"), "mm": ("millimeter", "millimeters"), "min": ("minute", "minutes"), "°C": ("degree", "degrees"), "g": ("gram", "grams"), "m": ("meter", "meters"), "L": ("liter", "liters")},
}
LETTERS_PT = {"A": "a", "B": "bê", "C": "cê", "D": "dê", "E": "é", "F": "efe", "G": "gê", "H": "agá", "I": "i", "J": "jota", "K": "cá", "L": "ele", "M": "eme", "N": "ene", "O": "ó", "P": "pê", "Q": "quê", "R": "erre", "S": "esse", "T": "tê", "U": "u", "V": "vê", "W": "dáblio", "X": "xis", "Y": "ípsilon", "Z": "zê"}
ACRONYMS_READ_AS_WORDS_PT = {
    "ONU", "SUS", "UPA", "USP", "PIB", "ENEM", "SAMU", "FIFA", "NASA", "UNESCO", "UNICEF", "OTAN", "MEC", "DETRAN", "PROCON", "INEP", "IPEA", "IPCA",
    "SELIC", "FUNAI", "IBAMA", "UNICAMP", "UNESP", "UNIFESP", "EMBRAPA", "ANVISA", "ANATEL", "ANEEL", "CAPES", "SEBRAE", "SENAI", "SENAC", "SESC", "SESI",
    "AIDS", "LED", "PIN", "CEP", "PUC", "ITA", "INPE", "ETEC", "FATEC", "UNIP", "OVNI", "LASER", "RADAR", "COVID",
}
ORDINAL_LANGS = {"pt", "es", "it"}
UNIT_PATTERN = re.compile(r"(\d+(?:[.,]\d+)?)\s?(km/h|km|kg|mg|ml|cm|mm|min|°C|ºC|g|m|L)(?![\w/])")
PHONE = re.compile(r"\(?\b(\d{2})\)?\s?(\d{4,5})-(\d{4})\b")
ACRONYM = re.compile(r"\b[A-Z]{2,5}\b")
ROMAN = re.compile(r"^[IVX]+$")


def digit_by_digit(digits: str, lang: str) -> str:
    return " ".join(words(int(d), lang) for d in digits)


def ordinal(n: int, feminine: bool, lang: str) -> str:
    spoken = num2words(n, lang=NUM_LANG[lang], to="ordinal")
    return re.sub(r"o\b", "a", spoken) if feminine else spoken


def unit(number: str, symbol: str, lang: str) -> str:
    names = UNITS[lang].get(symbol)
    if not names:
        return f"{number} {symbol}"
    return f"{number} {names[0] if number == '1' else names[1]}"


def acronym(token: str, text: str) -> str:
    if text.upper() == text or ROMAN.match(token):
        return token
    if token in ACRONYMS_READ_AS_WORDS_PT:
        return token.lower()
    return " ".join(LETTERS_PT[c] for c in token)


def normalize(text: str, lang: str) -> str:
    if lang == "pt":
        text = re.sub(r"\b([Pp])orque\b", r"\1orquê", text)
        text = ACRONYM.sub(lambda m: acronym(m[0], text), text)
    for short, spoken in ABBREVIATIONS[lang].items():
        text = re.sub(rf"(?<!\w){re.escape(short)}(?=\s|$)", spoken, text)
    text = PHONE.sub(lambda m: f"{words(int(m[1]), lang)}, {digit_by_digit(m[2], lang)}, {digit_by_digit(m[3], lang)}", text)
    thousands = "," if lang == "en" else "."
    text = re.sub(rf"(?<=\d){re.escape(thousands)}(?=\d{{3}}\b)", "", text)
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
    if lang != "en":
        text = re.sub(r"\b(\d{1,2})h\b", lambda m: time_of_day(int(m[1]), 0, lang), text)
    if lang in ORDINAL_LANGS:
        text = re.sub(r"\b(\d+)\s?([ºª])(?!C)", lambda m: ordinal(int(m[1]), m[2] == "ª", lang), text)
    text = UNIT_PATTERN.sub(lambda m: unit(m[1], m[2], lang), text)
    decimal = "." if lang == "en" else ","
    text = re.sub(rf"\b(\d+){re.escape(decimal)}(\d+)", lambda m: f"{m[1]} {DECIMAL_WORD[lang]} {m[2]}", text)
    text = re.sub(r"\b(\d+)\s?%", lambda m: f"{m[1]} {PERCENT_WORD[lang]}", text)
    return re.sub(r"\d+", lambda m: words(int(m[0]), lang), text)
