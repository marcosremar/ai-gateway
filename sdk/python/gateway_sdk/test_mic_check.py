"""MicCheck / Floor — the same rules as `ai-gateway-audio` (Rust) and `sdk/browser/voice/mic-check.ts`.

Measured on the ucast.me benchmark sets (docs/medicoes.md § piso, 2026-10-26): "silence" is not one thing —
digital zeros, a clean studio pause, air-conditioning, a loud floor, a real meeting room — and a single
threshold cannot tell them apart.
"""
import numpy as np

from gateway_sdk.audio import Floor, MicIssue, MicCheck, MicReport, floor_of

FRAME = 512
PER_S = 16_000 // FRAME  # ~31 frames per second


def _frames(check: MicCheck, seconds: float, db: float, prob, seed: int = 7) -> None:
    """Feed `seconds` of white noise at `db` dBFS; `prob` is a float or a callable(frame index)."""
    rng = np.random.default_rng(seed)
    amp = 10 ** (db / 20)
    for i in range(int(seconds * PER_S)):
        frame = (rng.standard_normal(FRAME) * amp).astype(np.float32)
        check.push(frame, prob(i) if callable(prob) else prob)


def test_names_the_floor_from_the_pauses() -> None:
    assert floor_of(-95, 0.6) is Floor.DIGITAL_SILENCE
    assert floor_of(-120, 0.0) is Floor.DIGITAL_SILENCE
    assert floor_of(-60, 0.17) is Floor.MEETING_FLOOR
    assert floor_of(-58, 0.0) is Floor.STUDIO_QUIET
    assert floor_of(-43, 0.0) is Floor.ROOM_AMBIENT
    assert floor_of(-38, 0.0) is Floor.LOUD_FLOOR


def test_a_quiet_floor_hides_the_noisy_advice_but_keeps_far_away() -> None:
    issues = [MicIssue.FAR_OR_ECHO, MicIssue.NOISY, MicIssue.TOO_QUIET]
    for floor in (Floor.STUDIO_QUIET, Floor.ROOM_AMBIENT, Floor.MEETING_FLOOR, Floor.DIGITAL_SILENCE):
        report = MicReport(-30.0, -36.0, 0.9, 0.0, list(issues), floor)
        kept = report.advice_issues()
        assert MicIssue.NOISY not in kept, floor
        assert MicIssue.FAR_OR_ECHO in kept, floor
    for floor in (Floor.LOUD_FLOOR, None):
        report = MicReport(-30.0, -36.0, 0.9, 0.0, list(issues), floor)
        assert report.advice_issues() == issues, floor


def test_snr_comes_from_the_floor() -> None:
    assert MicReport(-30.0, -42.0, None, 0.0, [], Floor.ROOM_AMBIENT).snr_db() == 12.0
    assert MicReport(-30.0, None, None, 0.0, [], None).snr_db() is None


def test_nothing_is_said_before_eight_seconds_of_sound() -> None:
    check = MicCheck()
    _frames(check, 5.0, -28.0, 0.95)
    assert check.report() is None


def test_a_good_microphone_has_nothing_to_change() -> None:
    # 30 s: 2 s of speech at −28 dBFS with a sure VAD, then 1 s of pause at −65 dBFS.
    check = MicCheck()
    for second in range(30):
        speaking = second % 3 < 2
        _frames(check, 1.0, -28.0 if speaking else -65.0, 0.95 if speaking else 0.05, seed=second)
    report = check.report()
    assert report is not None
    assert report.issues == [], report
    assert report.floor is Floor.STUDIO_QUIET, report.floor
    assert report.snr_db() is not None and report.snr_db() > 30.0


def test_the_room_floor_alone_is_not_a_noisy_room() -> None:
    # HVAC pauses after the VAD's level: ~40 % of frames at a mid/high probability on a −40 dBFS floor.
    check = MicCheck()
    _frames(check, 30.0, -40.0, lambda i: 0.92 if i % 5 < 2 else 0.65 if i % 5 == 2 else 0.05)
    report = check.report()
    if report is not None:
        assert MicIssue.NOISY not in report.advice_issues(), report


def test_a_table_microphone_with_only_room_tone_is_not_a_noisy_room() -> None:
    # AMI's table mic: sure VAD on a −58 dBFS floor, SNR ~6 dB. Quieter than speech is TooQuiet's business.
    check = MicCheck()
    _frames(check, 30.0, -58.0, lambda i: 0.95 if i % 3 == 0 else 0.05)
    report = check.report()
    if report is not None:
        assert MicIssue.NOISY not in report.advice_issues(), report


def test_loud_noise_with_speech_is_still_named() -> None:
    # 5 dB SNR: the voice is only 5 dB above the floor, which is what made the subtitles 18 % worse.
    check = MicCheck()
    for second in range(30):
        speaking = second % 3 < 2
        _frames(check, 1.0, -28.0 if speaking else -33.0, 0.95 if speaking else 0.05, seed=second)
    report = check.report()
    assert report is not None
    assert MicIssue.NOISY in report.advice_issues(), report
    assert report.floor is Floor.LOUD_FLOOR, report.floor


def test_clear_goes_back_to_empty() -> None:
    check = MicCheck()
    _frames(check, 30.0, -28.0, 0.95)
    assert check.report() is not None
    check.clear()
    assert check.report() is None
