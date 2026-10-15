import json, sys
from pathlib import Path
from faster_whisper import WhisperModel

src, out, shard, shards = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
out.mkdir(parents=True, exist_ok=True)
model = WhisperModel('deepdml/faster-whisper-large-v3-turbo-ct2', device='cuda', compute_type='float32')
for k, mp3 in enumerate(sorted(src.glob('*.mp3'))):
    if k % shards != shard or (out / f'{mp3.stem}.json').exists():
        continue
    segs, _ = model.transcribe(str(mp3), language='pt', word_timestamps=True, vad_filter=False, beam_size=1, condition_on_previous_text=False)
    words = [[round(w.start, 2), round(w.end, 2), w.word] for s in segs for w in (s.words or [])]
    (out / f'{mp3.stem}.json').write_text(json.dumps(words, ensure_ascii=False))
    print(k, mp3.stem, len(words), flush=True)
