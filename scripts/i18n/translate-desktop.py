"""Build one desktop locale with an offline CTranslate2 translation model.

--model accepts an unpacked English-to-target Argos package or MADLAD-400.
Install ctranslate2 and sentencepiece locally. Argos BPE packages also need
sacremoses and subword-nmt.

The English catalog supplies reviewed terminology and the complete message list.
Existing catalog entries win. Each batch is saved in SQLite for interrupted runs.
The model, tokenizer and cache live outside the app bundle.
"""
import argparse
from collections import Counter, defaultdict
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import time

REPO = Path(__file__).resolve().parents[2]
SHELL = REPO / 'desktop/src/locales'
CORE = REPO / 'src/components/i18n/locales'
TOKEN = re.compile(r'\{[A-Za-z_]\w*\}')
TERMS = re.compile(r'\{[A-Za-z_]\w*\}|\b(?:Blok|OpenAI|WebCal|iCalendar|macOS|SMTP|HTTPS|MCP|React Grab)\b')
LANGUAGE_TAGS = {'ku': 'ckb', 'zh-TW': 'zh'}


def read(path):
    return json.loads(path.read_text()) if path.is_file() else {}


def valid(source, text):
    return (isinstance(text, str) and bool(text.strip())
            and ('▁' not in text or '▁' in source)
            and Counter(TOKEN.findall(source)) == Counter(TOKEN.findall(text)))


def translate(lang, model_path, cache_path, threads):
    english = read(SHELL / 'en.json')
    if not english:
        raise ValueError('Build the English catalog first.')
    if lang == 'en' or not (CORE / (lang + '.json')).is_file():
        raise ValueError('Choose a supported target locale other than English.')
    path = SHELL / (lang + '.json')
    published = read(path)
    core_en = read(CORE / 'en.json')
    core_target = read(CORE / (lang + '.json'))
    traditional = {}
    if lang == 'zh-TW' and (SHELL / 'zh.json').is_file():
        from opencc import OpenCC
        converter = OpenCC('s2twp')
        traditional = {key: converter.convert(text) for key, text in read(SHELL / 'zh.json').items()}
    candidates = defaultdict(set)
    for key, value in core_en.items():
        if key in core_target:
            candidates[value].add(core_target[key])

    with sqlite3.connect(cache_path, timeout=60) as db:
        db.execute('CREATE TABLE IF NOT EXISTS translations (lang TEXT, source TEXT, value TEXT, PRIMARY KEY(lang,source))')
        cached = dict(db.execute('SELECT source,value FROM translations WHERE lang=?', (lang,)))
        result = {}
        missing = defaultdict(list)
        for key, source in english.items():
            # For French, the authored French key is itself the translation.
            source_value = key if lang == 'fr' and key != source else None
            matches = candidates.get(source, set())
            reused = next(iter(matches)) if len(matches) == 1 else None
            literal = source if not any(c.isalpha() for c in TERMS.sub('', source)) else None
            # Some editor catalogs retain English fallback text for an untranslated entry.
            reused = reused if reused != source else None
            previous = cached.get(key)
            previous = previous if previous != source else None
            options = [literal, published.get(key), source_value, reused, traditional.get(key), previous]
            value = next((v for v in options if valid(source, v)), None)
            if value is None:
                missing[source].append(key)
            else:
                result[key] = value
        if missing:
            fill(lang, model_path, threads, missing, db, result)
        if result.keys() != english.keys() or any(not valid(english[k], v) for k,v in result.items()):
            raise ValueError('Catalog incomplete or interpolation tokens differ.')
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf8', dir=SHELL, suffix='.tmp', delete=False) as out:
            json.dump(dict(sorted(result.items())), out, ensure_ascii=False, indent=2)
            out.write('\n')
        os.chmod(out.name, 0o644)
        os.replace(out.name, path)
        print(f'{lang}: published {len(result)} messages', flush=True)


