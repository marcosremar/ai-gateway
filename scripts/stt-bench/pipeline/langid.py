import json, sys
from pathlib import Path
import numpy as np, soundfile as sf
from faster_whisper import WhisperModel

clips, out = Path(sys.argv[1]), Path(sys.argv[2])
model = WhisperModel('large-v3', device='cuda', compute_type='float32')
WIN = 16000 * 4
with out.open('w') as f:
    for line in (clips / 'manifest.jsonl').read_text().splitlines():
        e = json.loads(line)
        audio, _ = sf.read(clips / e['audio'], dtype='float32')
        whole = dict(model.detect_language(audio)[2][:5])
        windows = []
        for s in range(0, max(1, len(audio) - WIN // 2), WIN):
            seg = audio[s:s + WIN]
            if len(seg) >= 16000:
                lang, prob, _ = model.detect_language(seg)
                windows.append([lang, round(prob, 3)])
        f.write(json.dumps({'id': e['id'], 'whole': {k: round(v, 3) for k, v in whole.items()}, 'windows': windows}) + '\n')