def model_inputs(lang, path):
    import sentencepiece
    metadata = read(path / 'metadata.json')
    if metadata:
        if (metadata.get('from_code'), metadata.get('to_code')) != ('en', lang):
            raise ValueError(f'Expected an English-to-{lang} package at {path}')
        if (path / 'bpe.model').is_file():
            from sacremoses import MosesDetokenizer, MosesPunctNormalizer, MosesTokenizer
            from subword_nmt.apply_bpe import BPE
            normalize = MosesPunctNormalizer(lang='en').normalize
            tokenize = MosesTokenizer(lang='en').tokenize
            detokenize = MosesDetokenizer(lang=lang).detokenize
            with (path / 'bpe.model').open() as file:
                bpe = BPE(file)
            def encode(text):
                return bpe.segment_tokens(tokenize(normalize(text)))
            def decode(tokens):
                return detokenize(' '.join(tokens).replace('@@ ', '').split())
        else:
            tokenizer = sentencepiece.SentencePieceProcessor(model_file=str(path / 'sentencepiece.model'))
            def encode(text):
                return tokenizer.encode(text, out_type=str)
            def decode(tokens):
                # Some bilingual packages return literal SentencePiece boundaries.
                return tokenizer.decode(tokens).replace('▁', ' ').strip()
        return path / 'model', encode, decode, 2
    tokenizer = sentencepiece.SentencePieceProcessor(model_file=str(path / 'spiece.model'))
    tag = '<2' + LANGUAGE_TAGS.get(lang, lang) + '>'
    if tokenizer.piece_to_id(tag) == tokenizer.unk_id():
        raise ValueError(f'Unsupported model language token {tag}')
    def encode(text):
        return tokenizer.encode(tag + ' ' + text, out_type=str) + ['</s>']
    return path, encode, tokenizer.decode, 1


def fill(lang, model_path, threads, missing, db, result):
    import ctranslate2
    weights, encode, decode, beam_size = model_inputs(lang, model_path)
    model = ctranslate2.Translator(str(weights), device='cpu', compute_type='int8',
                                  inter_threads=1, intra_threads=threads)
    def batch(texts):
        encoded = [encode(s) for s in texts]
        output = model.translate_batch(encoded, beam_size=beam_size, max_batch_size=24,
            max_decoding_length=min(240, max(18, int(max(map(len, encoded))*2.4))), repetition_penalty=1.08)
        return [decode(item.hypotheses[0]) for item in output]
    def repair(source, value):
        if Counter(TERMS.findall(source)) == Counter(TERMS.findall(value)) and value.strip():
            return value
        # Keep placeholders and product names literal if the model rewrote one.
        parts = re.split('(' + TERMS.pattern + ')', source)
        for i, part in enumerate(parts):
            if i % 2 or not any(c.isalpha() for c in part):
                continue
            translated = batch([part.strip()])[0]
            if not translated: raise ValueError(f'Empty translation in {lang}: {source!r}')
            parts[i] = part[:len(part)-len(part.lstrip())] + translated + part[len(part.rstrip()):]
        return ''.join(parts)
    convert = None
    if lang == 'zh-TW':
        from opencc import OpenCC
        convert = OpenCC('s2twp').convert
    sources = sorted(missing, key=lambda text: len(encode(text)))
    started = time.monotonic()
    for i in range(0, len(sources), 24):
        chunk = sources[i:i+24]
        for source, draft in zip(chunk, batch(chunk)):
            value = repair(source, draft)
            if convert: value = convert(value)
            for key in missing[source]:
                if not valid(key, value): raise ValueError(f'Invalid placeholders: {key!r}')
                result[key] = value
                db.execute('INSERT OR REPLACE INTO translations VALUES (?,?,?)', (lang, key, value))
        db.commit()
    print(f'{lang}: {len(sources)} unique messages generated in {time.monotonic()-started:.1f}s', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('language')
    parser.add_argument('--model', required=True, type=Path)
    parser.add_argument('--cache', required=True, type=Path)
    parser.add_argument('--threads', type=int, default=4, choices=range(1, 7))
    args = parser.parse_args()
    from desktop_coverage import refresh
    translate(args.language, args.model, args.cache, args.threads)
    refresh()
